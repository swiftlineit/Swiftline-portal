import assert from "node:assert/strict";
import { test } from "node:test";
import { CashReceipt } from "../models/cashReceipt.model.js";
import {
  cashReceiptActiveIndexPlans,
  duplicateActiveShipmentCashReceiptsPipeline,
  findCashReceiptActiveIndexNameCollisions,
  findConflictingCashReceiptActiveIndexes,
  findMissingCashReceiptActiveIndexes
} from "../scripts/cashReceiptActiveIndexMigration.js";

test("cash receipt active index plan excludes standalone rows and keeps shipment uniqueness", () => {
  const activeShipment = cashReceiptActiveIndexPlans.find(({ options }) => options.name === "tenant_active_cash_receipt");
  assert.deepEqual(activeShipment?.key, { tenantId: 1, shipmentDraftId: 1, status: 1 });
  assert.deepEqual(activeShipment?.options.partialFilterExpression, {
    shipmentDraftId: { $type: "objectId" },
    status: { $in: ["DRAFT", "FINALIZED"] }
  });
  assert.ok(cashReceiptActiveIndexPlans.some(({ options }) => options.name === "tenant_one_active_shipment_cash_receipt"));
  const schemaIndexes = CashReceipt.schema.indexes() as Array<[Record<string, unknown>, { unique?: boolean }] >;
  assert.ok(schemaIndexes.some(([key, options]) => key.shipmentDraftId === 1 && options.unique === true));
});

test("cash receipt index migration detects stale filters and refuses unrecognized name collisions", () => {
  const correct = cashReceiptActiveIndexPlans.map((plan) => ({
    name: plan.options.name,
    key: plan.key,
    unique: plan.options.unique,
    partialFilterExpression: plan.options.partialFilterExpression
  }));
  assert.deepEqual(findMissingCashReceiptActiveIndexes(correct), []);
  assert.deepEqual(findConflictingCashReceiptActiveIndexes(correct), []);
  const stale = [{
    name: "tenant_active_cash_receipt",
    key: { tenantId: 1, shipmentDraftId: 1, status: 1 },
    unique: true,
    partialFilterExpression: { status: { $in: ["DRAFT", "FINALIZED"] } }
  }];
  assert.equal(findConflictingCashReceiptActiveIndexes(stale).length, 1);
  assert.equal(findCashReceiptActiveIndexNameCollisions(stale).length, 0);
  assert.ok(findMissingCashReceiptActiveIndexes(stale).some(({ options }) => options.name === "tenant_active_cash_receipt"));
  const unknownName = [{ ...stale[0]!, name: "manual_unique_receipt_index" }];
  assert.equal(findConflictingCashReceiptActiveIndexes(unknownName)[0]?.index.name, "manual_unique_receipt_index");
});

test("duplicate receipt preflight only examines active shipment receipt rows", () => {
  const pipeline = duplicateActiveShipmentCashReceiptsPipeline();
  assert.deepEqual(pipeline[0], { $match: { shipmentDraftId: { $type: "objectId" }, status: { $in: ["DRAFT", "FINALIZED"] } } });
  assert.ok(pipeline.some((stage) => "$group" in stage));
  assert.ok(pipeline.some((stage) => "$limit" in stage));
});
