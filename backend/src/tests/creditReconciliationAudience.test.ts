import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { PortalNotification } from "../models/portalNotification.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { notifyCreditReconciliationAdmins } from "../services/portalNotification.service.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

type NotificationOperation = {
  updateOne: { update: { $setOnInsert: { recipientUserId: mongoose.Types.ObjectId } } };
};

const input = {
  type: "CREDIT_RECONCILIATION_ALERT" as const,
  title: "Credit reconciliation drift detected",
  message: "Review the reconciliation log.",
  href: "/dashboard/credit-accounts",
  idempotencyKey: "CREDIT_RECONCILIATION:test-run"
};

describe("credit reconciliation notification audience", () => {
  test("operator drift is sent only to that tenant's active admin and finance memberships", async (context) => {
    const tenantId = new mongoose.Types.ObjectId();
    const operatorAdminId = new mongoose.Types.ObjectId();
    const financeId = new mongoose.Types.ObjectId();
    let membershipFilter: Record<string, unknown> | undefined;
    let recipients: mongoose.Types.ObjectId[] = [];

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
        .map((operation) => operation.updateOne.update.$setOnInsert.recipientUserId);
      return {} as never;
    });
    context.mock.method(User, "find", () => {
      const query = { select: () => query, session: () => query, lean: () => query, exec: async () => [] };
      return query as never;
    });

    await runWithTenantContext({ tenantId, kind: "OPERATOR" }, () => notifyCreditReconciliationAdmins(input));

    assert.deepEqual(membershipFilter, {
      tenantId,
      status: "ACTIVE",
      role: { $in: ["OPERATOR_ADMIN", "FINANCE"] }
    });
    assert.deepEqual(recipients, [operatorAdminId, financeId]);
  });

  test("Swiftline keeps its existing global admin notification audience", async (context) => {
    const tenantId = new mongoose.Types.ObjectId();
    const adminId = new mongoose.Types.ObjectId();
    let userFindCount = 0;
    let firstUserFilter: Record<string, unknown> | undefined;
    let recipients: mongoose.Types.ObjectId[] = [];

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
      recipients = (operations as unknown as NotificationOperation[])
        .map((operation) => operation.updateOne.update.$setOnInsert.recipientUserId);
      return {} as never;
    });
    context.mock.method(TenantMembership, "find", () => {
      throw new Error("Swiftline alerts must keep using the existing admin audience.");
    });

    await runWithTenantContext({ tenantId, kind: "SWIFTLINE" }, () => notifyCreditReconciliationAdmins(input));

    assert.deepEqual(firstUserFilter, { role: "admin", userStatus: "active" });
    assert.deepEqual(recipients, [adminId]);
  });
});
