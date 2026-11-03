import mongoose from "mongoose";

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

/** Counts undelivered and terminal email states before legacy rows receive a tenant owner. */
export function missingTenantEmailOutboxStatusPipeline(): mongoose.PipelineStage[] {
  return [
    { $match: missingTenantOwnershipFilter() },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
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
  dimensions: OrphanSummaryDimension[]
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
  unwindPath?: string
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
