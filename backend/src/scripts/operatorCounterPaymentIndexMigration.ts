import mongoose from "mongoose";
import { OperatorCounterPayment } from "../models/operatorCounterPayment.model.js";
import {
  indexKeyEquals,
  indexSatisfiesPlan,
  type ExistingIndexShape,
  type PlannedIndexShape
} from "./tenantMigrationIndexHelpers.js";

export const operatorCounterPaymentSourceTypes = ["BOOKING", "AMENDMENT", "CANCELLATION"] as const;

export const operatorCounterPaymentIndexPlans: PlannedIndexShape[] =
  (OperatorCounterPayment.schema.indexes() as Array<[Record<string, number>, mongoose.IndexOptions]>)
    .map(([key, options]) => ({
      key,
      options: {
        name: options.name,
        unique: options.unique,
        partialFilterExpression: options.partialFilterExpression as Record<string, unknown> | undefined
      }
    }));

export function invalidOperatorCounterPaymentFieldsPipeline(): mongoose.PipelineStage[] {
  return [
    {
      $match: {
        $expr: {
          $or: [
            { $ne: [{ $type: "$tenantId" }, "objectId"] },
            { $ne: [{ $type: "$sourceId" }, "objectId"] },
            { $not: [{ $in: ["$sourceType", operatorCounterPaymentSourceTypes] }] }
          ]
        }
      }
    },
    { $count: "count" }
  ];
}

export function duplicateOperatorCounterPaymentSourcesPipeline(): mongoose.PipelineStage[] {
  return [
    {
      $match: {
        $expr: {
          $and: [
            { $eq: [{ $type: "$tenantId" }, "objectId"] },
            { $eq: [{ $type: "$sourceId" }, "objectId"] },
            { $in: ["$sourceType", operatorCounterPaymentSourceTypes] }
          ]
        }
      }
    },
    {
      $group: {
        _id: { tenantId: "$tenantId", sourceType: "$sourceType", sourceId: "$sourceId" },
        records: { $sum: 1 }
      }
    },
    { $match: { records: { $gt: 1 } } },
    { $count: "count" }
  ];
}

export function findMissingOperatorCounterPaymentIndexes(indexes: ExistingIndexShape[]) {
  return operatorCounterPaymentIndexPlans.filter((plan) =>
    !indexes.some((existing) => indexSatisfiesPlan(existing, plan))
  );
}

export function findConflictingOperatorCounterPaymentIndexes(indexes: ExistingIndexShape[]) {
  return operatorCounterPaymentIndexPlans.filter((plan) =>
    indexes.some((existing) => {
      const sameName = Boolean(plan.options.name) && existing.name === plan.options.name;
      const sameKey = existing.key ? indexKeyEquals(existing.key, plan.key) : false;
      return (sameName || sameKey) && !indexSatisfiesPlan(existing, plan);
    })
  );
}
