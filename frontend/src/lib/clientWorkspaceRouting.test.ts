import assert from "node:assert/strict";
import test from "node:test";
import type { ClientWorkspaceAccess } from "./clientWorkspaceAccess";
import { clientRouteFallback, resolveClientLoginDestination } from "./clientWorkspaceRouting";

const origin = "https://portal.swiftline.example";
const operatorA = { slug: "harbor-cargo", companyName: "Harbor Cargo", status: "ACTIVE", role: "CLIENT" } as const;
const operatorDraft = { slug: "new-operator", companyName: "New Operator", status: "DRAFT", role: "OPERATOR_ADMIN" } as const;

test("routes an operator-only identity directly to its sole active operator workspace", () => {
  const access: ClientWorkspaceAccess = { swiftline: false, operators: [operatorA] };
  assert.equal(resolveClientLoginDestination(access, null, origin), "/portal/harbor-cargo");
  assert.equal(clientRouteFallback(access), "/portal/harbor-cargo");
});

test("routes a Swiftline-only identity to the existing Swiftline client dashboard", () => {
  const access: ClientWorkspaceAccess = { swiftline: true, operators: [] };
  assert.equal(resolveClientLoginDestination(access, null, origin), "/client/dashboard");
  assert.equal(clientRouteFallback(access), null);
});

test("offers a workspace choice when an identity has more than one active workspace", () => {
  const access: ClientWorkspaceAccess = { swiftline: true, operators: [operatorA] };
  assert.equal(resolveClientLoginDestination(access, null, origin), "/workspaces");
  assert.equal(resolveClientLoginDestination({ swiftline: false, operators: [operatorA, { ...operatorA, slug: "other-cargo" }] }, null, origin), "/workspaces");
});

test("honors a safe requested workspace only when the identity belongs to it", () => {
  const access: ClientWorkspaceAccess = { swiftline: true, operators: [operatorA] };
  assert.equal(resolveClientLoginDestination(access, "/portal/harbor-cargo/shipments/new", origin), "/portal/harbor-cargo/shipments/new");
  assert.equal(resolveClientLoginDestination(access, "/client/shipments?status=booked", origin), "/client/shipments?status=booked");
  assert.equal(resolveClientLoginDestination({ swiftline: false, operators: [operatorA] }, "/client/dashboard", origin), "/portal/harbor-cargo");
  assert.equal(resolveClientLoginDestination({ swiftline: false, operators: [operatorA] }, "/portal/other-cargo", origin), "/portal/harbor-cargo");
});

test("preserves invitation activation and does not open a draft operator workspace", () => {
  assert.equal(
    resolveClientLoginDestination({ swiftline: false, operators: [operatorA] }, "/auth/activate?token=invite-token", origin),
    "/auth/activate?token=invite-token"
  );
  const draftAccess: ClientWorkspaceAccess = { swiftline: false, operators: [operatorDraft] };
  assert.equal(resolveClientLoginDestination(draftAccess, null, origin), "/workspaces");
  assert.equal(clientRouteFallback(draftAccess), "/workspaces");
});

test("routes accounts with no workspace membership to the safe no-access chooser", () => {
  assert.equal(resolveClientLoginDestination({ swiftline: false, operators: [] }, null, origin), "/workspaces");
  assert.equal(clientRouteFallback({ swiftline: false, operators: [] }), "/workspaces");
});
