import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { updateUserStatus } from "../controllers/user.controller.js";
import { attachUser } from "../middleware/auth.middleware.js";
import { User } from "../models/user.model.js";
import { UserSession } from "../models/userSession.model.js";
import { createAccessToken } from "../services/auth.service.js";
import {
  accountNotActiveMessage,
  endSessions,
  isSingleSessionEnforced,
  startSession,
  verifySession
} from "../services/userSession.service.js";

/**
 * Revocation has to work with `SINGLE_SESSION_ENFORCED` off.
 *
 * It previously did not: `verifySession` returned "fine" without reading the
 * session whenever that flag was unset- which is its default and what the
 * deployed environment used- so logging out, an admin terminating a session and
 * suspending an account were all accepted by the API and then ignored. Nothing
 * read `userStatus` after login either, and because `/auth/refresh` mints a new
 * seven-day cookie on every call, a blocked login renewed itself indefinitely.
 *
 * These tests assert the flag is off first, so they are checking the behaviour
 * in the configuration that was actually broken rather than a friendlier one.
 */

const databaseName = `swiftline_session_test_${Date.now()}`;

function createResponseRecorder() {
  const recorder = {
    statusCode: 200,
    body: undefined as unknown,
    response: {} as Response
  };

  recorder.response = {
    status(code: number) {
      recorder.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      recorder.body = payload;
      return this;
    }
  } as unknown as Response;

  return recorder;
}

/** Enough of a Request for `readRequestContext` and `attachUser`. */
function createRequest(overrides: Partial<Request> = {}) {
  return {
    headers: {},
    ip: "203.0.113.10",
    socket: { remoteAddress: "203.0.113.10" },
    params: {},
    body: {},
    ...overrides
  } as unknown as Request;
}

async function createStaffUser(email: string) {
  return User.create({
    email,
    passwordHash: "not-used-by-these-tests",
    role: "operations",
    userStatus: "active",
    isVerified: true
  });
}

async function createClientUser(email: string) {
  return User.create({
    email,
    passwordHash: "not-used-by-these-tests",
    role: "client",
    userStatus: "active",
    isVerified: true
  });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(
    mongoose.connection.name,
    databaseName,
    "Session revocation tests must use the isolated session test database."
  );
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(
      mongoose.connection.name.startsWith("swiftline_session_test_"),
      "Refusing to clean a non-test database."
    );
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}).exec(),
    UserSession.deleteMany({}).exec()
  ]);
});

describe("session revocation with single-session enforcement off", () => {
  test("the flag really is off, so these tests cover the broken configuration", () => {
    assert.equal(
      isSingleSessionEnforced(),
      false,
      "Set SINGLE_SESSION_ENFORCED=false (or leave it unset) to run this suite meaningfully."
    );
  });

  test("an ended session stops being usable", async () => {
    const user = await createStaffUser("ended-session@swiftline.test");
    const sessionId = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");

    assert.deepEqual(await verifySession(sessionId), { ok: true });

    await endSessions({ sessionId }, "logout");

    const afterLogout = await verifySession(sessionId);
    assert.equal(afterLogout.ok, false, "A logged-out session must not keep working.");
  });

  test("a token with no session id is still honoured", async () => {
    // Tokens minted before sessions existed carry no `sid`; rejecting them would
    // sign everyone out on deploy.
    assert.deepEqual(await verifySession(undefined), { ok: true });
  });

  test("the server idle timeout remains enforced", async () => {
    const user = await createStaffUser("idle-session@swiftline.test");
    const sessionId = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");
    await UserSession.updateOne(
      { sessionId },
      { $set: { lastSeenAt: new Date(Date.now() - (env.SESSION_IDLE_TIMEOUT_MINUTES + 1) * 60 * 1000) } }
    ).exec();

    assert.equal((await verifySession(sessionId)).ok, false);
    const session = await UserSession.findOne({ sessionId }).lean().exec();
    assert.equal(session?.endReason, "idle_timeout");
  });
});

describe("role-based concurrent sessions", () => {
  test("a client login does not end the client's other active device", async () => {
    const original = env.SINGLE_SESSION_ENFORCED;
    env.SINGLE_SESSION_ENFORCED = true;

    try {
      const user = await createClientUser("multi-device-client@swiftline.test");
      const first = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "client");
      const second = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "client");

      assert.deepEqual(await verifySession(first), { ok: true });
      assert.deepEqual(await verifySession(second), { ok: true });
      assert.equal(await UserSession.countDocuments({ userId: user._id, status: "active" }), 2);
    } finally {
      env.SINGLE_SESSION_ENFORCED = original;
    }
  });

  test("an internal login still ends its previous active device", async () => {
    const original = env.SINGLE_SESSION_ENFORCED;
    env.SINGLE_SESSION_ENFORCED = true;

    try {
      const user = await createStaffUser("single-device-staff@swiftline.test");
      const first = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");
      const second = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");

      assert.equal((await verifySession(first)).ok, false);
      assert.deepEqual(await verifySession(second), { ok: true });
      assert.equal(await UserSession.countDocuments({ userId: user._id, status: "active" }), 1);
    } finally {
      env.SINGLE_SESSION_ENFORCED = original;
    }
  });
});

describe("account status is enforced on every request", () => {
  test("an active staff login is attached normally", async () => {
    const user = await createStaffUser("active-staff@swiftline.test");
    const sessionId = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");
    const token = createAccessToken(
      { id: String(user._id), role: "operations", email: user.email },
      sessionId
    );

    const request = createRequest({ headers: { authorization: `Bearer ${token}` } });
    const recorder = createResponseRecorder();
    let nextCalled = false;

    await attachUser(request, recorder.response, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, true, "An active login should reach the route handler.");
    assert.equal((request as Request & { user?: { role?: string } }).user?.role, "operations");
  });

  test("suspending a staff login refuses the token it already holds", async () => {
    const user = await createStaffUser("suspended-staff@swiftline.test");
    const sessionId = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");
    const token = createAccessToken(
      { id: String(user._id), role: "operations", email: user.email },
      sessionId
    );

    await User.updateOne({ _id: user._id }, { $set: { userStatus: "suspended" } }).exec();

    const request = createRequest({ headers: { authorization: `Bearer ${token}` } });
    const recorder = createResponseRecorder();
    let nextCalled = false;

    await attachUser(request, recorder.response, (() => {
      nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, false, "A suspended login must not reach the route handler.");
    assert.equal(recorder.statusCode, 401);
    assert.deepEqual(recorder.body, {
      success: false,
      message: accountNotActiveMessage,
      sessionEnded: true
    });
  });

  test("disabling a login refuses it too", async () => {
    const user = await createStaffUser("disabled-staff@swiftline.test");
    const sessionId = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");
    const token = createAccessToken(
      { id: String(user._id), role: "operations", email: user.email },
      sessionId
    );

    await User.updateOne({ _id: user._id }, { $set: { userStatus: "disabled" } }).exec();

    const request = createRequest({ headers: { authorization: `Bearer ${token}` } });
    const recorder = createResponseRecorder();

    await attachUser(request, recorder.response, (() => undefined) as NextFunction);

    assert.equal(recorder.statusCode, 401);
  });
});

describe("changing a user's status ends their open sessions", () => {
  test("suspending from the Users page terminates the session server-side", async () => {
    const admin = await User.create({
      email: "status-admin@swiftline.test",
      passwordHash: "not-used-by-these-tests",
      role: "admin",
      userStatus: "active",
      isVerified: true
    });
    const user = await createStaffUser("to-be-suspended@swiftline.test");
    const sessionId = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");

    const request = createRequest({
      params: { id: String(user._id) },
      body: { status: "suspended" }
    });
    (request as Request & { user?: unknown }).user = { _id: admin._id, role: "admin" };
    const recorder = createResponseRecorder();

    await updateUserStatus(request, recorder.response);

    assert.equal(recorder.statusCode, 200);

    const session = await UserSession.findOne({ sessionId }).lean().exec();
    assert.equal(session?.status, "ended", "The open session should have been terminated.");
    assert.equal(session?.endReason, "terminated_by_admin");
    assert.equal(String(session?.endedBy), String(admin._id));
  });

  test("reactivating a login does not resurrect the old session", async () => {
    const admin = await User.create({
      email: "reactivate-admin@swiftline.test",
      passwordHash: "not-used-by-these-tests",
      role: "admin",
      userStatus: "active",
      isVerified: true
    });
    const user = await createStaffUser("to-be-reactivated@swiftline.test");
    const sessionId = await startSession(user._id as mongoose.Types.ObjectId, createRequest(), 60_000, "operations");

    for (const status of ["suspended", "active"]) {
      const request = createRequest({
        params: { id: String(user._id) },
        body: { status }
      });
      (request as Request & { user?: unknown }).user = { _id: admin._id, role: "admin" };
      await updateUserStatus(request, createResponseRecorder().response);
    }

    const session = await UserSession.findOne({ sessionId }).lean().exec();
    assert.equal(session?.status, "ended", "Restoring access must require signing in again.");
    assert.equal((await verifySession(sessionId)).ok, false);
  });
});
