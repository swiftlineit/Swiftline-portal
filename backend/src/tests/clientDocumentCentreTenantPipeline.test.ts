import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { Claim } from "../models/claim.model.js";
import { ClaimDocument } from "../models/claimDocument.model.js";
import { DeliveryAssignment } from "../models/pod.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { ShipmentSupportingDocument } from "../models/shipmentSupportingDocument.model.js";
import { PodRevision } from "../models/pod.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { buildClientDocumentCentrePipeline } from "../services/clientDocumentCentre.service.js";

type Stage = Record<string, unknown>;

function stages(value: unknown): Stage[] {
  return Array.isArray(value) ? value.filter((item): item is Stage => typeof item === "object" && item !== null) : [];
}

function firstMatch(pipeline: unknown): Record<string, unknown> | undefined {
  const first = stages(pipeline)[0];
  return first && typeof first.$match === "object" && first.$match !== null
    ? first.$match as Record<string, unknown>
    : undefined;
}

function collectJoins(pipeline: unknown, result: Array<{ from: string; pipeline: unknown; let?: unknown }> = []) {
  for (const stage of stages(pipeline)) {
    if (typeof stage.$lookup === "object" && stage.$lookup !== null) {
      const lookup = stage.$lookup as Record<string, unknown>;
      result.push({
        from: String(lookup.from),
        pipeline: lookup.pipeline,
        ...(typeof lookup.let === "object" && lookup.let !== null ? { let: lookup.let } : {})
      });
      collectJoins(lookup.pipeline, result);
    }
    if (typeof stage.$unionWith === "object" && stage.$unionWith !== null) {
      const union = stage.$unionWith as Record<string, unknown>;
      collectJoins(union.pipeline, result);
    }
    if (typeof stage.$facet === "object" && stage.$facet !== null) {
      for (const facetPipeline of Object.values(stage.$facet as Record<string, unknown>)) {
        collectJoins(facetPipeline, result);
      }
    }
  }
  return result;
}

describe("client document centre tenant pipeline", () => {
  test("scopes every tenant-owned union and join and constrains legacy claim/POD joins", () => {
    const tenantId = new mongoose.Types.ObjectId();
    const businessAccountId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const pipeline = buildClientDocumentCentrePipeline(
      { ok: true, businessAccountId, branchIds: [branchId], canViewFinancials: true },
      { page: 1, limit: 20 },
      tenantId
    );

    const unions = stages(pipeline)
      .flatMap((stage) => typeof stage.$unionWith === "object" && stage.$unionWith !== null
        ? [stage.$unionWith as Record<string, unknown>]
        : []);
    assert.equal(unions.length, 9);

    const tenantOwnedSources = new Set([
      LabelDocument.collection.name,
      ShipmentDraft.collection.name,
      ShipmentManifest.collection.name,
      ShipmentInvoice.collection.name,
      ShipmentCreditNote.collection.name,
      CreditBillingStatement.collection.name,
      ShipmentSupportingDocument.collection.name
    ]);
    for (const union of unions) {
      if (!tenantOwnedSources.has(String(union.coll))) continue;
      assert.equal(String(firstMatch(union.pipeline)?.tenantId), String(tenantId), `${String(union.coll)} union scope`);
    }

    const joins = collectJoins(pipeline);
    assert.ok(joins.length > 0);
    for (const join of joins) {
      const match = firstMatch(join.pipeline);
      assert.ok(match, `${join.from} lookup must carry a restrictive match`);
      if (join.from === ShipmentDraft.collection.name) {
        assert.equal(String(match.tenantId), String(tenantId), `${join.from} tenant scope`);
        assert.equal(String(match.businessAccountId), String(businessAccountId), `${join.from} account scope`);
        assert.deepEqual(match.branchId, { $in: [branchId] }, `${join.from} branch scope`);
      } else if (join.from === DpdShipment.collection.name) {
        assert.equal(String(match.tenantId), String(tenantId), `${join.from} tenant scope`);
        if (join.let) {
          const expectedDraftId = (join.let as Record<string, unknown>).expectedDraftId;
          assert.equal(typeof expectedDraftId, "string", "ID-based booking joins must bind the expected shipment draft");
          const correlatedMatch = stages(join.pipeline).at(-1)?.$match as Record<string, unknown> | undefined;
          assert.deepEqual(correlatedMatch?.$expr, { $eq: ["$shipmentDraftId", "$$expectedDraftId"] });
        }
      } else if ([Claim.collection.name, DeliveryAssignment.collection.name].includes(join.from)) {
        assert.equal(String(match.businessAccountId), String(businessAccountId), `${join.from} account scope`);
        assert.deepEqual(match.branchId, { $in: [branchId] }, `${join.from} branch scope`);
      } else {
        assert.fail(`Unexpected document-centre join: ${join.from}`);
      }
    }

    const podUnion = unions.find((union) => union.coll === PodRevision.collection.name);
    const claimUnion = unions.find((union) => union.coll === ClaimDocument.collection.name);
    assert.ok(podUnion);
    assert.ok(claimUnion);
    assert.ok(collectJoins(podUnion.pipeline).some((join) => join.from === DeliveryAssignment.collection.name));
    assert.ok(collectJoins(claimUnion.pipeline).some((join) => join.from === Claim.collection.name));
  });
});
