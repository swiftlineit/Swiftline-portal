import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { API_BASE_URL, apiUrl } from "@/lib/api";
import {
  clearOperatorSupportGrant,
  operatorSupportHeaders,
  storeOperatorSupportGrant,
  type OperatorSupportGrant
} from "@/lib/operatorSupport";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installWindow() {
  const values = new Map<string, string>();
  const windowStub = {
    location: { origin: "https://portal.example.test" },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    }
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  return windowStub;
}

const supportGrant: OperatorSupportGrant = {
  token: "a".repeat(64),
  sessionId: "507f1f77bcf86cd799439001",
  tenantId: "507f1f77bcf86cd799439002",
  operatorSlug: "northstar-cargo",
  companyName: "Northstar Cargo",
  reason: "Review a client shipment issue",
  expiresAt: "2026-10-24T12:30:00.000Z"
};

afterEach(() => {
  clearOperatorSupportGrant();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("operator platform support request credentials", () => {
  test("adds the token only to trusted operator API paths and preserves existing headers", () => {
    installWindow();
    storeOperatorSupportGrant(supportGrant);

    const headers = operatorSupportHeaders("/api/v1/operators/northstar-cargo/me", { "X-Request-Id": "request-1" });
    assert.equal(headers.get("X-Operator-Support-Token"), supportGrant.token);
    assert.equal(headers.get("X-Request-Id"), "request-1");
    assert.equal(operatorSupportHeaders(apiUrl("/api/v1/operators/northstar-cargo/me")).get("X-Operator-Support-Token"), supportGrant.token);
    assert.equal(operatorSupportHeaders("/api/v1/client/shipments").has("X-Operator-Support-Token"), false);
    assert.equal(operatorSupportHeaders("/api/v1/platform/operators").has("X-Operator-Support-Token"), false);
  });

  test("does not disclose the token to untrusted absolute URLs", () => {
    installWindow();
    storeOperatorSupportGrant(supportGrant);

    const externalOperatorUrl = "https://attacker.example/api/v1/operators/northstar-cargo/me";
    const externalClientUrl = `${API_BASE_URL}/api/v1/client/shipments`;
    assert.equal(operatorSupportHeaders(externalOperatorUrl).has("X-Operator-Support-Token"), false);
    assert.equal(operatorSupportHeaders(externalClientUrl).has("X-Operator-Support-Token"), false);
  });
});
