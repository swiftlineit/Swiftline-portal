import mongoose from "mongoose";
import { CashReceipt } from "../models/cashReceipt.model.js";
import { indexKeyEquals, indexSatisfiesPlan, type ExistingIndexShape, type PlannedIndexShape } from "./tenantMigrationIndexHelpers.js";

const managedIndexNames = ["tenant_active_cash_receipt", "tenant_one_active_shipment_cash_receipt"] as const;

export const cashReceiptActiveIndexPlans: PlannedIndexShape[] =
  (CashReceipt.schema.indexes() as Array<[Record<string, number>, mongoose.IndexOptions]>)
    .filter(([, options]) => managedIndexNames.includes(options.name as typeof managedIndexNames[number]))
    .map(([key, options]) => ({
      key,
      options: {
        name: options.name,
        unique: options.unique,
        partialFilterExpression: options.partialFilterExpression as Record<string, unknown> | undefined
      }
    }));

export function duplicateActiveShipmentCashReceiptsPipeline(): mongoose.PipelineStage[] {
  return [
    { $match: { shipmentDraftId: { $type: "objectId" }, status: { $in: ["DRAFT", "FINALIZED"] } } },
    {
      $group: {
        _id: { tenantId: "$tenantId", shipmentDraftId: "$shipmentDraftId", status: "$status" },
        records: { $sum: 1 }
      }
    },
    { $match: { records: { $gt: 1 } } },
    { $limit: 1 }
  ];
}

export function findMissingCashReceiptActiveIndexes(indexes: ExistingIndexShape[]) {
  return cashReceiptActiveIndexPlans.filter((plan) => !indexes.some((index) => indexSatisfiesPlan(index, plan)));
}

export function findConflictingCashReceiptActiveIndexes(indexes: ExistingIndexShape[]) {
  return cashReceiptActiveIndexPlans.flatMap((plan) => indexes
    .filter((index) => {
      const sameName = Boolean(plan.options.name) && index.name === plan.options.name;
      const sameKey = Boolean(index.key) && indexKeyEquals(index.key!, plan.key);
      return (sameName || sameKey) && !indexSatisfiesPlan(index, plan);
    })
    .map((index) => ({ plan, index }))
  );
}

export function findCashReceiptActiveIndexNameCollisions(indexes: ExistingIndexShape[]) {
  return cashReceiptActiveIndexPlans.flatMap((plan) => indexes
    .filter((index) => index.name === plan.options.name && (!index.key || !indexKeyEquals(index.key, plan.key)))
    .map((index) => ({ plan, index }))
  );
}
