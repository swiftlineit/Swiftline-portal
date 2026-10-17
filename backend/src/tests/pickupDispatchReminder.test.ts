import assert from "node:assert/strict";
import { mock, test } from "node:test";
import mongoose from "mongoose";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { User } from "../models/user.model.js";
import { runPickupDispatchReminderSweep } from "../services/pickup.service.js";

const now = new Date("2026-10-17T08:03:00.000Z");

function reminderFixture(dispatchAt: Date) {
  const pickup = {
    _id: new mongoose.Types.ObjectId(),
    requestNumber: "SLPTESTREMINDER001",
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    dispatchAt,
    dispatchReminderSentAt: null as Date | null,
    status: "CONFIRMED",
    version: 1
  };
  const staff = { _id: new mongoose.Types.ObjectId(), email: "staff@example.test", name: "Staff" };
  const notifications: Array<{ idempotencyKey: string; title: string; message: string }> = [];
  const emails: Array<{ idempotencyKey: string; subject: string; payload: Record<string, unknown> }> = [];
  let afterCandidateRead: (() => void) | undefined;

  mock.method(PickupRequest, "find", (filter: { dispatchAt: { $lte: Date }; dispatchReminderSentAt: null; status: { $in: string[] } }) => {
    let limit = 500;
    const query = {
      select: () => query,
      sort: () => query,
      limit: (value: number) => { limit = value; return query; },
      lean: () => query,
      exec: async () => {
        const candidates = pickup.dispatchReminderSentAt === null &&
          pickup.dispatchAt <= filter.dispatchAt.$lte &&
          filter.status.$in.includes(pickup.status)
            ? [{ ...pickup }].slice(0, limit)
            : [];
        afterCandidateRead?.();
        afterCandidateRead = undefined;
        return candidates;
      }
    };
    return query as never;
  });
  mock.method(PickupRequest, "findOneAndUpdate", (filter: { _id: mongoose.Types.ObjectId; dispatchAt: Date; dispatchReminderSentAt: null; status: { $in: string[] } }, update: { $set: { dispatchReminderSentAt: Date } }) => {
    const claimed = String(filter._id) === String(pickup._id) &&
      pickup.dispatchReminderSentAt === null &&
      pickup.dispatchAt.getTime() === filter.dispatchAt.getTime() &&
      filter.status.$in.includes(pickup.status);
    if (claimed) pickup.dispatchReminderSentAt = update.$set.dispatchReminderSentAt;
    return { lean: () => ({ exec: async () => claimed ? { ...pickup } : null }) } as never;
  });
  mock.method(mongoose, "startSession", async () => ({
    withTransaction: async (work: () => Promise<unknown>) => work(),
    endSession: async () => {}
  }) as never);
  mock.method(User, "find", () => {
    const query = { select: () => query, session: () => query, lean: () => query, exec: async () => [staff] };
    return query as never;
  });
  mock.method(PortalNotification, "bulkWrite", async (operations: Array<{ updateOne: { update: { $setOnInsert: typeof notifications[number] } } }>) => {
    notifications.push(...operations.map((operation) => operation.updateOne.update.$setOnInsert));
    return {} as never;
  });
  mock.method(EmailOutbox, "bulkWrite", async (operations: Array<{ updateOne: { update: { $setOnInsert: typeof emails[number] } } }>) => {
    emails.push(...operations.map((operation) => operation.updateOne.update.$setOnInsert));
    return {} as never;
  });

  return { pickup, notifications, emails, afterCandidateRead: (work: () => void) => { afterCandidateRead = work; } };
}

test("reminds pickups in the next ten minutes, including the boundary, and sends upcoming wording to email", async () => {
  try {
    const fixture = reminderFixture(new Date(now.getTime() + 10 * 60_000));
    const result = await runPickupDispatchReminderSweep(now);
    assert.deepEqual({ due: result.due, sent: result.sent }, { due: 1, sent: 1 });
    assert.equal(fixture.pickup.dispatchReminderSentAt?.getTime(), now.getTime());
    assert.equal(fixture.notifications[0]?.title, "Pickup dispatch coming up");
    assert.match(fixture.notifications[0]?.message ?? "", /within the next 10 minutes/);
    assert.equal(fixture.emails[0]?.subject, fixture.notifications[0]?.title);
    assert.equal(fixture.emails[0]?.payload.message, fixture.notifications[0]?.message);
  } finally { mock.restoreAll(); }
});

test("does not remind a pickup outside the lookahead or duplicate a claimed reminder", async () => {
  try {
    const fixture = reminderFixture(new Date(now.getTime() + 10 * 60_000 + 1));
    assert.equal((await runPickupDispatchReminderSweep(now)).sent, 0);
    fixture.pickup.dispatchAt = new Date(now.getTime() + 5 * 60_000);
    assert.equal((await runPickupDispatchReminderSweep(now)).sent, 1);
    assert.equal((await runPickupDispatchReminderSweep(new Date(now.getTime() + 5 * 60_000))).sent, 0);
    assert.equal(fixture.notifications.length, 1);
    assert.equal(fixture.emails.length, 1);
  } finally { mock.restoreAll(); }
});

test("a rescheduled pickup gets a fresh reminder key for its new schedule", async () => {
  try {
    const fixture = reminderFixture(new Date(now.getTime() + 8 * 60_000));
    assert.equal((await runPickupDispatchReminderSweep(now)).sent, 1);
    fixture.pickup.dispatchAt = new Date(now.getTime() + 35 * 60_000);
    fixture.pickup.dispatchReminderSentAt = null;
    fixture.pickup.version += 1;
    assert.equal((await runPickupDispatchReminderSweep(new Date(now.getTime() + 5 * 60_000))).sent, 0);
    assert.equal((await runPickupDispatchReminderSweep(new Date(now.getTime() + 27 * 60_000))).sent, 1);
    assert.equal(fixture.notifications.length, 2);
    assert.notEqual(fixture.notifications[0]?.idempotencyKey, fixture.notifications[1]?.idempotencyKey);
    assert.notEqual(fixture.emails[0]?.idempotencyKey, fixture.emails[1]?.idempotencyKey);
  } finally { mock.restoreAll(); }
});

test("does not claim a stale candidate when dispatch is rescheduled during a sweep", async () => {
  try {
    const fixture = reminderFixture(new Date(now.getTime() + 8 * 60_000));
    fixture.afterCandidateRead(() => {
      fixture.pickup.dispatchAt = new Date(now.getTime() + 35 * 60_000);
      fixture.pickup.version += 1;
    });
    assert.equal((await runPickupDispatchReminderSweep(now)).sent, 0);
    assert.equal(fixture.pickup.dispatchReminderSentAt, null);
    assert.equal(fixture.notifications.length, 0);
    assert.equal((await runPickupDispatchReminderSweep(new Date(now.getTime() + 27 * 60_000))).sent, 1);
  } finally { mock.restoreAll(); }
});

test("a missed cron run catches up without calling a passed dispatch upcoming", async () => {
  try {
    const fixture = reminderFixture(new Date(now.getTime() - 2 * 60_000));
    assert.equal((await runPickupDispatchReminderSweep(now)).sent, 1);
    assert.equal(fixture.notifications[0]?.title, "Pickup dispatch follow-up");
    assert.match(fixture.emails[0]?.payload.message as string, /scheduled dispatch time has passed/);
  } finally { mock.restoreAll(); }
});
