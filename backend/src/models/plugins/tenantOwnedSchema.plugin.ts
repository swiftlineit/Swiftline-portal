import mongoose from "mongoose";
import { getDataAccessTenantId, getTenantContext } from "../../services/tenantScope.service.js";

type TenantRecord = Record<string, unknown> & { tenantId?: unknown };

export interface TenantOwnedFields {
  tenantId?: mongoose.Types.ObjectId;
}

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

interface TenantOwnedPluginOptions {
  /** Permit new append-only audit records during read-only support sessions. */
  allowReadOnlyAuditAppend?: boolean;
}

export function assertTenantWriteAllowed(
  operation: string,
  options: TenantOwnedPluginOptions,
  isNew = false
) {
  if (!getTenantContext()?.readOnly) return;
  if (options.allowReadOnlyAuditAppend && (operation === "insertMany" || (operation === "save" && isNew))) return;
  throw new TenantScopeError("Platform support access is read-only.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesTenant(value: unknown, tenantId: mongoose.Types.ObjectId): boolean {
  return value != null && String(value) === String(tenantId);
}

function assertTenantValue(value: unknown, tenantId: mongoose.Types.ObjectId) {
  if (value != null && !matchesTenant(value, tenantId)) {
    throw new TenantScopeError("A tenant-owned record cannot be assigned to another tenant.");
  }
}

function isExactTenantEquality(value: unknown, tenantId: mongoose.Types.ObjectId): boolean {
  if (value instanceof mongoose.Types.ObjectId || typeof value === "string") {
    return matchesTenant(value, tenantId);
  }
  return isRecord(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, "$eq")
    && isExactTenantEquality(value.$eq, tenantId);
}

function hasNestedTenantFilter(filter: Record<string, unknown>): boolean {
  return ["$and", "$or", "$nor"].some((operator) => {
    const clauses = filter[operator];
    return Array.isArray(clauses) && clauses.some((clause) => {
      if (!isRecord(clause)) return false;
      return Object.hasOwn(clause, "tenantId") || hasNestedTenantFilter(clause);
    });
  });
}

/**
 * Adds the active owner to every tenant-owned query. Upserts use a top-level
 * equality so MongoDB can build one unambiguous tenantId when inserting.
 */
export function scopeTenantFilter(
  filter: Record<string, unknown>,
  tenantId: mongoose.Types.ObjectId,
  upsert = false
) {
  const hasDirectTenantFilter = Object.hasOwn(filter, "tenantId");
  if (upsert) {
    if (hasNestedTenantFilter(filter)) {
      throw new TenantScopeError("Tenant-owned upserts cannot use nested tenant ownership filters.");
    }
    if (hasDirectTenantFilter && !isExactTenantEquality(filter.tenantId, tenantId)) {
      throw new TenantScopeError("Tenant-owned upserts must target the active tenant.");
    }
    return { ...filter, tenantId };
  }

  if (hasDirectTenantFilter && isExactTenantEquality(filter.tenantId, tenantId)) return filter;
  return { $and: [filter, { tenantId }] };
}

/**
 * Tenant-owned update pipelines run only against a tenant-scoped query. Keep
 * their stage vocabulary narrow so a pipeline cannot replace the document or
 * remove/rewrite its immutable owner field.
 */
export function validateTenantSafeUpdatePipeline(update: unknown, upsert: boolean): mongoose.PipelineStage[] {
  if (!Array.isArray(update) || upsert) {
    throw new TenantScopeError("Tenant-owned update pipelines require a scoped non-upsert operation.");
  }

  for (const stage of update) {
    if (!isRecord(stage)) throw new TenantScopeError("Invalid tenant-owned update pipeline stage.");
    const entries = Object.entries(stage);
    const entry = entries[0];
    if (entries.length !== 1 || !entry || !["$set", "$addFields"].includes(entry[0])) {
      throw new TenantScopeError("Tenant-owned update pipelines may only set non-owner fields.");
    }

    const fields = entry[1];
    if (!isRecord(fields)) throw new TenantScopeError("Invalid tenant-owned update pipeline fields.");
    if (Object.keys(fields).some((path) => path === "tenantId" || path.startsWith("tenantId."))) {
      throw new TenantScopeError("A tenant ownership field cannot be removed or transformed.");
    }
  }

  return update as mongoose.PipelineStage[];
}

function scopedUpdate(
  update: unknown,
  tenantId: mongoose.Types.ObjectId,
  upsert: boolean
): mongoose.UpdateQuery<unknown> | mongoose.PipelineStage[] {
  if (Array.isArray(update)) {
    return validateTenantSafeUpdatePipeline(update, upsert);
  }
  if (!isRecord(update)) throw new TenantScopeError("A tenant-owned update must be an object.");

  const next: Record<string, unknown> = { ...update };
  const isReplacement = !Object.keys(next).some((key) => key.startsWith("$"));
  if (isReplacement) {
    assertTenantValue(next.tenantId, tenantId);
    next.tenantId = tenantId;
    return next as mongoose.UpdateQuery<unknown>;
  }

  for (const [operator, value] of Object.entries(next)) {
    if (!isRecord(value) || !Object.hasOwn(value, "tenantId")) continue;
    if (operator !== "$set" && operator !== "$setOnInsert") {
      throw new TenantScopeError("A tenant ownership field cannot be removed or transformed.");
    }
    assertTenantValue(value.tenantId, tenantId);
    next[operator] = { ...value, tenantId };
  }

  for (const [operator, value] of Object.entries(next)) {
    if (!isRecord(value)) continue;
    if (Object.keys(value).some((path) => path.startsWith("tenantId."))) {
      throw new TenantScopeError("Nested tenant ownership paths cannot be updated.");
    }
    if (operator === "$rename" && Object.entries(value).some(([source, target]) =>
      source === "tenantId" || source.startsWith("tenantId.") ||
      (typeof target === "string" && (target === "tenantId" || target.startsWith("tenantId.")))
    )) {
      throw new TenantScopeError("A tenant ownership field cannot be renamed.");
    }
  }

  if (upsert) {
    const setOnInsert = isRecord(next.$setOnInsert) ? next.$setOnInsert : {};
    assertTenantValue(setOnInsert.tenantId, tenantId);
    next.$setOnInsert = { ...setOnInsert, tenantId };
  }
  return next as mongoose.UpdateQuery<unknown>;
}

function scopeReplacement(replacement: unknown, tenantId: mongoose.Types.ObjectId) {
  if (!isRecord(replacement)) {
    throw new TenantScopeError("A tenant-owned replacement must be an object.");
  }
  assertTenantValue(replacement.tenantId, tenantId);
  return { ...replacement, tenantId };
}

function scopeInsertedRecord(record: unknown, tenantId: mongoose.Types.ObjectId) {
  if (!isRecord(record)) throw new TenantScopeError("A tenant-owned insert must be an object.");
  assertTenantValue(record.tenantId, tenantId);
  record.tenantId = tenantId;
}

function aggregateHasUnscopedAccess(pipeline: mongoose.PipelineStage[]): boolean {
  for (const stage of pipeline) {
    if (
      "$lookup" in stage || "$graphLookup" in stage || "$unionWith" in stage ||
      "$out" in stage || "$merge" in stage || "$changeStream" in stage ||
      "$searchMeta" in stage || "$currentOp" in stage || "$collStats" in stage ||
      "$indexStats" in stage || "$planCacheStats" in stage || "$listSessions" in stage ||
      "$listLocalSessions" in stage
    ) {
      return true;
    }
    if ("$facet" in stage && isRecord(stage.$facet)) {
      for (const facetPipeline of Object.values(stage.$facet)) {
        if (Array.isArray(facetPipeline) && aggregateHasUnscopedAccess(facetPipeline as mongoose.PipelineStage[])) {
          return true;
        }
      }
    }
  }
  return false;
}

export function tenantOwnedSchemaPlugin(schema: mongoose.Schema, options: TenantOwnedPluginOptions = {}) {
  const scopedQueryOperations = [
    "find",
    "findOne",
    "count",
    "countDocuments",
    "distinct",
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findOneAndReplace",
    "findOneAndDelete",
    "replaceOne",
    "deleteOne",
    "deleteMany"
  ] as const;

  for (const operation of scopedQueryOperations) {
    schema.pre(operation as mongoose.MongooseQueryMiddleware, { document: false, query: true }, async function tenantScopeQuery(
      this: mongoose.Query<unknown, mongoose.Document>
    ) {
      if (["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "findOneAndDelete", "deleteOne", "deleteMany"].includes(operation)) {
        assertTenantWriteAllowed(operation, options);
      }
      const tenantId = await getDataAccessTenantId();
      if (!tenantId) return;

      const filter = this.getFilter();
      this.setQuery(scopeTenantFilter(filter, tenantId, this.getOptions().upsert === true));

      if (operation === "replaceOne" || operation === "findOneAndReplace") {
        this.setUpdate(scopeReplacement(this.getUpdate(), tenantId));
      } else if (["updateOne", "updateMany", "findOneAndUpdate"].includes(operation)) {
        this.setUpdate(scopedUpdate(this.getUpdate(), tenantId, this.getOptions().upsert === true));
      }
    });
  }

  schema.pre("estimatedDocumentCount", async function tenantScopeEstimatedCount() {
    if (await getDataAccessTenantId()) {
      throw new TenantScopeError("Use countDocuments so tenant ownership can be applied.");
    }
  });

  schema.pre("aggregate", async function tenantScopeAggregate() {
    const tenantId = await getDataAccessTenantId();
    if (!tenantId) return;

    const pipeline = this.pipeline();
    if (aggregateHasUnscopedAccess(pipeline)) {
      throw new TenantScopeError("Tenant-owned aggregates cannot join, union, or write outside their scoped collection.");
    }
    const firstStage = pipeline[0];
    const firstStageName = firstStage ? Object.keys(firstStage)[0] : undefined;
    const index = firstStageName && ["$geoNear", "$search", "$searchMeta", "$vectorSearch"].includes(firstStageName) ? 1 : 0;
    pipeline.splice(index, 0, { $match: { tenantId } });
  });

  schema.pre("save", async function tenantScopeSave() {
    const record = this as unknown as mongoose.Document & TenantRecord;
    assertTenantWriteAllowed("save", options, record.isNew);
    const tenantId = await getDataAccessTenantId();
    if (!tenantId) return;

    assertTenantValue(record.tenantId, tenantId);
    if (record.isNew || record.tenantId == null) record.set("tenantId", tenantId);
  });

  schema.pre("insertMany", async function tenantScopeInsertMany(records) {
    assertTenantWriteAllowed("insertMany", options, true);
    const tenantId = await getDataAccessTenantId();
    if (!tenantId) return;
    for (const record of Array.isArray(records) ? records : [records]) {
      scopeInsertedRecord(record, tenantId);
    }
  });

  schema.pre("bulkWrite", async function tenantScopeBulkWrite(operations) {
    assertTenantWriteAllowed("bulkWrite", options);
    const tenantId = await getDataAccessTenantId();
    if (!tenantId) return;

    for (const operation of operations) {
      if ("insertOne" in operation) {
        scopeInsertedRecord(operation.insertOne.document, tenantId);
      } else if ("updateOne" in operation || "updateMany" in operation) {
        const updateOperation = "updateOne" in operation ? operation.updateOne : operation.updateMany;
        updateOperation.filter = scopeTenantFilter(
          updateOperation.filter as Record<string, unknown>,
          tenantId,
          updateOperation.upsert === true
        );
        updateOperation.update = scopedUpdate(
          updateOperation.update,
          tenantId,
          updateOperation.upsert === true
        ) as typeof updateOperation.update;
      } else if ("replaceOne" in operation) {
        operation.replaceOne.filter = scopeTenantFilter(
          operation.replaceOne.filter as Record<string, unknown>,
          tenantId,
          operation.replaceOne.upsert === true
        );
        operation.replaceOne.replacement = scopeReplacement(operation.replaceOne.replacement, tenantId);
      } else if ("deleteOne" in operation || "deleteMany" in operation) {
        const deleteOperation = "deleteOne" in operation ? operation.deleteOne : operation.deleteMany;
        deleteOperation.filter = scopeTenantFilter(deleteOperation.filter as Record<string, unknown>, tenantId);
      }
    }
  });

  schema.pre("deleteOne", { document: true, query: false }, async function tenantScopeDocumentDeleteOne() {
    assertTenantWriteAllowed("deleteOne", options);
    const tenantId = await getDataAccessTenantId();
    if (!tenantId) return;

    const record = this as unknown as mongoose.Document & TenantRecord & { $where?: Record<string, unknown> };
    assertTenantValue(record.tenantId, tenantId);
    record.$where = { ...(record.$where ?? {}), tenantId };
  });
}

/** Adds the standard owner field, index, and guarded query/write middleware. */
export function addTenantOwnership(schema: mongoose.Schema, options: TenantOwnedPluginOptions = {}) {
  const tenantIdPath = schema.path("tenantId");
  if (!tenantIdPath) {
    schema.add({
      tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", immutable: true }
    });
  } else if (tenantIdPath.instance !== "ObjectId" || tenantIdPath.options.ref !== "Tenant") {
    throw new Error("Tenant-owned schemas must define tenantId as a Tenant ObjectId.");
  }

  const hasTenantIndex = schema.indexes().some(([fields]) =>
    Object.keys(fields).length === 1 && fields.tenantId === 1
  );
  if (!hasTenantIndex) schema.index({ tenantId: 1 }, { name: "tenant_id" });
  schema.plugin(tenantOwnedSchemaPlugin, options);
}
