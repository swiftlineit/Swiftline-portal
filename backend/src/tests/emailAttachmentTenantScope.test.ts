import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { LabelDocument } from "../models/labelDocument.model.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { RateCardShare } from "../models/rateCardShare.model.js";
import { resolveAttachments } from "../services/email/attachments.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

test("operator emails do not query Swiftline-only attachment records", async () => {
  const originalPickupFindById = PickupRequest.findById;
  const originalRateCardShareFindById = RateCardShare.findById;
  let lookupCount = 0;

  const unexpectedLookup = (() => {
    lookupCount += 1;
    throw new Error("Swiftline-only attachment lookup should not run for an operator.");
  }) as unknown as typeof PickupRequest.findById;

  PickupRequest.findById = unexpectedLookup;
  RateCardShare.findById = unexpectedLookup as unknown as typeof RateCardShare.findById;

  try {
    const result = await runWithTenantContext(
      { tenantId: new mongoose.Types.ObjectId(), kind: "OPERATOR" },
      () => resolveAttachments([
        { kind: "PICKUP_DOCUMENT", refId: new mongoose.Types.ObjectId(), documentId: new mongoose.Types.ObjectId() },
        { kind: "RATE_CARD_SHARE_PDF", refId: new mongoose.Types.ObjectId() },
        { kind: "RATE_CARD_SHARE_XLSX", refId: new mongoose.Types.ObjectId() }
      ])
    );

    assert.equal(result.attachments.length, 0);
    assert.equal(result.dropped, true);
    assert.match(result.droppedReason, /unavailable in operator emails/);
    assert.equal(lookupCount, 0);
  } finally {
    PickupRequest.findById = originalPickupFindById;
    RateCardShare.findById = originalRateCardShareFindById;
  }
});

test("Swiftline emails retain pickup attachment lookup", async () => {
  const originalFindById = PickupRequest.findById;
  let lookupCount = 0;
  PickupRequest.findById = (() => {
    lookupCount += 1;
    return { select: () => ({ lean: () => ({ exec: async () => null }) }) };
  }) as unknown as typeof PickupRequest.findById;

  try {
    const result = await runWithTenantContext(
      { tenantId: new mongoose.Types.ObjectId(), kind: "SWIFTLINE" },
      () => resolveAttachments([
        { kind: "PICKUP_DOCUMENT", refId: new mongoose.Types.ObjectId(), documentId: new mongoose.Types.ObjectId() }
      ])
    );

    assert.equal(lookupCount, 1);
    assert.equal(result.attachments.length, 0);
    assert.equal(result.dropped, true);
  } finally {
    PickupRequest.findById = originalFindById;
  }
});

test("operator emails retain tenant-owned label attachment lookup", async () => {
  const originalFindById = LabelDocument.findById;
  let lookupCount = 0;
  LabelDocument.findById = (() => {
    lookupCount += 1;
    return { lean: () => ({ exec: async () => null }) };
  }) as unknown as typeof LabelDocument.findById;

  try {
    const result = await runWithTenantContext(
      { tenantId: new mongoose.Types.ObjectId(), kind: "OPERATOR" },
      () => resolveAttachments([{ kind: "LABEL_DOCUMENT", refId: new mongoose.Types.ObjectId() }])
    );

    assert.equal(lookupCount, 1);
    assert.equal(result.attachments.length, 0);
    assert.equal(result.dropped, true);
  } finally {
    LabelDocument.findById = originalFindById;
  }
});
