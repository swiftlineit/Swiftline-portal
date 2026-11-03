import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { createLabelAccessToken, verifyLabelAccessToken } from "../services/shipmentLabelAccessToken.service.js";

describe("signed shipment label access tokens", () => {
  const ids = {
    shipment: new mongoose.Types.ObjectId(),
    label: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    tenant: new mongoose.Types.ObjectId(),
    supportSession: new mongoose.Types.ObjectId()
  };

  test("binds operator downloads to their tenant", () => {
    const token = createLabelAccessToken({
      dpdShipmentId: String(ids.shipment),
      labelId: String(ids.label),
      userId: String(ids.user),
      expiresAt: new Date(Date.now() + 60_000),
      tenantId: ids.tenant,
      tenantKind: "OPERATOR"
    });

    const verified = verifyLabelAccessToken(token);
    assert.ok(verified);
    assert.equal(String(verified.tenantId), String(ids.tenant));
    assert.equal(verified.tenantKind, "OPERATOR");
    assert.equal(verified.readOnly, false);
  });

  test("binds read-only support downloads to the audited support session", () => {
    const token = createLabelAccessToken({
      dpdShipmentId: String(ids.shipment),
      labelId: String(ids.label),
      userId: String(ids.user),
      expiresAt: new Date(Date.now() + 60_000),
      tenantId: ids.tenant,
      tenantKind: "OPERATOR",
      readOnly: true,
      supportSessionId: ids.supportSession
    });

    const verified = verifyLabelAccessToken(token);
    assert.ok(verified);
    assert.equal(verified.readOnly, true);
    assert.equal(String(verified.supportSessionId), String(ids.supportSession));
  });

  test("rejects expired, tampered, and unbound support tokens", () => {
    const expired = createLabelAccessToken({
      dpdShipmentId: String(ids.shipment),
      labelId: String(ids.label),
      userId: String(ids.user),
      expiresAt: new Date(Date.now() - 1_000)
    });
    assert.equal(verifyLabelAccessToken(expired), null);

    const valid = createLabelAccessToken({
      dpdShipmentId: String(ids.shipment),
      labelId: String(ids.label),
      userId: String(ids.user),
      expiresAt: new Date(Date.now() + 60_000),
      tenantId: ids.tenant,
      tenantKind: "OPERATOR"
    });
    const [payload, signature] = valid.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
      tenantId: String(new mongoose.Types.ObjectId())
    })).toString("base64url");
    assert.equal(verifyLabelAccessToken(`${tamperedPayload}.${signature}`), null);

    assert.throws(() => createLabelAccessToken({
      dpdShipmentId: String(ids.shipment),
      labelId: String(ids.label),
      userId: String(ids.user),
      expiresAt: new Date(Date.now() + 60_000),
      readOnly: true
    }));
  });

  test("keeps unscoped legacy Swiftline tokens verifiable during their short expiry", () => {
    const token = createLabelAccessToken({
      dpdShipmentId: String(ids.shipment),
      labelId: String(ids.label),
      userId: String(ids.user),
      expiresAt: new Date(Date.now() + 60_000)
    });

    const verified = verifyLabelAccessToken(token);
    assert.ok(verified);
    assert.equal(verified.tenantId, undefined);
    assert.equal(verified.readOnly, false);
  });
});
