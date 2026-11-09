import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  SessionEndedError,
  getAccessToken,
  refreshAccessToken,
  refreshAccessTokenWithStatus,
  setAccessToken,
  setSessionEndedReason,
  takeSessionEndedReason
} from "./auth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setAccessToken(null);
  setSessionEndedReason(null);
});

test("refresh exposes the server's session-ended reason", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    sessionEnded: true,
    message: "This session was ended by a newer login."
  }), {
    status: 401,
    headers: { "Content-Type": "application/json" }
  });

  await assert.rejects(
    refreshAccessToken(),
    (error: unknown) => error instanceof SessionEndedError
      && error.message === "This session was ended by a newer login."
  );
  assert.equal(takeSessionEndedReason(), "This session was ended by a newer login.");
});

test("a transient refresh failure does not erase the current access token", async () => {
  setAccessToken("still-usable");
  globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });

  assert.equal(await refreshAccessToken(), null);
  assert.equal(getAccessToken(), "still-usable");
  assert.equal(takeSessionEndedReason(), null);
});

test("refresh status distinguishes an expired session from an unavailable service", async () => {
  globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });

  assert.deepEqual(await refreshAccessTokenWithStatus(), {
    outcome: "unavailable",
    reason: "service",
    status: 503
  });
  assert.equal(getAccessToken(), null);

  globalThis.fetch = async () => new Response(JSON.stringify({ success: false }), {
    status: 401,
    headers: { "Content-Type": "application/json" }
  });
  assert.deepEqual(await refreshAccessTokenWithStatus(), { outcome: "expired" });
});

test("refresh status classifies a connection failure without calling it an expired session", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };

  assert.deepEqual(await refreshAccessTokenWithStatus(), {
    outcome: "unavailable",
    reason: "network"
  });
});

test("a successful refresh clears a stale session-ended notice", async () => {
  setSessionEndedReason("stale notice");
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    accessToken: "fresh-token"
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  assert.equal(await refreshAccessToken(), "fresh-token");
  assert.equal(getAccessToken(), "fresh-token");
  assert.equal(takeSessionEndedReason(), null);
});
