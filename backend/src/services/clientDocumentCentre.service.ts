import type { PipelineStage, Types } from "mongoose";
import { Claim } from "../models/claim.model.js";
import { ClaimDocument } from "../models/claimDocument.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { DeliveryAssignment, PodRevision } from "../models/pod.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { ShipmentSupportingDocument } from "../models/shipmentSupportingDocument.model.js";
import { getDataAccessTenantId } from "./tenantScope.service.js";
import type { ClientScope } from "../utils/clientScope.js";

export const clientDocumentTypeValues = [
  "SHIPPING_LABEL",
  "COMMERCIAL_INVOICE",
  "MANIFEST",
  "POD",
  "BILLING_INVOICE",
  "CREDIT_NOTE",
  "STATEMENT",
  "CLAIM_DOCUMENT",
  "CUSTOMS_DOCUMENT"
] as const;

export type ClientDocumentType = (typeof clientDocumentTypeValues)[number];

export const clientDocumentTypeLabels: Record<ClientDocumentType, string> = {
  SHIPPING_LABEL: "Shipping Labels",
  COMMERCIAL_INVOICE: "Commercial Invoices",
  MANIFEST: "Manifests",
  POD: "POD",
  BILLING_INVOICE: "Billing Invoices",
  CREDIT_NOTE: "Credit Notes",
  STATEMENT: "Statements",
  CLAIM_DOCUMENT: "Claim Documents",
  CUSTOMS_DOCUMENT: "Customs Documents"
};

const financialDocumentTypes = new Set<ClientDocumentType>([
  "BILLING_INVOICE",
  "CREDIT_NOTE",
  "STATEMENT"
]);

export type ClientDocumentCentreItem = {
  id: string;
  documentType: ClientDocumentType;
  documentTypeLabel: string;
  title: string;
  reference: string;
  awb: string;
  awbCount: number;
  destination: string;
  documentDate: Date;
  format: string;
  fileName: string;
  status: string;
  downloadPath: string;
  downloadMode: "BLOB" | "LABEL_ACCESS";
};

export type ClientDocumentCentreFilters = {
  documentType?: ClientDocumentType;
  awb?: string;
  destination?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  limit: number;
};

type AggregateResult = {
  items: Array<Omit<ClientDocumentCentreItem, "id" | "documentTypeLabel"> & { _id: string }>;
  metadata: Array<{ total: number }>;
};

type SuccessfulClientScope = Extract<ClientScope, { ok: true }>;
type TenantScopedClientScope = SuccessfulClientScope & { tenantId?: Types.ObjectId };

function destinationExpression(draftPath: string) {
  return {
    $trim: {
      input: {
        $concat: [
          { $ifNull: [`${draftPath}.consigneeEnteredAddress.townOrCity`, ""] },
          ", ",
          { $ifNull: [`${draftPath}.consigneeEnteredAddress.countryName`, ""] }
        ]
      },
      chars: " ,"
    }
  };
}

function trackingExpression(bookingPath: string, draftPath: string) {
  return {
    $cond: [
      { $gt: [{ $strLenCP: { $ifNull: [`${bookingPath}.swiftlineTrackingNumber`, ""] } }, 0] },
      `${bookingPath}.swiftlineTrackingNumber`,
      { $ifNull: [`${draftPath}.allocatedTrackingNumber`, ""] }
    ]
  };
}

function businessScopeMatch(scope: SuccessfulClientScope, draftPath = "") {
  const prefix = draftPath ? `${draftPath}.` : "";
  return {
    [`${prefix}businessAccountId`]: scope.businessAccountId,
    [`${prefix}branchId`]: { $in: scope.branchIds }
  };
}

function scopeMatch(scope: TenantScopedClientScope, draftPath = "") {
  const prefix = draftPath ? `${draftPath}.` : "";
  return {
    ...(scope.tenantId ? { [`${prefix}tenantId`]: scope.tenantId } : {}),
    ...businessScopeMatch(scope, draftPath)
  };
}

function union(collection: string, pipeline: Array<Record<string, unknown>>) {
  return { $unionWith: { coll: collection, pipeline } };
}

function scopedLookup(
  collection: string,
  localField: string,
  foreignField: string,
  as: string,
  match: Record<string, unknown>
) {
  return {
    $lookup: {
      from: collection,
      localField,
      foreignField,
      as,
      ...(Object.keys(match).length ? { pipeline: [{ $match: match }] } : {})
    }
  };
}

function lookupDraft(localField: string, scope: TenantScopedClientScope, as = "draft") {
  return scopedLookup(
    ShipmentDraft.collection.name,
    localField,
    "_id",
    as,
    scopeMatch(scope)
  );
}

function lookupBooking(localField: string, scope: TenantScopedClientScope, as = "booking") {
  return scopedLookup(
    DpdShipment.collection.name,
    localField,
    "shipmentDraftId",
    as,
    scope.tenantId ? { tenantId: scope.tenantId } : {}
  );
}

function lookupBookingById(localField: string, expectedDraftField: string, scope: TenantScopedClientScope) {
  return {
    $lookup: {
      from: DpdShipment.collection.name,
      localField,
      foreignField: "_id",
      as: "booking",
      let: { expectedDraftId: `$${expectedDraftField}` },
      pipeline: [
        ...(scope.tenantId ? [{ $match: { tenantId: scope.tenantId } }] : []),
        { $match: { $expr: { $eq: ["$shipmentDraftId", "$$expectedDraftId"] } } }
      ]
    }
  };
}

function commercialInvoicePipeline(scope: TenantScopedClientScope) {
  const destination = destinationExpression("$draft");
  const awb = trackingExpression("$booking", "$draft");
  return [
    { $match: { bookingState: "BOOKED", deletedAt: null, ...scopeMatch(scope) } },
    lookupBooking("_id", scope),
    { $unwind: "$booking" },
    { $match: { "booking.status": { $ne: "DPD_REJECTED" } } },
    {
      $project: {
        _id: { $concat: ["COMMERCIAL_INVOICE:", { $toString: "$_id" }] },
        documentType: { $literal: "COMMERCIAL_INVOICE" },
        title: { $literal: "Commercial Invoice" },
        reference: awb,
        awb,
        awbCount: { $literal: 1 },
        destination,
        documentDate: "$booking.createdAt",
        format: { $literal: "PDF" },
        fileName: { $concat: ["COMMERCIAL-INVOICE-", awb, ".pdf"] },
        status: { $literal: "Available" },
        downloadPath: {
          $concat: ["/api/v1/client/shipments/", { $toString: "$_id" }, "/shipment-invoice/pdf"]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: [awb],
        searchDestinations: [destination]
      }
    }
  ];
}

function shippingLabelPipeline(scope: TenantScopedClientScope) {
  const destination = destinationExpression("$draft");
  const awb = trackingExpression("$booking", "$draft");
  return [
    { $match: { voidedAt: null, ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) } },
    scopedLookup(
      DpdShipment.collection.name,
      "dpdShipmentId",
      "_id",
      "booking",
      scope.tenantId ? { tenantId: scope.tenantId } : {}
    ),
    { $unwind: "$booking" },
    lookupDraft("booking.shipmentDraftId", scope),
    { $unwind: "$draft" },
    { $match: { "draft.deletedAt": null, ...scopeMatch(scope, "draft") } },
    {
      $project: {
        _id: { $concat: ["SHIPPING_LABEL:", { $toString: "$_id" }] },
        documentType: { $literal: "SHIPPING_LABEL" },
        title: {
          $concat: [{ $cond: [{ $eq: ["$labelType", "DPD"] }, "DPD", "Swiftline"] }, " Shipping Label"]
        },
        reference: "$parcelNumber",
        awb,
        awbCount: { $literal: 1 },
        destination,
        documentDate: "$generatedAt",
        format: "$format",
        fileName: { $concat: ["LABEL-", "$parcelNumber", ".", { $toLower: "$format" }] },
        status: { $literal: "Available" },
        downloadPath: {
          $concat: [
            "/api/v1/client/shipments/",
            { $toString: "$draft._id" },
            "/labels/",
            { $toString: "$_id" },
            "/access"
          ]
        },
        downloadMode: { $literal: "LABEL_ACCESS" },
        searchAwbs: [awb, "$parcelNumber"],
        searchDestinations: [destination]
      }
    }
  ];
}

function manifestPipeline(scope: TenantScopedClientScope) {
  return [
    { $match: { ...scopeMatch(scope), manifestType: { $ne: "COMBINED" } } },
    {
      $project: {
        _id: { $concat: ["MANIFEST:", { $toString: "$_id" }] },
        documentType: { $literal: "MANIFEST" },
        title: { $literal: "Shipment Manifest" },
        reference: "$manifestNumber",
        awb: { $ifNull: [{ $arrayElemAt: ["$lineSnapshots.consignmentNumber", 0] }, ""] },
        awbCount: { $size: { $ifNull: ["$lineSnapshots", []] } },
        destination: { $ifNull: [{ $arrayElemAt: ["$lineSnapshots.destination", 0] }, "Multiple destinations"] },
        documentDate: "$generatedAt",
        format: { $literal: "PDF" },
        fileName: { $concat: ["MANIFEST-", "$manifestNumber", ".pdf"] },
        status: { $literal: "Generated" },
        downloadPath: {
          $concat: ["/api/v1/client/shipment-manifests/", { $toString: "$_id" }, "/pdf"]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: { $ifNull: ["$lineSnapshots.consignmentNumber", []] },
        searchDestinations: { $ifNull: ["$lineSnapshots.destination", []] }
      }
    }
  ];
}

function podPipeline(scope: TenantScopedClientScope) {
  const destination = destinationExpression("$draft");
  const awb = trackingExpression("$booking", "$draft");
  return [
    { $match: { status: "VERIFIED" } },
    { $unwind: "$evidence" },
    scopedLookup(DeliveryAssignment.collection.name, "assignmentId", "_id", "assignment", {
      businessAccountId: scope.businessAccountId,
      branchId: { $in: scope.branchIds }
    }),
    { $unwind: "$assignment" },
    { $match: businessScopeMatch(scope, "assignment") },
    lookupDraft("shipmentDraftId", scope),
    { $unwind: "$draft" },
    { $match: { $expr: { $eq: ["$assignment.shipmentDraftId", "$draft._id"] } } },
    lookupBookingById("assignment.dpdShipmentId", "assignment.shipmentDraftId", scope),
    { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: {
          $concat: [
            "POD:",
            { $toString: "$_id" },
            ":",
            { $toString: "$evidence._id" }
          ]
        },
        documentType: { $literal: "POD" },
        title: "$evidence.originalName",
        reference: "$assignment.partnerReference",
        awb,
        awbCount: { $literal: 1 },
        destination,
        documentDate: "$evidence.capturedAt",
        format: { $toUpper: { $arrayElemAt: [{ $split: ["$evidence.originalName", "."] }, -1] } },
        fileName: "$evidence.originalName",
        status: { $literal: "Verified" },
        downloadPath: {
          $concat: [
            "/api/v1/client/pod/assignments/",
            { $toString: "$assignment._id" },
            "/revisions/",
            { $toString: "$_id" },
            "/evidence/",
            { $toString: "$evidence._id" }
          ]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: [awb, "$assignment.partnerReference"],
        searchDestinations: [destination]
      }
    }
  ];
}

function billingInvoicePipeline(scope: TenantScopedClientScope) {
  const destination = destinationExpression("$draft");
  return [
    { $match: { status: "ISSUED", ...scopeMatch(scope) } },
    lookupDraft("shipmentDraftId", scope),
    { $unwind: "$draft" },
    lookupBookingById("dpdShipmentId", "shipmentDraftId", scope),
    { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: { $concat: ["BILLING_INVOICE:", { $toString: "$_id" }] },
        documentType: { $literal: "BILLING_INVOICE" },
        title: { $literal: "Billing Invoice" },
        reference: "$invoiceNumber",
        awb: trackingExpression("$booking", "$draft"),
        awbCount: { $literal: 1 },
        destination,
        documentDate: "$issuedAt",
        format: { $literal: "PDF" },
        fileName: { $concat: ["INVOICE-", "$invoiceNumber", ".pdf"] },
        status: "$paymentStatus",
        downloadPath: {
          $concat: ["/api/v1/client/shipments/", { $toString: "$shipmentDraftId" }, "/invoice/pdf"]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: [trackingExpression("$booking", "$draft")],
        searchDestinations: [destination]
      }
    }
  ];
}

function creditNotePipeline(scope: TenantScopedClientScope) {
  const destination = destinationExpression("$draft");
  return [
    { $match: scopeMatch(scope) },
    lookupDraft("shipmentDraftId", scope),
    { $unwind: "$draft" },
    lookupBooking("shipmentDraftId", scope),
    { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: { $concat: ["CREDIT_NOTE:", { $toString: "$_id" }] },
        documentType: { $literal: "CREDIT_NOTE" },
        title: { $literal: "Credit Note" },
        reference: "$creditNoteNumber",
        awb: trackingExpression("$booking", "$draft"),
        awbCount: { $literal: 1 },
        destination,
        documentDate: "$issuedAt",
        format: { $literal: "PDF" },
        fileName: { $concat: ["CREDIT-NOTE-", "$creditNoteNumber", ".pdf"] },
        status: { $literal: "Issued" },
        downloadPath: {
          $concat: ["/api/v1/client/shipment-cancellations/", { $toString: "$cancellationId" }, "/credit-note/pdf"]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: [trackingExpression("$booking", "$draft")],
        searchDestinations: [destination]
      }
    }
  ];
}

function statementPipeline(scope: TenantScopedClientScope) {
  return [
    { $match: { businessAccountId: scope.businessAccountId, ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) } },
    scopedLookup(
      ShipmentDraft.collection.name,
      "lines.shipmentDraftId",
      "_id",
      "drafts",
      scopeMatch(scope)
    ),
    {
      $match: {
        $expr: {
          $setIsSubset: [
            { $map: { input: "$drafts", as: "draft", in: "$$draft.branchId" } },
            scope.branchIds
          ]
        }
      }
    },
    {
      $project: {
        _id: { $concat: ["STATEMENT:", { $toString: "$_id" }] },
        documentType: { $literal: "STATEMENT" },
        title: { $literal: "Account Statement" },
        reference: "$statementNumber",
        awb: { $ifNull: [{ $arrayElemAt: ["$drafts.allocatedTrackingNumber", 0] }, ""] },
        awbCount: { $size: { $ifNull: ["$drafts", []] } },
        destination: { $ifNull: [{ $arrayElemAt: ["$drafts.consigneeEnteredAddress.countryName", 0] }, "Multiple destinations"] },
        documentDate: "$issuedAt",
        format: { $literal: "PDF" },
        fileName: { $concat: ["STATEMENT-", "$statementNumber", ".pdf"] },
        status: "$status",
        downloadPath: {
          $concat: [
            "/api/v1/client/credit/statements/",
            { $toString: "$_id" },
            "/pdf?businessAccountId=",
            { $toString: "$businessAccountId" }
          ]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: { $ifNull: ["$drafts.allocatedTrackingNumber", []] },
        searchDestinations: { $ifNull: ["$drafts.consigneeEnteredAddress.countryName", []] }
      }
    }
  ];
}

function claimDocumentPipeline(scope: TenantScopedClientScope) {
  const destination = destinationExpression("$draft");
  return [
    { $match: { deletedAt: null, visibility: "PUBLIC" } },
    scopedLookup(Claim.collection.name, "claimId", "_id", "claim", {
      businessAccountId: scope.businessAccountId,
      branchId: { $in: scope.branchIds }
    }),
    { $unwind: "$claim" },
    { $match: businessScopeMatch(scope, "claim") },
    lookupDraft("claim.shipmentDraftId", scope),
    { $unwind: "$draft" },
    lookupBooking("claim.shipmentDraftId", scope),
    { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: { $concat: ["CLAIM_DOCUMENT:", { $toString: "$_id" }] },
        documentType: { $literal: "CLAIM_DOCUMENT" },
        title: "$originalName",
        reference: { $ifNull: ["$claim.claimNumber", { $concat: ["Claim ", { $toString: "$claim._id" }] }] },
        awb: trackingExpression("$booking", "$draft"),
        awbCount: { $literal: 1 },
        destination,
        documentDate: "$createdAt",
        format: { $toUpper: { $arrayElemAt: [{ $split: ["$originalName", "."] }, -1] } },
        fileName: "$originalName",
        status: "$reviewState",
        downloadPath: {
          $concat: [
            "/api/v1/client/claims/",
            { $toString: "$claimId" },
            "/documents/",
            { $toString: "$_id" }
          ]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: [trackingExpression("$booking", "$draft")],
        searchDestinations: [destination]
      }
    }
  ];
}

function customsDocumentPipeline(scope: TenantScopedClientScope) {
  const destination = destinationExpression("$draft");
  return [
    { $match: scopeMatch(scope) },
    lookupDraft("shipmentDraftId", scope),
    { $unwind: "$draft" },
    lookupBooking("shipmentDraftId", scope),
    { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: { $concat: ["CUSTOMS_DOCUMENT:", { $toString: "$_id" }] },
        documentType: { $literal: "CUSTOMS_DOCUMENT" },
        title: "$originalName",
        reference: "$documentType",
        awb: trackingExpression("$booking", "$draft"),
        awbCount: { $literal: 1 },
        destination,
        documentDate: "$createdAt",
        format: { $toUpper: { $arrayElemAt: [{ $split: ["$originalName", "."] }, -1] } },
        fileName: "$originalName",
        status: { $literal: "Uploaded" },
        downloadPath: {
          $concat: [
            "/api/v1/client/shipments/",
            { $toString: "$shipmentDraftId" },
            "/documents/",
            { $toString: "$_id" }
          ]
        },
        downloadMode: { $literal: "BLOB" },
        searchAwbs: [trackingExpression("$booking", "$draft")],
        searchDestinations: [destination]
      }
    }
  ];
}

const sourcePipelines: Record<
  ClientDocumentType,
  (scope: TenantScopedClientScope) => Array<Record<string, unknown>>
> = {
  SHIPPING_LABEL: shippingLabelPipeline,
  COMMERCIAL_INVOICE: commercialInvoicePipeline,
  MANIFEST: manifestPipeline,
  POD: podPipeline,
  BILLING_INVOICE: billingInvoicePipeline,
  CREDIT_NOTE: creditNotePipeline,
  STATEMENT: statementPipeline,
  CLAIM_DOCUMENT: claimDocumentPipeline,
  CUSTOMS_DOCUMENT: customsDocumentPipeline
};

const sourceCollections: Record<ClientDocumentType, string> = {
  SHIPPING_LABEL: LabelDocument.collection.name,
  COMMERCIAL_INVOICE: ShipmentDraft.collection.name,
  MANIFEST: ShipmentManifest.collection.name,
  POD: PodRevision.collection.name,
  BILLING_INVOICE: ShipmentInvoice.collection.name,
  CREDIT_NOTE: ShipmentCreditNote.collection.name,
  STATEMENT: CreditBillingStatement.collection.name,
  CLAIM_DOCUMENT: ClaimDocument.collection.name,
  CUSTOMS_DOCUMENT: ShipmentSupportingDocument.collection.name
};

export function availableClientDocumentTypes(canViewFinancials: boolean) {
  return clientDocumentTypeValues
    .filter((type) => canViewFinancials || !financialDocumentTypes.has(type))
    .map((value) => ({ value, label: clientDocumentTypeLabels[value] }));
}

export async function listClientDocumentCentre(
  scope: SuccessfulClientScope,
  filters: ClientDocumentCentreFilters
) {
  const availableTypes = availableClientDocumentTypes(scope.canViewFinancials);
  const tenantId = await getDataAccessTenantId();
  const pipeline = buildClientDocumentCentrePipeline(scope, filters, tenantId ?? undefined);

  // This cross-collection aggregation is intentionally run on the native
  // collection after each tenant-owned union and join has received an explicit
  // tenant filter. The model-level aggregate guard correctly rejects arbitrary
  // joins because it cannot prove their ownership boundaries.
  const [result] = await ShipmentDraft.collection
    .aggregate<AggregateResult>(pipeline as unknown as PipelineStage[], { allowDiskUse: true })
    .toArray();
  const total = result?.metadata[0]?.total ?? 0;
  const items = (result?.items ?? []).map(({ _id, ...item }) => ({
    ...item,
    id: String(_id),
    documentTypeLabel: clientDocumentTypeLabels[item.documentType]
  }));

  return {
    items,
    documentTypes: availableTypes,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / filters.limit))
    }
  };
}

export function buildClientDocumentCentrePipeline(
  scope: SuccessfulClientScope,
  filters: ClientDocumentCentreFilters,
  tenantId?: Types.ObjectId
) {
  const scopedScope: TenantScopedClientScope = { ...scope, ...(tenantId ? { tenantId } : {}) };
  const availableTypes = availableClientDocumentTypes(scope.canViewFinancials);
  const allowed = new Set(availableTypes.map((item) => item.value));
  const selectedTypes = filters.documentType
    ? (allowed.has(filters.documentType) ? [filters.documentType] : [])
    : availableTypes.map((item) => item.value);

  const pipeline: Array<Record<string, unknown>> = [
    { $match: { _id: { $exists: false } } },
    {
      $project: {
        _id: 1,
        documentType: 1,
        title: 1,
        reference: 1,
        awb: 1,
        awbCount: 1,
        destination: 1,
        documentDate: 1,
        format: 1,
        fileName: 1,
        status: 1,
        downloadPath: 1,
        downloadMode: 1,
        searchAwbs: 1,
        searchDestinations: 1
      }
    }
  ];

  for (const type of selectedTypes) {
    pipeline.push(union(sourceCollections[type], sourcePipelines[type](scopedScope)));
  }

  const match: Record<string, unknown> = {};
  if (filters.dateFrom || filters.dateTo) {
    match.documentDate = {
      ...(filters.dateFrom ? { $gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { $lte: filters.dateTo } : {})
    };
  }
  if (filters.awb) match.searchAwbs = { $regex: filters.awb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (filters.destination) match.searchDestinations = { $regex: filters.destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (Object.keys(match).length) pipeline.push({ $match: match });

  pipeline.push(
    { $sort: { documentDate: -1, _id: 1 } },
    {
      $facet: {
        items: [
          { $skip: (filters.page - 1) * filters.limit },
          { $limit: filters.limit },
          { $project: { searchAwbs: 0, searchDestinations: 0 } }
        ],
        metadata: [{ $count: "total" }]
      }
    }
  );

  return pipeline;
}
