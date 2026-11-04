import mongoose from "mongoose";
import { SYSTEM_ACTOR_ID } from "../utils/systemActor.js";

export function hasTenantOwnership(model: Pick<mongoose.Model<any>, "schema">): boolean {
  const tenantId = model.schema.path("tenantId");
  return tenantId?.instance === "ObjectId" && tenantId.options.ref === "Tenant";
}

export type TenantOwnerParentLink = {
  childModel: string;
  field: "tenantId";
  parentModel: "Tenant";
  required: boolean;
};

/**
 * Builds integrity checks for every schema with a Tenant ObjectId owner.
 * Missing owners are also reported by the ownership audit, while this checks
 * that every present owner points to a real Tenant record.
 */
export function tenantOwnerParentLinks(
  models: ReadonlyArray<Pick<mongoose.Model<any>, "modelName" | "schema">>
): TenantOwnerParentLink[] {
  return models.filter(hasTenantOwnership).map((model) => ({
    childModel: model.modelName,
    field: "tenantId",
    parentModel: "Tenant",
    required: Boolean(model.schema.path("tenantId")?.options.required)
  }));
}

export function missingTenantOwnershipFilter() {
  return { $expr: { $ne: [{ $type: "$tenantId" }, "objectId"] } };
}

export function malformedTenantOwnershipFilter() {
  return {
    $expr: {
      $and: [
        { $ne: [{ $type: "$tenantId" }, "objectId"] },
        { $ne: [{ $type: "$tenantId" }, "missing"] },
        { $ne: [{ $type: "$tenantId" }, "null"] }
      ]
    }
  };
}

export function unassignedTenantOwnershipFilter() {
  return { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
}

/** Counts undelivered and terminal email states before legacy rows receive a tenant owner. */
export function missingTenantEmailOutboxStatusPipeline(): mongoose.PipelineStage[] {
  return [
    { $match: missingTenantOwnershipFilter() },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ];
}

export type ApprovedOrphanReferenceException = Readonly<{
  code: "RESERVED_SYSTEM_ACTOR" | "HISTORICAL_SENT_ACCOUNT_SUBMISSION_EMAIL";
  match: Record<string, unknown>;
  expectedCount?: number;
  expectedDistinctReferenceCount: number;
}>;

const historicalSentAccountSubmissionCreatedAt = new Date("2026-10-19T09:48:03.667Z");

/**
 * Returns the complete reviewed allowlist for dangling parent references.
 * Keep this field-specific: the reserved actor is not a general replacement
 * for a User, and the email exception is one immutable, completed event set.
 */
export function approvedOrphanReferenceException(
  childModel: string,
  field: string
): ApprovedOrphanReferenceException | undefined {
  if (
    field === "createdBy" &&
    (childModel === "CreditLedgerEntry" || childModel === "CreditBillingStatement")
  ) {
    return {
      code: "RESERVED_SYSTEM_ACTOR",
      match: { [field]: SYSTEM_ACTOR_ID },
      expectedDistinctReferenceCount: 1
    };
  }

  if (childModel === "EmailOutbox" && field === "businessAccountId") {
    return {
      code: "HISTORICAL_SENT_ACCOUNT_SUBMISSION_EMAIL",
      match: {
        [field]: { $type: "objectId" },
        notificationType: "BUSINESS_ACCOUNT_SUBMITTED",
        status: "SENT",
        createdAt: historicalSentAccountSubmissionCreatedAt
      },
      expectedCount: 2,
      expectedDistinctReferenceCount: 1
    };
  }

  return undefined;
}

export function classifyApprovedOrphanReferenceException(
  exception: ApprovedOrphanReferenceException,
  candidateCount: number,
  distinctReferenceCount: number
): { acceptedCount: number; rejectedCount: number } {
  const validCounts = Number.isSafeInteger(candidateCount)
    && candidateCount >= 0
    && Number.isSafeInteger(distinctReferenceCount)
    && distinctReferenceCount >= 0;
  const expectedEmptySet = candidateCount === 0 && distinctReferenceCount === 0;
  const expectedPopulatedSet = candidateCount > 0
    && distinctReferenceCount === exception.expectedDistinctReferenceCount
    && (exception.expectedCount === undefined || candidateCount === exception.expectedCount);
  const accepted = validCounts && (expectedEmptySet || expectedPopulatedSet);
  return {
    acceptedCount: accepted ? candidateCount : 0,
    rejectedCount: accepted ? 0 : candidateCount
  };
}

/**
 * Groups each index value under a MongoDB-safe alias. Index paths can contain
 * dots (for example `contact.email`), but aggregation object keys cannot.
 * Missing legacy tenant owners are grouped as the Swiftline root because those
 * rows are assigned to it by the reviewed ownership backfill.
 */
export function uniqueTenantKeyDuplicatePipeline(
  key: Record<string, number>,
  partialFilterExpression: Record<string, unknown> | undefined,
  tenantId: unknown,
  arrayFields: string[]
): mongoose.PipelineStage[] {
  const groupKey = Object.fromEntries(Object.keys(key).map((field, position) => [
    `key${position}`,
    field === "tenantId" ? { $ifNull: ["$tenantId", tenantId] } : `$${field}`
  ]));

  return [
    { $match: partialFilterExpression ?? {} },
    ...arrayFields.map((field) => ({ $unwind: { path: `$${field}`, preserveNullAndEmptyArrays: true } }) as mongoose.PipelineStage),
    { $group: { _id: groupKey, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: "duplicateGroups" }
  ];
}

export type OrphanSummaryDimension = {
  name: string;
  field: string;
  /** Summarize a lifecycle timestamp as a boolean, never expose its value. */
  kind?: "enum" | "present";
};

/**
 * Aggregates dangling reference rows by caller-approved, non-identifying fields.
 * It deliberately never returns child or parent IDs or arbitrary document data.
 */
export function orphanReferenceSummaryPipeline(
  field: string,
  parentCollection: string,
  dimensions: OrphanSummaryDimension[],
  excludedOrphanMatch?: Record<string, unknown>
): mongoose.PipelineStage[] {
  const summaryKey = Object.fromEntries(dimensions.map((dimension) => [
    dimension.name,
    dimension.kind === "present"
      ? { $ne: [{ $ifNull: [`$${dimension.field}`, null] }, null] }
      : `$${dimension.field}`
  ]));

  return [
    { $match: { $expr: { $eq: [{ $type: `$${field}` }, "objectId"] } } },
    {
      $lookup: {
        from: parentCollection,
        localField: field,
        foreignField: "_id",
        as: "_tenantAuditParent"
      }
    },
    { $match: { $expr: { $eq: [{ $size: "$_tenantAuditParent" }, 0] } } },
    ...(excludedOrphanMatch ? [{ $match: { $nor: [excludedOrphanMatch] } } as mongoose.PipelineStage] : []),
    { $group: { _id: summaryKey, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 25 }
  ];
}

/**
 * Returns only the child ID, missing parent ID, and explicitly approved
 * lifecycle fields for a read-only orphan review. The caller must validate
 * lifecycle dimensions against the model schema before using this pipeline.
 */
export function orphanReferenceDetailsPipeline(
  field: string,
  parentCollection: string,
  dimensions: OrphanSummaryDimension[],
  unwindPath?: string,
  excludedOrphanMatch?: Record<string, unknown>
): mongoose.PipelineStage[] {
  const lifecycleProjection = Object.fromEntries(dimensions.map((dimension) => [
    dimension.name,
    dimension.kind === "present"
      ? { $ne: [{ $ifNull: [`$${dimension.field}`, null] }, null] }
      : `$${dimension.field}`
  ]));

  return [
    ...(unwindPath ? [{ $unwind: { path: `$${unwindPath}` } }] : []),
    { $match: { $expr: { $eq: [{ $type: `$${field}` }, "objectId"] } } },
    {
      $lookup: {
        from: parentCollection,
        localField: field,
        foreignField: "_id",
        as: "_tenantAuditParent"
      }
    },
    { $match: { $expr: { $eq: [{ $size: "$_tenantAuditParent" }, 0] } } },
    ...(excludedOrphanMatch ? [{ $match: { $nor: [excludedOrphanMatch] } } as mongoose.PipelineStage] : []),
    {
      $project: {
        _id: 1,
        missingParentId: `$${field}`,
        ...lifecycleProjection
      }
    },
    { $sort: { _id: 1, missingParentId: 1 } },
    { $limit: 501 }
  ];
}

export function invalidObjectIdReferenceFilter(field: string, required: boolean) {
  const invalidType = { $expr: { $ne: [{ $type: `$${field}` }, "objectId"] } };
  if (required) return invalidType;
  return {
    $and: [
      { [field]: { $exists: true, $ne: null } },
      invalidType
    ]
  };
}

export function tenantParentIntegrityPipeline(
  field: string,
  parentCollection: string,
  identityFields: string[] = []
): mongoose.PipelineStage[] {
  const identityMismatch = identityFields.length
    ? {
        $or: identityFields.flatMap((identityField) => [
          { $ne: [{ $type: `$${identityField}` }, "objectId"] },
          { $ne: [{ $type: `$_tenantAuditParent.${identityField}` }, "objectId"] },
          { $ne: [`$${identityField}`, `$_tenantAuditParent.${identityField}`] }
        ])
      }
    : { $literal: false };

  return [
    {
      $match: {
        $expr: { $eq: [{ $type: `$${field}` }, "objectId"] }
      }
    },
    {
      $lookup: {
        from: parentCollection,
        localField: field,
        foreignField: "_id",
        as: "_tenantAuditParent"
      }
    },
    { $unwind: "$_tenantAuditParent" },
    {
      $group: {
        _id: null,
        crossTenantParent: {
          $sum: {
            $cond: [{
              $and: [
                { $eq: [{ $type: "$tenantId" }, "objectId"] },
                { $eq: [{ $type: "$_tenantAuditParent.tenantId" }, "objectId"] },
                { $ne: ["$tenantId", "$_tenantAuditParent.tenantId"] }
              ]
            }, 1, 0]
          }
        },
        identityMismatch: { $sum: { $cond: [identityMismatch, 1, 0] } }
      }
    }
  ];
}
