import assert from "node:assert/strict";
import test from "node:test";
import { getClientLoginReturnPath, getOperatorInvitationReturnPath } from "./operatorInvitationRouting";

const origin = "https://portal.swiftline.example";

test("client sign-in may return to a tokenized invitation activation path", () => {
  assert.equal(
    getOperatorInvitationReturnPath("/auth/activate?token=opaque-token", origin),
    "/auth/activate?token=opaque-token"
  );
});

test("client sign-in rejects non-invitation and unsafe return paths", () => {
  for (const value of [
    null,
    "",
    "/auth/activate",
    "/dashboard?token=opaque-token",
    "//attacker.example/auth/activate?token=opaque-token",
    "https://attacker.example/auth/activate?token=opaque-token",
    "/\\attacker.example/auth/activate?token=opaque-token"
  ]) {
    assert.equal(getOperatorInvitationReturnPath(value, origin), "", `expected rejection for ${String(value)}`);
  }
});

test("client sign-in may return to an operator portal page", () => {
  for (const value of [
    "/portal/harbor-cargo",
    "/portal/harbor-cargo/shipments/new",
    "/portal/harbor-cargo/credit?tab=statements#current"
  ]) {
    assert.equal(getClientLoginReturnPath(value, origin), value);
  }
});

test("client sign-in rejects unrelated or malformed portal destinations", () => {
  for (const value of [
    null,
    "/dashboard",
    "/portal/",
    "/portal/Harbor-Cargo",
    "/portal/harbor--cargo",
    "/portal/harbor-cargo/%2f%2fattacker.example",
    "//attacker.example/portal/harbor-cargo",
    "https://attacker.example/portal/harbor-cargo",
    "/\\attacker.example/portal/harbor-cargo"
  ]) {
    assert.equal(getClientLoginReturnPath(value, origin), "", `expected rejection for ${String(value)}`);
  }
});
