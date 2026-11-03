import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { OperatorInvitation } from "../models/operatorInvitation.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import {
  acceptExistingOperatorAdminInvitation,
  activateNewOperatorAdmin,
  hashOperatorInvitationToken,
  inviteInitialOperatorAdmin,
  lookupOperatorInvitation,
  OperatorInvitationError,
  reissueInitialOperatorAdminLink
} from "../services/operatorInvitation.service.js";

const databaseName = `sl_operator_invitations_${Date.now()}`;
const actorId = new mongoose.Types.ObjectId();

function tokenFrom(url: string) {
  return new URL(url).searchParams.get("token") ?? "";
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: databaseName,
    family: 4,
    retryWrites: false,
    autoIndex: false,
    autoCreate: false
  });
  assert.equal(mongoose.connection.name, databaseName);
  await Promise.all([
    Tenant.createCollection(),
    TenantMembership.createCollection(),
    User.createCollection(),
    OperatorInvitation.createCollection(),
    AuditLog.createCollection()
  ]);
  await Promise.all([
    Tenant.createIndexes(),
    TenantMembership.createIndexes(),
    User.createIndexes(),
    OperatorInvitation.createIndexes(),
    AuditLog.createIndexes()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_operator_invitations_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("operator administrator invite lifecycle", () => {
  test("new identity activates only its operator membership with a one-use link", async () => {
    const [tenant] = await Tenant.create([{
      kind: "OPERATOR", status: "DRAFT", companyName: "Northstar Logistics", slug: `northstar-${Date.now()}`
    }]);
    assert.ok(tenant);

    const issued = await inviteInitialOperatorAdmin({
      tenantId: tenant._id,
      actorId,
      firstName: "Asha",
      lastName: "Rao",
      email: "asha@northstar.example"
    });
    assert.equal(issued.requiresSignIn, false);
    const token = tokenFrom(issued.activationUrl);
    const invitation = await lookupOperatorInvitation(token);
    assert.equal(invitation.matched, true);
    if (!invitation.matched || !invitation.invitation) throw new Error("Expected a usable operator invitation.");
    assert.equal(invitation.invitation.email, "asha@northstar.example");
    assert.equal(invitation.invitation.requiresSignIn, false);

    await activateNewOperatorAdmin({ token, passwordHash: "hashed-password-from-auth" });
    const [user, membership, accepted, audit] = await Promise.all([
      User.findOne({ email: "asha@northstar.example" }).lean().exec(),
      TenantMembership.findOne({ tenantId: tenant._id, userId: issued.userId }).lean().exec(),
      OperatorInvitation.findOne({ tenantId: tenant._id, userId: issued.userId, status: "ACCEPTED" }).lean().exec(),
      AuditLog.findOne({ tenantId: tenant._id, action: "OPERATOR_MEMBERSHIP_ACTIVATED" }).lean().exec()
    ]);
    assert.equal(user?.role, "client");
    assert.equal(user?.userStatus, "active");
    assert.equal(user?.passwordHash, "hashed-password-from-auth");
    assert.equal(membership?.role, "OPERATOR_ADMIN");
    assert.equal(membership?.status, "ACTIVE");
    assert.equal(accepted?.acceptedAt instanceof Date, true);
    assert.equal(audit?.entityType, "TENANT_MEMBERSHIP");
  });

  test("existing client accepts without having its password or Swiftline membership changed", async () => {
    const [tenant, user] = await Promise.all([
      Tenant.create({ kind: "OPERATOR", status: "DRAFT", companyName: "Meridian Freight", slug: `meridian-${Date.now()}` }),
      User.create({ email: "client@example.com", role: "client", userStatus: "active", passwordHash: "existing-password-hash" })
    ]);
    const issued = await inviteInitialOperatorAdmin({
      tenantId: tenant._id,
      actorId,
      firstName: "Ignored",
      lastName: "Name",
      email: user.email
    });
    assert.equal(issued.requiresSignIn, true);
    const token = tokenFrom(issued.activationUrl);
    await assert.rejects(
      activateNewOperatorAdmin({ token, passwordHash: "must-not-overwrite" }),
      (error: unknown) => error instanceof OperatorInvitationError && error.code === "LOGIN_REQUIRED"
    );
    await acceptExistingOperatorAdminInvitation({ token, userId: user._id });

    const [updatedUser, membership] = await Promise.all([
      User.findById(user._id).lean().exec(),
      TenantMembership.findOne({ tenantId: tenant._id, userId: user._id }).lean().exec()
    ]);
    assert.equal(updatedUser?.passwordHash, "existing-password-hash");
    assert.equal(updatedUser?.role, "client");
    assert.equal(membership?.status, "ACTIVE");
  });

  test("rejects Swiftline staff and confines acceptance to the invited identity", async () => {
    const [tenant, staff, client] = await Promise.all([
      Tenant.create({ kind: "OPERATOR", status: "DRAFT", companyName: "Harbor Cargo", slug: `harbor-${Date.now()}` }),
      User.create({ email: "staff@example.com", role: "operations", userStatus: "active", passwordHash: "staff-password" }),
      User.create({ email: "client-two@example.com", role: "client", userStatus: "active", passwordHash: "client-password" })
    ]);
    await assert.rejects(
      inviteInitialOperatorAdmin({ tenantId: tenant._id, actorId, firstName: "Swift", lastName: "Staff", email: staff.email }),
      (error: unknown) => error instanceof OperatorInvitationError && error.statusCode === 409
    );
    const issued = await inviteInitialOperatorAdmin({
      tenantId: tenant._id,
      actorId,
      firstName: "Client",
      lastName: "Two",
      email: client.email
    });
    const token = tokenFrom(issued.activationUrl);
    await assert.rejects(
      acceptExistingOperatorAdminInvitation({ token, userId: staff._id }),
      (error: unknown) => error instanceof OperatorInvitationError && error.statusCode === 404
    );
  });

  test("replacement links revoke the prior token and retain only its digest", async () => {
    const [tenant] = await Tenant.create([{
      kind: "OPERATOR", status: "DRAFT", companyName: "Atlas Cargo", slug: `atlas-${Date.now()}`
    }]);
    if (!tenant) throw new Error("Operator test tenant was not created.");
    const first = await inviteInitialOperatorAdmin({
      tenantId: tenant._id,
      actorId,
      firstName: "Nia",
      lastName: "Patel",
      email: "nia@atlas.example"
    });
    const firstToken = tokenFrom(first.activationUrl);
    const replacement = await reissueInitialOperatorAdminLink({
      tenantId: tenant._id,
      userId: first.userId,
      actorId
    });
    const oldLookup = await lookupOperatorInvitation(firstToken);
    assert.equal(oldLookup.matched, true);
    if (oldLookup.matched) assert.equal(oldLookup.invitation, null);
    const newLookup = await lookupOperatorInvitation(tokenFrom(replacement.activationUrl));
    assert.equal(newLookup.matched, true);
    if (!newLookup.matched) throw new Error("Expected replacement invitation lookup.");
    assert.notEqual(tokenFrom(first.activationUrl), tokenFrom(replacement.activationUrl));
    const stored = await OperatorInvitation.findOne({ tenantId: tenant._id, userId: first.userId, status: "PENDING" }).select("+tokenHash").lean().exec();
    assert.equal(stored?.tokenHash, hashOperatorInvitationToken(tokenFrom(replacement.activationUrl)));
  });
});
