import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import {
  hasTenantOwnership,
  invalidObjectIdReferenceFilter,
  malformedTenantOwnershipFilter,
  missingTenantEmailOutboxStatusPipeline,
  missingTenantOwnershipFilter,
  orphanReferenceDetailsPipeline,
  orphanReferenceSummaryPipeline,
  tenantOwnerParentLinks,
  tenantParentIntegrityPipeline,
  unassignedTenantOwnershipFilter,
  uniqueTenantKeyDuplicatePipeline
} from "../scripts/tenantDataAuditHelpers.js";

test("tenant data audit identifies schemas with a Tenant ObjectId owner field", () => {
  const tenantOwned = new mongoose.Schema({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant" }
  });
  const globallyOwned = new mongoose.Schema({ tenantId: { type: String } });

  assert.equal(hasTenantOwnership({ schema: tenantOwned }), true);
  assert.equal(hasTenantOwnership({ schema: globallyOwned }), false);
});

test("tenant data audit checks each present tenant owner against a Tenant record", () => {
  const requiredOwner = mongoose.model("TenantAuditRequiredOwner", new mongoose.Schema({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true }
  }));
  const legacyOwner = mongoose.model("TenantAuditLegacyOwner", new mongoose.Schema({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant" }
  }));
  const globalModel = mongoose.model("TenantAuditGlobalModel", new mongoose.Schema({ value: String }));

  assert.deepEqual(tenantOwnerParentLinks([requiredOwner, legacyOwner, globalModel]), [
    { childModel: "TenantAuditRequiredOwner", field: "tenantId", parentModel: "Tenant", required: true },
    { childModel: "TenantAuditLegacyOwner", field: "tenantId", parentModel: "Tenant", required: false }
  ]);
});

test("tenant data audit matches missing and non-ObjectId tenant owners", () => {
  assert.deepEqual(missingTenantOwnershipFilter(), {
    $expr: { $ne: [{ $type: "$tenantId" }, "objectId"] }
  });
});

test("tenant data audit separates unassigned owners from malformed owner values", () => {
  assert.deepEqual(unassignedTenantOwnershipFilter(), {
    $or: [{ tenantId: { $exists: false } }, { tenantId: null }]
  });
  assert.deepEqual(malformedTenantOwnershipFilter(), {
    $expr: {
      $and: [
        { $ne: [{ $type: "$tenantId" }, "objectId"] },
        { $ne: [{ $type: "$tenantId" }, "missing"] },
        { $ne: [{ $type: "$tenantId" }, "null"] }
      ]
    }
  });
});

test("tenant data audit reports unowned email rows by delivery status only", () => {
  assert.deepEqual(missingTenantEmailOutboxStatusPipeline(), [
    { $match: { $expr: { $ne: [{ $type: "$tenantId" }, "objectId"] } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);
});

test("tenant-local duplicate audit groups dotted compound index paths under safe aliases", () => {
  const swiftlineTenantId = new mongoose.Types.ObjectId();
  const partialFilterExpression = {
    status: { $in: ["draft", "approved"] },
    "company.registrationIdKey": { $type: "string", $gt: "" }
  };
  const pipeline = uniqueTenantKeyDuplicatePipeline(
    { tenantId: 1, "contact.email": 1, "company.registrationIdKey": 1 },
    partialFilterExpression,
    swiftlineTenantId,
    []
  );

  assert.deepEqual(pipeline[0], { $match: partialFilterExpression });
  assert.deepEqual(pipeline[1], {
    $group: {
      _id: {
        key0: { $ifNull: ["$tenantId", swiftlineTenantId] },
        key1: "$contact.email",
        key2: "$company.registrationIdKey"
      },
      count: { $sum: 1 }
    }
  });
  const group = pipeline[1];
  assert.ok(group && "$group" in group);
  assert.ok(Object.keys(group.$group._id as Record<string, unknown>).every((field) => !field.includes(".")));
  assert.deepEqual(pipeline.slice(2), [
    { $match: { count: { $gt: 1 } } },
    { $count: "duplicateGroups" }
  ]);
});

test("tenant data audit summarizes orphan references with approved lifecycle fields only", () => {
  assert.deepEqual(orphanReferenceSummaryPipeline("businessAccountId", "businessaccounts", [
    { name: "status", field: "status" },
    { name: "accepted", field: "acceptedAt", kind: "present" }
  ]), [
    { $match: { $expr: { $eq: [{ $type: "$businessAccountId" }, "objectId"] } } },
    {
      $lookup: {
        from: "businessaccounts",
        localField: "businessAccountId",
        foreignField: "_id",
        as: "_tenantAuditParent"
      }
    },
    { $match: { $expr: { $eq: [{ $size: "$_tenantAuditParent" }, 0] } } },
    {
      $group: {
        _id: {
          status: "$status",
          accepted: { $ne: [{ $ifNull: ["$acceptedAt", null] }, null] }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1 } },
    { $limit: 25 }
  ]);
});

test("tenant data audit detail mode projects only child and parent IDs plus approved lifecycle fields", () => {
  assert.deepEqual(orphanReferenceDetailsPipeline("businessAccountId", "businessaccounts", [
    { name: "status", field: "status" },
    { name: "accepted", field: "acceptedAt", kind: "present" }
  ]), [
    { $match: { $expr: { $eq: [{ $type: "$businessAccountId" }, "objectId"] } } },
    {
      $lookup: {
        from: "businessaccounts",
        localField: "businessAccountId",
        foreignField: "_id",
        as: "_tenantAuditParent"
      }
    },
    { $match: { $expr: { $eq: [{ $size: "$_tenantAuditParent" }, 0] } } },
    {
      $project: {
        _id: 1,
        missingParentId: "$businessAccountId",
        status: "$status",
        accepted: { $ne: [{ $ifNull: ["$acceptedAt", null] }, null] }
      }
    },
    { $sort: { _id: 1, missingParentId: 1 } },
    { $limit: 501 }
  ]);
});

test("tenant data audit detail mode unwinds array references before resolving missing parents", () => {
  assert.deepEqual(orphanReferenceDetailsPipeline("lineSnapshots.shipmentDraftId", "shipmentdrafts", [], "lineSnapshots"), [
    { $unwind: { path: "$lineSnapshots" } },
    { $match: { $expr: { $eq: [{ $type: "$lineSnapshots.shipmentDraftId" }, "objectId"] } } },
    {
      $lookup: {
        from: "shipmentdrafts",
        localField: "lineSnapshots.shipmentDraftId",
        foreignField: "_id",
        as: "_tenantAuditParent"
      }
    },
    { $match: { $expr: { $eq: [{ $size: "$_tenantAuditParent" }, 0] } } },
    {
      $project: {
        _id: 1,
        missingParentId: "$lineSnapshots.shipmentDraftId"
      }
    },
    { $sort: { _id: 1, missingParentId: 1 } },
    { $limit: 501 }
  ]);
});

test("tenant data audit preserves empty optional references and rejects malformed present values", () => {
  assert.deepEqual(invalidObjectIdReferenceFilter("updatedBy", false), {
    $and: [
      { updatedBy: { $exists: true, $ne: null } },
      { $expr: { $ne: [{ $type: "$updatedBy" }, "objectId"] } }
    ]
  });
  assert.deepEqual(invalidObjectIdReferenceFilter("shipmentDraftId", true), {
    $expr: { $ne: [{ $type: "$shipmentDraftId" }, "objectId"] }
  });
});

test("tenant data audit detects cross-tenant parents and shipment account or branch mismatches", () => {
  const pipeline = tenantParentIntegrityPipeline("shipmentDraftId", "shipmentdrafts", ["businessAccountId", "branchId"]);

  assert.deepEqual(pipeline[0], {
    $match: {
      $expr: { $eq: [{ $type: "$shipmentDraftId" }, "objectId"] }
    }
  });
  assert.deepEqual(pipeline[1], {
    $lookup: {
      from: "shipmentdrafts",
      localField: "shipmentDraftId",
      foreignField: "_id",
      as: "_tenantAuditParent"
    }
  });
  const groupedCounts = pipeline[3];
  assert.ok(groupedCounts && "$group" in groupedCounts);
  const group = groupedCounts.$group as Record<string, unknown>;
  assert.deepEqual(group.crossTenantParent, {
    $sum: {
      $cond: [{
        $and: [
          { $eq: [{ $type: "$tenantId" }, "objectId"] },
          { $eq: [{ $type: "$_tenantAuditParent.tenantId" }, "objectId"] },
          { $ne: ["$tenantId", "$_tenantAuditParent.tenantId"] }
        ]
      }, 1, 0]
    }
  });
  assert.deepEqual(group.identityMismatch, {
    $sum: {
      $cond: [{
        $or: [
          { $ne: [{ $type: "$businessAccountId" }, "objectId"] },
          { $ne: [{ $type: "$_tenantAuditParent.businessAccountId" }, "objectId"] },
          { $ne: ["$businessAccountId", "$_tenantAuditParent.businessAccountId"] },
          { $ne: [{ $type: "$branchId" }, "objectId"] },
          { $ne: [{ $type: "$_tenantAuditParent.branchId" }, "objectId"] },
          { $ne: ["$branchId", "$_tenantAuditParent.branchId"] }
        ]
      }, 1, 0]
    }
  });
});
