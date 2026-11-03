import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { PortalNotification } from "../models/portalNotification.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { notifyCreditFacilityReviewers } from "../services/portalNotification.service.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

type NotificationOperation = {
  updateOne: { update: { $setOnInsert: { recipientUserId: mongoose.Types.ObjectId; href: string } } };
};

const input = {
  type: "CREDIT_REQUEST_SUBMITTED" as const,
  title: "Credit facility requested",
  message: "Review this credit request.",
  href: "/dashboard/credit-accounts",
  idempotencyKey: "CREDIT_REQUEST_SUBMITTED:test-run"
};

describe("credit facility notification audience", () => {
  test("operator credit requests go only to that tenant's active admin and finance memberships", async (context) => {
    const tenantId = new mongoose.Types.ObjectId();
    const operatorAdminId = new mongoose.Types.ObjectId();
    const financeId = new mongoose.Types.ObjectId();
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
      const query = {
        select: () => query,
        session: () => query,
        lean: () => query,
        exec: async () => [{ userId: operatorAdminId }, { userId: financeId }]
      };
      return query as never;
    });
    context.mock.method(PortalNotification, "bulkWrite", async (operations: unknown[]) => {
      recipients = (operations as unknown as NotificationOperation[])
        .map((operation) => ({
          id: operation.updateOne.update.$setOnInsert.recipientUserId,
          href: operation.updateOne.update.$setOnInsert.href
        }));
      return {} as never;
    });
    context.mock.method(User, "find", () => {
      const query = { select: () => query, session: () => query, lean: () => query, exec: async () => [] };
      return query as never;
    });

    await runWithTenantContext({ tenantId, kind: "OPERATOR" }, () => notifyCreditFacilityReviewers(input));

    assert.deepEqual(membershipFilter, {
      tenantId,
      role: { $in: ["OPERATOR_ADMIN", "FINANCE"] },
      status: "ACTIVE"
    });
    assert.deepEqual(recipients, [
      { id: operatorAdminId, href: "/portal/north-star/credit" },
      { id: financeId, href: "/portal/north-star/credit" }
    ]);
  });

  test("Swiftline keeps its existing global administrator audience and link", async (context) => {
    const tenantId = new mongoose.Types.ObjectId();
    const adminId = new mongoose.Types.ObjectId();
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
    context.mock.method(TenantMembership, "find", () => {
      throw new Error("Swiftline credit alerts must keep using the existing admin audience.");
    });
    context.mock.method(Tenant, "findById", () => {
      throw new Error("Swiftline credit alerts must not resolve an operator slug.");
    });

    await runWithTenantContext({ tenantId, kind: "SWIFTLINE" }, () => notifyCreditFacilityReviewers(input));

    assert.deepEqual(firstUserFilter, { role: "admin", userStatus: "active" });
    assert.deepEqual(recipient, { id: adminId, href: input.href });
  });
});
