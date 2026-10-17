import assert from "node:assert/strict";
import { mock, test } from "node:test";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { PickupAttempt } from "../models/pickupAttempt.model.js";
import { PickupProof } from "../models/pickupEvidence.model.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { PickupRequestShipment } from "../models/pickupRequestShipment.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { User } from "../models/user.model.js";
import { pendingPickupReminderEmailFilter, reschedulePickup, runPickupDispatchReminderSweep } from "../services/pickup.service.js";

const now = new Date("2026-10-17T08:03:00.000Z");

function reminderFixture(dispatchAt: Date, otherDispatches: Date[] = []) {
  const staff = { _id: new mongoose.Types.ObjectId(), email: "staff@example.test", name: "Staff" };
  const pickups = [dispatchAt, ...otherDispatches].map((time, index) => ({
    _id: new mongoose.Types.ObjectId(),
    requestNumber: `SLPTESTREMINDER${String(index + 1).padStart(3, "0")}`,
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    requestedBy: staff._id,
    requestedWindow: { startAt: time, endAt: new Date(time.getTime() + 2 * 60 * 60_000), timezone: "Asia/Kolkata" },
    documents: [],
    pickupAddress: {},
    dispatchAt: time,
    dispatchReminderSentAt: null as Date | null,
    status: "CONFIRMED",
    version: 1,
    currentAttemptId: null,
    save: async () => {}
  }));
  const pickup = pickups[0]!;
  const notifications: Array<{ idempotencyKey: string; type: string; title: string; message: string }> = [];
  const emails: Array<{ idempotencyKey: string; notificationType: string; subject: string; payload: Record<string, unknown>; status: string }> = [];
  let afterCandidateRead: (() => void) | undefined;

  mock.method(PickupRequest, "find", (filter: { dispatchAt: { $lte: Date }; dispatchReminderSentAt: null; status: { $in: string[] } }) => {
    let limit = 500;
    let direction: number | null = null;
    const query = {
      select: () => query,
      sort: (sort: { dispatchAt: number }) => { direction = sort.dispatchAt; return query; },
      limit: (value: number) => { limit = value; return query; },
      lean: () => query,
      exec: async () => {
        const eligible = pickups.filter((item) =>
          item.dispatchReminderSentAt === null &&
          item.dispatchAt <= filter.dispatchAt.$lte &&
          filter.status.$in.includes(item.status)
        );
        const sortDirection = direction;
        const candidates = (sortDirection === null
          ? eligible
          : eligible.sort((a, b) => sortDirection * (a.dispatchAt.getTime() - b.dispatchAt.getTime())))
          .slice(0, limit).map((item) => ({ ...item }));
        afterCandidateRead?.();
        afterCandidateRead = undefined;
        return candidates;
      }
    };
    return query as never;
  });
  mock.method(PickupRequest, "findOneAndUpdate", (filter: { _id: mongoose.Types.ObjectId; dispatchAt: Date; dispatchReminderSentAt: null; status: { $in: string[] } }, update: { $set: { dispatchReminderSentAt: Date } }) => {
    const item = pickups.find((candidate) => String(candidate._id) === String(filter._id));
    const claimed = item && item.dispatchReminderSentAt === null &&
      item.dispatchAt.getTime() === filter.dispatchAt.getTime() &&
      filter.status.$in.includes(item.status);
    if (claimed) item.dispatchReminderSentAt = update.$set.dispatchReminderSentAt;
    return { lean: () => ({ exec: async () => claimed ? { ...item } : null }) } as never;
  });
  mock.method(PickupRequest, "findById", (id: mongoose.Types.ObjectId) => {
    const query = {
      populate: () => query,
      lean: () => query,
      exec: async () => pickups.find((item) => String(item._id) === String(id)) ?? null
    };
    return query as never;
  });
  mock.method(mongoose, "startSession", async () => ({
    withTransaction: async (work: () => Promise<unknown>) => work(),
    endSession: async () => {}
  }) as never);
  mock.method(User, "find", () => {
    const query = { select: () => query, session: () => query, lean: () => query, exec: async () => [staff] };
    return query as never;
  });
  mock.method(User, "findById", () => {
    const query = { select: () => query, lean: () => query, exec: async () => staff };
    return query as never;
  });
  mock.method(PickupRequestShipment, "find", () => {
    const query = { sort: () => query, lean: () => query, exec: async () => [] };
    return query as never;
  });
  mock.method(PickupAttempt, "find", () => {
    const query = { sort: () => query, populate: () => query, lean: () => query, exec: async () => [] };
    return query as never;
  });
  mock.method(PickupProof, "find", () => {
    const query = { select: () => query, lean: () => query, exec: async () => [] };
    return query as never;
  });
  mock.method(AuditLog, "create", async () => ({} as never));
  mock.method(PortalNotification, "bulkWrite", async (operations: Array<{ updateOne: { update: { $setOnInsert: typeof notifications[number] } } }>) => {
    notifications.push(...operations.map((operation) => operation.updateOne.update.$setOnInsert));
    return {} as never;
  });
  mock.method(EmailOutbox, "bulkWrite", async (operations: Array<{ updateOne: { update: { $setOnInsert: typeof emails[number] } } }>) => {
    emails.push(...operations.map((operation) => operation.updateOne.update.$setOnInsert));
    return {} as never;
  });
  mock.method(EmailOutbox, "updateMany", (filter: { notificationType: string; idempotencyKey: { $regex: string; $not: RegExp }; status: string }, update: { $set: { status: string } }) => ({
    exec: async () => {
      for (const email of emails) {
        if (email.notificationType === filter.notificationType && email.status === filter.status &&
          new RegExp(filter.idempotencyKey.$regex).test(email.idempotencyKey) &&
          !filter.idempotencyKey.$not.test(email.idempotencyKey)) {
          email.status = update.$set.status;
        }
      }
    }
  }) as never);

  return { pickup, pickups, notifications, emails, afterCandidateRead: (work: () => void) => { afterCandidateRead = work; } };
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

test("processes overdue and earlier upcoming dispatches first", async () => {
  try {
    const fixture = reminderFixture(
      new Date(now.getTime() + 7 * 60_000),
      [new Date(now.getTime() - 2 * 60_000), new Date(now.getTime() + 3 * 60_000)]
    );
    const result = await runPickupDispatchReminderSweep(now);
    assert.deepEqual(result.notifiedPickupIds, [
      String(fixture.pickups[1]!._id), String(fixture.pickups[2]!._id), String(fixture.pickups[0]!._id)
    ]);
    assert.equal(result.sent, 3);
  } finally { mock.restoreAll(); }
});

test("rescheduling resets eligibility and creates distinct in-app and email reminders for each schedule", async () => {
  try {
    const firstSweepAt = new Date(Date.now() + 45 * 60_000);
    const initialDispatch = new Date(firstSweepAt.getTime() + 8 * 60_000);
    const nextDispatch = new Date(firstSweepAt.getTime() + 35 * 60_000);
    const fixture = reminderFixture(initialDispatch);
    assert.equal((await runPickupDispatchReminderSweep(firstSweepAt)).sent, 1);
    assert.equal((await runPickupDispatchReminderSweep(firstSweepAt)).sent, 0);

    await reschedulePickup({
      pickupId: String(fixture.pickup._id), actorId: new mongoose.Types.ObjectId(), source: "CLIENT",
      startAt: nextDispatch, endAt: new Date(nextDispatch.getTime() + 2 * 60 * 60_000), timezone: "Asia/Kolkata"
    });
    assert.equal(fixture.pickup.dispatchReminderSentAt, null);
    assert.equal(fixture.pickup.dispatchAt.getTime(), nextDispatch.getTime());
    assert.equal(fixture.pickup.version, 2);
    assert.equal(fixture.emails.find((item) => item.notificationType === "PICKUP_DISPATCH_REMINDER")?.status, "CANCELLED");
    assert.equal(fixture.emails.find((item) => item.notificationType === "PICKUP_RESCHEDULED")?.status, "PENDING");
    assert.equal((await runPickupDispatchReminderSweep(new Date(firstSweepAt.getTime() + 5 * 60_000))).sent, 0);
    const rescheduledRun = await runPickupDispatchReminderSweep(new Date(nextDispatch.getTime() - 8 * 60_000));
    assert.equal(rescheduledRun.sent, 1);

    const reminders = fixture.notifications.filter((item) => item.type === "PICKUP_DISPATCH_REMINDER");
    const reminderEmails = fixture.emails.filter((item) => item.notificationType === "PICKUP_DISPATCH_REMINDER");
    assert.equal(reminders.length, 2);
    assert.equal(reminderEmails.length, 2);
    assert.match(reminders[0]!.idempotencyKey, new RegExp(`:${initialDispatch.getTime()}:1:`));
    assert.match(reminders[1]!.idempotencyKey, new RegExp(`:${nextDispatch.getTime()}:2:`));
    assert.notEqual(reminders[0]!.idempotencyKey, reminders[1]!.idempotencyKey);
    assert.equal(reminderEmails[1]!.subject, reminders[1]!.title);
    assert.equal(reminderEmails[1]!.payload.message, reminders[1]!.message);

    const filter = pendingPickupReminderEmailFilter(rescheduledRun.notifiedReminderKeys[0]!);
    const pendingForThisSchedule = reminderEmails.filter((item) =>
      item.status === filter.status && new RegExp(filter.idempotencyKey.$regex).test(item.idempotencyKey)
    );
    assert.deepEqual(pendingForThisSchedule.map((item) => item.idempotencyKey), [reminderEmails[1]!.idempotencyKey]);
    assert.equal(reminderEmails[0]!.status, "CANCELLED");
    assert.equal(reminderEmails[1]!.status, "PENDING");
  } finally { mock.restoreAll(); }
});

test("rescheduling does not cancel a new schedule email queued concurrently", async () => {
  try {
    const initialDispatch = new Date(Date.now() + 45 * 60_000);
    const nextDispatch = new Date(initialDispatch.getTime() + 30 * 60_000);
    const fixture = reminderFixture(initialDispatch);
    await runPickupDispatchReminderSweep(new Date(initialDispatch.getTime() - 8 * 60_000));
    const oldEmail = fixture.emails.find((item) => item.notificationType === "PICKUP_DISPATCH_REMINDER")!;
    const currentEmail = {
      ...oldEmail,
      idempotencyKey: `PICKUP_DISPATCH_REMINDER:${String(fixture.pickup._id)}:${nextDispatch.getTime()}:2:staff@example.test:email`
    };
    fixture.emails.push(currentEmail);

    await reschedulePickup({
      pickupId: String(fixture.pickup._id), actorId: new mongoose.Types.ObjectId(), source: "CLIENT",
      startAt: nextDispatch, endAt: new Date(nextDispatch.getTime() + 2 * 60 * 60_000), timezone: "Asia/Kolkata"
    });
    assert.equal(oldEmail.status, "CANCELLED");
    assert.equal(currentEmail.status, "PENDING");
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
