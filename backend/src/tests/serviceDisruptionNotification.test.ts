import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { User } from "../models/user.model.js";
import { dispatchServiceDisruptionNotification } from "../services/serviceDisruptionNotification.service.js";

type PortalNotificationOperation = {
  updateOne: {
    update: {
      $setOnInsert: {
        recipientUserId: mongoose.Types.ObjectId;
        title: string;
        href: string;
        idempotencyKey: string;
      };
    };
  };
};

type EmailOutboxOperation = {
  updateOne: {
    update: {
      $setOnInsert: {
        toEmail: string;
        subject: string;
        category: string;
        payload: Record<string, unknown>;
        idempotencyKey: string;
      };
    };
  };
};

describe("service disruption notification", () => {
  test("publishes each active advisory version to active clients, account owners and operations users by email", async (context) => {
    const clientId = new mongoose.Types.ObjectId();
    const accountOwnerId = new mongoose.Types.ObjectId();
    const adminId = new mongoose.Types.ObjectId();
    const operationsId = new mongoose.Types.ObjectId();
    const financeId = new mongoose.Types.ObjectId();
    const suspendedClientId = new mongoose.Types.ObjectId();
    const candidates = [
      { _id: clientId, role: "client", userStatus: "active", email: "client@example.test", name: "Client Staff" },
      { _id: accountOwnerId, role: "client", userStatus: "active", email: "owner@example.test", name: "Account Owner" },
      { _id: adminId, role: "admin", userStatus: "active", email: "admin@example.test", name: "Swiftline Admin" },
      { _id: operationsId, role: "operations", userStatus: "active", email: "ops@example.test", name: "Operations User" },
      { _id: financeId, role: "finance", userStatus: "active", email: "finance@example.test", name: "Finance User" },
      { _id: suspendedClientId, role: "client", userStatus: "suspended", email: "suspended@example.test", name: "Suspended Client" }
    ];

    let audienceFilter: Record<string, unknown> | undefined;
    const notificationOperations: PortalNotificationOperation[] = [];
    const emailOperations: EmailOutboxOperation[] = [];

    context.mock.method(User, "find", (filter: unknown) => {
      const queryFilter = filter as Record<string, unknown>;
      let results = candidates;

      if (queryFilter.role) {
        audienceFilter = queryFilter;
        const roles = (queryFilter.role as { $in: string[] }).$in;
        results = candidates.filter((candidate) =>
          roles.includes(candidate.role) && candidate.userStatus === "active"
        );
      } else {
        const userIds = (queryFilter._id as { $in: mongoose.Types.ObjectId[] }).$in;
        results = candidates.filter((candidate) => userIds.some((id) => String(id) === String(candidate._id)));
      }

      const query = {
        select: () => query,
        session: () => query,
        lean: () => query,
        exec: async () => results
      };
      return query as never;
    });
    context.mock.method(PortalNotification, "bulkWrite", async (operations: unknown[]) => {
      notificationOperations.push(...operations as PortalNotificationOperation[]);
      return {} as never;
    });
    context.mock.method(EmailOutbox, "bulkWrite", async (operations: unknown[]) => {
      emailOperations.push(...operations as EmailOutboxOperation[]);
      return {} as never;
    });

    const disruptionId = new mongoose.Types.ObjectId();
    const createdAt = new Date("2026-11-12T10:00:00.000Z");
    const updatedAt = new Date("2026-11-12T10:15:00.000Z");
    const disruption = {
      _id: disruptionId,
      type: "INFORMATION" as const,
      title: "Airport advisory",
      message: "Operations will resume at 14:00 UTC.",
      active: true,
      updatedAt: createdAt
    };

    await dispatchServiceDisruptionNotification(disruption, "PUBLISHED");
    await dispatchServiceDisruptionNotification({
      ...disruption,
      title: "Airport advisory updated",
      message: "Operations will resume at 15:00 UTC.",
      updatedAt
    }, "UPDATED");

    assert.deepEqual(audienceFilter, {
      role: { $in: ["client", "admin", "operations"] },
      userStatus: "active"
    });
    assert.equal(notificationOperations.length, 8);
    assert.equal(emailOperations.length, 8);

    const expectedRecipientIds = [clientId, accountOwnerId, adminId, operationsId].map(String).sort();
    const notifiedIds = notificationOperations
      .map((operation) => String(operation.updateOne.update.$setOnInsert.recipientUserId));
    assert.deepEqual([...new Set(notifiedIds)].sort(), expectedRecipientIds);

    const notificationByUser = new Map(notificationOperations.map((operation) => {
      const notification = operation.updateOne.update.$setOnInsert;
      return [String(notification.recipientUserId), notification];
    }));
    assert.equal(notificationByUser.get(String(clientId))?.href, "/client/operations-calendar");
    assert.equal(notificationByUser.get(String(accountOwnerId))?.href, "/client/operations-calendar");
    assert.equal(notificationByUser.get(String(adminId))?.href, "/dashboard/operations-advisory?tab=disruptions");
    assert.equal(notificationByUser.get(String(operationsId))?.href, "/dashboard/operations-advisory?tab=disruptions");
    assert.equal(new Set(notificationOperations.map((operation) =>
      operation.updateOne.update.$setOnInsert.idempotencyKey
    )).size, 8, "each recipient and advisory version has its own deduplication key");

    const emails = emailOperations.map((operation) => operation.updateOne.update.$setOnInsert);
    assert.deepEqual([...new Set(emails.map((email) => email.toEmail))].sort(), [
      "admin@example.test",
      "client@example.test",
      "ops@example.test",
      "owner@example.test"
    ]);
    const emailByAddress = new Map(emails.map((email) => [email.toEmail, email]));
    assert.equal(emailByAddress.get("client@example.test")?.payload.href, "/client/operations-calendar");
    assert.equal(emailByAddress.get("owner@example.test")?.payload.href, "/client/operations-calendar");
    assert.equal(emailByAddress.get("admin@example.test")?.payload.href, "/dashboard/operations-advisory?tab=disruptions");
    assert.equal(emailByAddress.get("ops@example.test")?.payload.href, "/dashboard/operations-advisory?tab=disruptions");
    assert.ok(emails.every((email) => email.category === "OPERATIONAL"));
    assert.equal(emails.filter((email) => email.subject.startsWith("New service advisory:")).length, 4);
    assert.equal(emails.filter((email) => email.subject.startsWith("Updated service advisory:")).length, 4);
    assert.ok(emails.every((email) => email.payload.message === "Operations will resume at 14:00 UTC." ||
      email.payload.message === "Operations will resume at 15:00 UTC."));
    assert.equal(new Set(emails.map((email) => email.idempotencyKey)).size, 8);
  });

  test("does not notify for an inactive advisory", async (context) => {
    context.mock.method(User, "find", () => {
      throw new Error("inactive advisories must not query notification recipients");
    });

    await dispatchServiceDisruptionNotification({
      _id: new mongoose.Types.ObjectId(),
      type: "INFORMATION",
      title: "Draft advisory",
      message: "Not published.",
      active: false,
      updatedAt: new Date()
    }, "UPDATED");
  });
});
