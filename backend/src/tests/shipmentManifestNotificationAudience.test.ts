import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import type { IShipmentManifest } from "../models/shipmentManifest.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { notifyAdminsOfClientManifest } from "../services/shipmentManifestNotification.service.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

type NotificationOperation = {
  updateOne: { update: { $setOnInsert: { recipientUserId: mongoose.Types.ObjectId; href: string } } };
};

function manifest(): IShipmentManifest {
  return {
    _id: new mongoose.Types.ObjectId(),
    manifestNumber: "NORTH-0001",
    lineSnapshots: [{}, {}],
    businessAccountId: new mongoose.Types.ObjectId(),
    totalPieces: 2,
    totalWeightKg: 1.5,
    generatedAt: new Date("2026-10-23T08:00:00.000Z")
  } as unknown as IShipmentManifest;
}

describe("shipment manifest notification audience", () => {
  test("operator client manifests notify only active staff in that operator tenant", async (context) => {
    const tenantId = new mongoose.Types.ObjectId();
    const adminId = new mongoose.Types.ObjectId();
    const operationsId = new mongoose.Types.ObjectId();
    const manifestRecord = manifest();
    let membershipFilter: Record<string, unknown> | undefined;
    let recipients: Array<{ id: mongoose.Types.ObjectId; href: string }> = [];

    context.mock.method(Tenant, "findById", () => {
      const query = { select: () => query, lean: () => query, exec: async () => ({ slug: "north-star" }) };
      return query as never;
    });
    context.mock.method(Tenant, "exists", () => ({
      session: async () => ({ _id: tenantId })
    }) as never);
    context.mock.method(TenantMembership, "find", (filter: unknown) => {
      membershipFilter = filter as Record<string, unknown>;
      const query = { select: () => query, lean: () => query, exec: async () => [{ userId: adminId }, { userId: operationsId }] };
      return query as never;
    });
    context.mock.method(PortalNotification, "bulkWrite", async (operations: unknown[]) => {
      recipients = (operations as unknown as NotificationOperation[]).map((operation) => ({
        id: operation.updateOne.update.$setOnInsert.recipientUserId,
        href: operation.updateOne.update.$setOnInsert.href
      }));
      return {} as never;
    });
    context.mock.method(EmailOutbox, "bulkWrite", async () => ({} as never));
    context.mock.method(User, "find", () => {
      const query = { select: () => query, session: () => query, lean: () => query, exec: async () => [] };
      return query as never;
    });

    await runWithTenantContext({ tenantId, kind: "OPERATOR" }, () => notifyAdminsOfClientManifest({
      manifest: manifestRecord,
      businessAccountName: "Northstar Parts",
      generatedBy: "Asha Mehta"
    }));

    assert.deepEqual(membershipFilter, {
      tenantId,
      role: { $in: ["OPERATOR_ADMIN", "OPERATIONS"] },
      status: "ACTIVE"
    });
    assert.deepEqual(recipients, [
      { id: adminId, href: "/portal/north-star/manifests#manifest-" + String(manifestRecord._id) },
      { id: operationsId, href: "/portal/north-star/manifests#manifest-" + String(manifestRecord._id) }
    ]);
  });

  test("Swiftline keeps its existing administrator audience and link", async (context) => {
    const tenantId = new mongoose.Types.ObjectId();
    const adminId = new mongoose.Types.ObjectId();
    const manifestRecord = manifest();
    let userFindCount = 0;
    let firstUserFilter: Record<string, unknown> | undefined;
    let recipient: { id: mongoose.Types.ObjectId; href: string } | undefined;

    context.mock.method(User, "find", (filter: unknown) => {
      userFindCount += 1;
      if (userFindCount === 1) firstUserFilter = filter as Record<string, unknown>;
      const query = {
        select: () => query,
        session: () => query,
        lean: () => query,
        exec: async () => userFindCount === 1 ? [{ _id: adminId }] : []
      };
      return query as never;
    });
    context.mock.method(PortalNotification, "bulkWrite", async (operations: unknown[]) => {
      const operation = (operations as unknown as NotificationOperation[])[0];
      assert.ok(operation);
      recipient = {
        id: operation.updateOne.update.$setOnInsert.recipientUserId,
        href: operation.updateOne.update.$setOnInsert.href
      };
      return {} as never;
    });
    context.mock.method(EmailOutbox, "bulkWrite", async () => ({} as never));
    context.mock.method(TenantMembership, "find", () => {
      throw new Error("Swiftline manifest notices must keep the existing administrator audience.");
    });
    context.mock.method(Tenant, "findById", () => {
      throw new Error("Swiftline manifest notices must not resolve an operator slug.");
    });

    await runWithTenantContext({ tenantId, kind: "SWIFTLINE" }, () => notifyAdminsOfClientManifest({
      manifest: manifestRecord,
      businessAccountName: "Swiftline Client",
      generatedBy: "Client User"
    }));

    assert.deepEqual(firstUserFilter, { role: "admin", userStatus: "active" });
    assert.deepEqual(recipient, {
      id: adminId,
      href: "/dashboard/shipment-manifests#manifest-" + String(manifestRecord._id)
    });
  });
});
