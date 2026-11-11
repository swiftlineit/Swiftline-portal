import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import {
  assertExpectedDatabaseName,
  assertNonProductionEnvironment,
  assertProductionTenantAuditTarget,
  isMainModule
} from "./migrationSafety.js";
import { tenantScopedUniqueIndexes } from "./tenantIdentityIndexMigration.js";
import { accountCreditTenantOwnershipModelNames } from "./migrateAccountCreditTenantOwnership.js";
import { operationalTenantOwnershipModelNames } from "./migrateOperationalTenantOwnership.js";
import { shipmentTenantOwnershipModelNames } from "./migrateShipmentTenantOwnership.js";
import {
  approvedOrphanReferenceException,
  classifyApprovedOrphanReferenceException,
  hasTenantOwnership,
  invalidObjectIdReferenceFilter,
  missingTenantEmailOutboxStatusPipeline,
  missingTenantOwnershipFilter,
  malformedTenantOwnershipFilter,
  orphanReferenceDetailsPipeline,
  orphanReferenceSummaryPipeline,
  unassignedTenantOwnershipFilter,
  type OrphanSummaryDimension,
  tenantOwnerParentLinks,
  tenantParentIntegrityPipeline,
  uniqueTenantKeyDuplicatePipeline
} from "./tenantDataAuditHelpers.js";

type ParentLink = {
  childModel: string;
  field: string;
  parentModel: string;
  /** The field is an array of parent IDs rather than one parent ID. */
  array?: boolean;
  /** The field is stored inside each object in this child document array. */
  nestedArray?: string;
  /** Optional parent references are checked only when a value is present. */
  required?: boolean;
  /** Fields that must remain identical to the shipment draft's account/branch. */
  identityFields?: string[];
};

const parentLinks: ParentLink[] = [
  { childModel: "TenantMembership", field: "assignedBranches", parentModel: "Branch", array: true, required: false },
  { childModel: "BusinessAccountMember", field: "businessAccount", parentModel: "BusinessAccount" },
  { childModel: "BusinessAccountMember", field: "user", parentModel: "User" },
  { childModel: "BusinessAccountMember", field: "assignedBranches", parentModel: "Branch", array: true, required: false },
  { childModel: "BusinessAccount", field: "assignedBranch", parentModel: "Branch", required: false },
  { childModel: "BusinessAccountInvitation", field: "user", parentModel: "User" },
  { childModel: "BusinessAccountInvitation", field: "businessAccount", parentModel: "BusinessAccount" },
  { childModel: "BusinessAccountInvitation", field: "member", parentModel: "BusinessAccountMember" },
  { childModel: "OperatorClientInvitation", field: "userId", parentModel: "User" },
  { childModel: "OperatorClientInvitation", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "OperatorClientInvitation", field: "memberId", parentModel: "BusinessAccountMember" },
  { childModel: "EmailOutbox", field: "recipientUserId", parentModel: "User", required: false },
  { childModel: "EmailOutbox", field: "businessAccountId", parentModel: "BusinessAccount", required: false },
  { childModel: "AddressBookEntry", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "AddressBookEntry", field: "createdBy", parentModel: "User" },
  { childModel: "AddressBookEntry", field: "updatedBy", parentModel: "User" },
  { childModel: "ShipmentDraft", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentDraft", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentDraft", field: "shipmentImportEntryId", parentModel: "ShipmentImportEntry", required: false },
  { childModel: "ShipmentDraft", field: "rebookedFromDraftId", parentModel: "ShipmentDraft", required: false },
  { childModel: "ShipmentDraft", field: "shipmentManifestAssignments.clientAccountManifestId", parentModel: "ShipmentManifest", required: false },
  { childModel: "ShipmentDraft", field: "shipmentManifestAssignments.staffAccountManifestId", parentModel: "ShipmentManifest", required: false },
  { childModel: "ShipmentDraft", field: "shipmentManifestAssignments.staffCombinedManifestId", parentModel: "ShipmentManifest", required: false },
  { childModel: "DpdShipment", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "OperatorShipmentTrackingCounter", field: "branchId", parentModel: "Branch" },
  { childModel: "OperatorCounterPayment", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["branchId"] },
  { childModel: "OperatorCounterPayment", field: "branchId", parentModel: "Branch" },
  { childModel: "OperatorCounterPayment", field: "recordedBy", parentModel: "User" },
  { childModel: "BalanceReservation", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "BalanceReservation", field: "branchId", parentModel: "Branch" },
  { childModel: "BalanceReservation", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentInvoice", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentInvoice", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "ShipmentInvoice", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentInvoice", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentInvoice", field: "billingStatementId", parentModel: "CreditBillingStatement", required: false },
  { childModel: "LabelDocument", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "ShipmentEvent", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "ShipmentEvent", field: "dpdShipmentId", parentModel: "DpdShipment", required: false },
  { childModel: "ShipmentCharge", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentCharge", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentCharge", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentCharge", field: "dpdShipmentId", parentModel: "DpdShipment", required: false },
  { childModel: "ShipmentCharge", field: "balanceReservationId", parentModel: "BalanceReservation", required: false },
  { childModel: "ShipmentChargeVerification", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentChargeVerification", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "ShipmentChargeVerification", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentChargeVerification", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentAmendment", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentAmendment", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "ShipmentAmendment", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentAmendment", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentCancellation", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentCancellation", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "ShipmentCancellation", field: "shipmentInvoiceId", parentModel: "ShipmentInvoice" },
  { childModel: "ShipmentCancellation", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentCancellation", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentCancellation", field: "creditNoteId", parentModel: "ShipmentCreditNote", required: false },
  { childModel: "ShipmentCancellation", field: "cancellationFeeInvoiceId", parentModel: "CancellationFeeInvoice", required: false },
  { childModel: "ShipmentCreditNote", field: "cancellationId", parentModel: "ShipmentCancellation" },
  { childModel: "ShipmentCreditNote", field: "shipmentInvoiceId", parentModel: "ShipmentInvoice" },
  { childModel: "ShipmentCreditNote", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentCreditNote", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentCreditNote", field: "branchId", parentModel: "Branch" },
  { childModel: "CancellationFeeInvoice", field: "cancellationId", parentModel: "ShipmentCancellation" },
  { childModel: "CancellationFeeInvoice", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "CancellationFeeInvoice", field: "billingStatementId", parentModel: "CreditBillingStatement", required: false },
  { childModel: "CancellationFeeInvoice", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CancellationFeeInvoice", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentSupportingDocument", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentSupportingDocument", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentSupportingDocument", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentInvoiceRevisedDocument", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "ShipmentProfitability", field: "shipmentDraftId", parentModel: "ShipmentDraft", identityFields: ["businessAccountId", "branchId"] },
  { childModel: "ShipmentProfitability", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "ShipmentProfitability", field: "shipmentInvoiceId", parentModel: "ShipmentInvoice" },
  { childModel: "ShipmentProfitability", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentProfitability", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentOperationsParcelScan", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "ShipmentOperationsParcelScan", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "CarrierTrackingSync", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "CarrierTrackingSync", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "CarrierTrackingEvent", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "CarrierTrackingEvent", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "CounterPayment", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "CounterPayment", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentQuote", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentQuote", field: "branchId", parentModel: "Branch" },
  { childModel: "CountryRateCard", field: "businessAccountId", parentModel: "BusinessAccount", required: false },
  { childModel: "ShipmentImportBatch", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "ShipmentImportBatch", field: "branchId", parentModel: "Branch" },
  { childModel: "ShipmentImportEntry", field: "batchId", parentModel: "ShipmentImportBatch" },
  { childModel: "ShipmentImportEntry", field: "shipmentDraftId", parentModel: "ShipmentDraft", required: false },
  { childModel: "PublicShipmentPayment", field: "bookingId", parentModel: "PublicShipmentBooking" },
  { childModel: "PublicShipmentPayment", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "PublicShipmentPayment", field: "branchId", parentModel: "Branch" },
  { childModel: "PickupRequestShipment", field: "pickupRequestId", parentModel: "PickupRequest" },
  { childModel: "PickupRequestShipment", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "PickupRequestShipment", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "ShipmentManifest", field: "shipmentDraftIds", parentModel: "ShipmentDraft", array: true },
  { childModel: "ShipmentManifest", field: "businessAccountId", parentModel: "BusinessAccount", required: false },
  { childModel: "ShipmentManifest", field: "businessAccountIds", parentModel: "BusinessAccount", array: true, required: false },
  { childModel: "ShipmentManifest", field: "lineSnapshots.shipmentDraftId", parentModel: "ShipmentDraft", nestedArray: "lineSnapshots" },
  { childModel: "ShipmentManifest", field: "lineSnapshots.dpdShipmentId", parentModel: "DpdShipment", nestedArray: "lineSnapshots" },
  { childModel: "ShipmentManifest", field: "branchId", parentModel: "Branch" },
  { childModel: "DeliveryAssignment", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "DeliveryAssignment", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "DeliveryAssignment", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "DeliveryAssignment", field: "branchId", parentModel: "Branch" },
  { childModel: "PodRevision", field: "assignmentId", parentModel: "DeliveryAssignment" },
  { childModel: "PodRevision", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "PodDispute", field: "assignmentId", parentModel: "DeliveryAssignment" },
  { childModel: "PodDispute", field: "podRevisionId", parentModel: "PodRevision" },
  { childModel: "PodDispute", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "PodDispute", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "OperationsManifestConsignment", field: "manifestId", parentModel: "OperationsManifest" },
  { childModel: "OperationsManifestConsignment", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "OperationsManifestConsignment", field: "dpdShipmentId", parentModel: "DpdShipment" },
  { childModel: "OperationsManifestConsignment", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "OperationsManifestBag", field: "manifestId", parentModel: "OperationsManifest" },
  { childModel: "OperationsManifestScan", field: "manifestId", parentModel: "OperationsManifest" },
  { childModel: "OperationsManifestScanSession", field: "manifestId", parentModel: "OperationsManifest" },
  { childModel: "OperationsManifestScanSession", field: "branchId", parentModel: "Branch" },
  { childModel: "BusinessCreditAccount", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "BusinessCreditAccount", field: "requestedBy", parentModel: "User", required: false },
  { childModel: "BusinessCreditAccount", field: "assignedFinanceApprover", parentModel: "User", required: false },
  { childModel: "BusinessCreditAccount", field: "reviewedBy", parentModel: "User", required: false },
  { childModel: "BusinessCreditAccount", field: "activatedBy", parentModel: "User", required: false },
  { childModel: "CreditLedgerEntry", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditLedgerEntry", field: "creditAccountId", parentModel: "BusinessCreditAccount" },
  { childModel: "CreditLedgerEntry", field: "createdBy", parentModel: "User", required: false },
  { childModel: "CreditPayment", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditPayment", field: "creditAccountId", parentModel: "BusinessCreditAccount" },
  { childModel: "CreditPayment", field: "requestedStatementId", parentModel: "CreditBillingStatement", required: false },
  { childModel: "CreditPayment", field: "submittedBy", parentModel: "User" },
  { childModel: "CreditPayment", field: "verifiedBy", parentModel: "User", required: false },
  { childModel: "CreditPayment", field: "allocations.statementId", parentModel: "CreditBillingStatement", nestedArray: "allocations" },
  { childModel: "CreditPayment", field: "allocations.invoiceAllocations.shipmentInvoiceId", parentModel: "ShipmentInvoice", nestedArray: "allocations.invoiceAllocations", required: false },
  { childModel: "CreditPayment", field: "allocations.invoiceAllocations.cancellationFeeInvoiceId", parentModel: "CancellationFeeInvoice", nestedArray: "allocations.invoiceAllocations", required: false },
  { childModel: "CreditBillingStatement", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditBillingStatement", field: "creditAccountId", parentModel: "BusinessCreditAccount" },
  { childModel: "CreditBillingStatement", field: "createdBy", parentModel: "User" },
  { childModel: "CreditBillingStatement", field: "lines.shipmentDraftId", parentModel: "ShipmentDraft", nestedArray: "lines" },
  { childModel: "CreditBillingStatement", field: "lines.shipmentInvoiceId", parentModel: "ShipmentInvoice", nestedArray: "lines", required: false },
  { childModel: "CreditBillingStatement", field: "lines.cancellationFeeInvoiceId", parentModel: "CancellationFeeInvoice", nestedArray: "lines", required: false },
  { childModel: "CreditBillingStatement", field: "adjustments.adjustmentId", parentModel: "CreditBillingAdjustment", nestedArray: "adjustments" },
  { childModel: "CreditBillingStatement", field: "adjustments.shipmentInvoiceId", parentModel: "ShipmentInvoice", nestedArray: "adjustments" },
  { childModel: "CreditBillingStatement", field: "adjustments.originalStatementId", parentModel: "CreditBillingStatement", nestedArray: "adjustments" },
  { childModel: "CreditBillingAdjustment", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditBillingAdjustment", field: "creditAccountId", parentModel: "BusinessCreditAccount" },
  { childModel: "CreditBillingAdjustment", field: "shipmentInvoiceId", parentModel: "ShipmentInvoice" },
  { childModel: "CreditBillingAdjustment", field: "originalStatementId", parentModel: "CreditBillingStatement" },
  { childModel: "CreditBillingAdjustment", field: "billingStatementId", parentModel: "CreditBillingStatement", required: false },
  { childModel: "CreditAgreement", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditAgreement", field: "creditAccountId", parentModel: "BusinessCreditAccount" },
  { childModel: "CreditAgreement", field: "createdBy", parentModel: "User" },
  { childModel: "CreditAgreement", field: "updatedBy", parentModel: "User", required: false },
  { childModel: "CreditAgreement", field: "signer.userId", parentModel: "User", required: false },
  { childModel: "CreditAgreementCounter", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditLimitHistory", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditLimitHistory", field: "creditAccountId", parentModel: "BusinessCreditAccount" },
  { childModel: "CreditLimitHistory", field: "changedBy", parentModel: "User" },
  { childModel: "CreditLimitIncreaseRequest", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "CreditLimitIncreaseRequest", field: "creditAccountId", parentModel: "BusinessCreditAccount" },
  { childModel: "CreditLimitIncreaseRequest", field: "requestedBy", parentModel: "User" },
  { childModel: "CreditLimitIncreaseRequest", field: "reviewedBy", parentModel: "User", required: false },
  { childModel: "PaymentTermsAcceptance", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "PaymentTermsAcceptance", field: "userId", parentModel: "User" },
  { childModel: "PortalNotification", field: "businessAccountId", parentModel: "BusinessAccount", required: false },
  { childModel: "Claim", field: "businessAccountId", parentModel: "BusinessAccount" },
  { childModel: "Claim", field: "branchId", parentModel: "Branch" },
  { childModel: "Claim", field: "shipmentDraftId", parentModel: "ShipmentDraft" },
  { childModel: "SupportTicket", field: "businessAccountId", parentModel: "BusinessAccount" }
];

const orphanSummaryFields: Record<string, Array<OrphanSummaryDimension>> = {
  BusinessAccountMember: [
    { name: "role", field: "role" },
    { name: "status", field: "status" }
  ],
  BusinessAccountInvitation: [
    { name: "accepted", field: "acceptedAt", kind: "present" },
    { name: "revoked", field: "revokedAt", kind: "present" }
  ],
  EmailOutbox: [
    { name: "category", field: "category" },
    { name: "status", field: "status" }
  ],
  AddressBookEntry: [
    { name: "type", field: "type" },
    { name: "validationStatus", field: "validationStatus" },
    { name: "deleted", field: "deletedAt", kind: "present" }
  ],
  ShipmentDraft: [
    { name: "status", field: "status" },
    { name: "bookingState", field: "bookingState" },
    { name: "deleted", field: "deletedAt", kind: "present" }
  ],
  BalanceReservation: [{ name: "status", field: "status" }],
  ShipmentInvoice: [
    { name: "status", field: "status" },
    { name: "paymentStatus", field: "paymentStatus" }
  ],
  ShipmentCharge: [
    { name: "chargeStatus", field: "customerChargeStatus" },
    { name: "paymentSource", field: "paymentSource" }
  ],
  BusinessCreditAccount: [{ name: "status", field: "status" }],
  CreditLedgerEntry: [{ name: "type", field: "type" }],
  CreditPayment: [{ name: "status", field: "status" }],
  CreditBillingStatement: [{ name: "status", field: "status" }],
  CreditAgreement: [{ name: "status", field: "status" }],
  SupportTicket: [
    { name: "category", field: "category" },
    { name: "priority", field: "priority" },
    { name: "status", field: "status" }
  ]
};

type ValidatedOrphanSummaryDimension = OrphanSummaryDimension & { allowedValues?: Set<string> };

function validateOrphanSummaryDimensions(modelName: string): ValidatedOrphanSummaryDimension[] {
  const model = mongoose.model(modelName);
  return (orphanSummaryFields[modelName] ?? []).map((dimension) => {
    const schemaPath = model.schema.path(dimension.field);
    if (!schemaPath) throw new Error(`Orphan summary field no longer matches the schema: ${modelName}.${dimension.field}.`);

    if (dimension.kind === "present") {
      if (schemaPath.instance !== "Date") {
        throw new Error(`Orphan summary presence field must be a date: ${modelName}.${dimension.field}.`);
      }
      return dimension;
    }

    const enumOption = schemaPath.options.enum as unknown;
    const values = Array.isArray(enumOption)
      ? enumOption
      : typeof enumOption === "object" && enumOption !== null && "values" in enumOption
        ? (enumOption as { values?: unknown }).values
        : undefined;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      throw new Error(`Orphan summary enum field no longer has a string enum: ${modelName}.${dimension.field}.`);
    }
    return { ...dimension, allowedValues: new Set(values) };
  });
}

async function readOrphanSummary(
  link: ParentLink,
  dimensions: ValidatedOrphanSummaryDimension[],
  excludedOrphanMatch?: Record<string, unknown>
) {
  if (!dimensions.length) return [];
  const child = mongoose.model(link.childModel);
  const parent = mongoose.model(link.parentModel);
  const rows = await child.collection.aggregate<{
    _id: Record<string, string | boolean | null>;
    count: number;
  }>(
    orphanReferenceSummaryPipeline(
      link.field,
      parent.collection.collectionName,
      dimensions,
      excludedOrphanMatch
    ),
    { maxTimeMS: 60_000 }
  ).toArray();

  return rows.map((row) => ({
    values: Object.fromEntries(dimensions.map((dimension) => {
      const value = row._id?.[dimension.name];
      if (dimension.kind === "present") return [dimension.name, value === true ? "yes" : "no"];
      if (typeof value !== "string") return [dimension.name, "<missing>"];
      return [dimension.name, dimension.allowedValues?.has(value) ? value : "<invalid-enum>"];
    })),
    count: row.count
  }));
}

const maximumOrphanDetailRows = 500;

async function readOrphanDetails(
  link: ParentLink,
  dimensions: ValidatedOrphanSummaryDimension[],
  excludedOrphanMatch?: Record<string, unknown>
) {
  const child = mongoose.model(link.childModel);
  const parent = mongoose.model(link.parentModel);
  const rows = await child.collection.aggregate<Record<string, unknown>>(
    orphanReferenceDetailsPipeline(
      link.field,
      parent.collection.collectionName,
      dimensions,
      link.array || link.nestedArray ? link.nestedArray ?? link.field : undefined,
      excludedOrphanMatch
    ),
    { maxTimeMS: 60_000 }
  ).toArray();

  if (rows.length > maximumOrphanDetailRows) {
    throw new Error(`Orphan detail output exceeded ${maximumOrphanDetailRows} rows for ${link.childModel}.${link.field}; narrow the review before requesting record identifiers.`);
  }

  return rows.map((row) => ({
    childId: row._id instanceof mongoose.Types.ObjectId ? row._id.toString() : "<invalid-id>",
    missingParentId: row.missingParentId instanceof mongoose.Types.ObjectId
      ? row.missingParentId.toString()
      : "<invalid-id>",
    lifecycle: Object.fromEntries(dimensions.map((dimension) => {
      const value = row[dimension.name];
      if (dimension.kind === "present") return [dimension.name, value === true ? "yes" : "no"];
      if (typeof value !== "string") return [dimension.name, "<missing>"];
      return [dimension.name, dimension.allowedValues?.has(value) ? value : "<invalid-enum>"];
    }))
  }));
}

function expectedDatabaseName(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--database" || !args[1]?.trim()) {
    throw new Error("Usage: npm run audit:tenant-data -- --database <expected-database-name> [--orphan-summary] [--orphan-details]");
  }
  return args[1].trim();
}

function indexEquivalent(
  existing: { key?: Record<string, unknown>; unique?: boolean; partialFilterExpression?: Record<string, unknown> },
  expectedKey: Record<string, number>,
  expectedOptions: { unique?: unknown; partialFilterExpression?: Record<string, unknown> }
) {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (typeof value !== "object" || value === null) return JSON.stringify(value);
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  };
  const sameKey = Boolean(existing.key) && Object.keys(existing.key!).length === Object.keys(expectedKey).length &&
    Object.entries(expectedKey).every(([field, direction], index) =>
      Object.entries(existing.key!)[index]?.[0] === field && Object.entries(existing.key!)[index]?.[1] === direction
    );
  return sameKey && Boolean(existing.unique) === (expectedOptions.unique === true) &&
    stable(existing.partialFilterExpression ?? {}) === stable(expectedOptions.partialFilterExpression ?? {});
}

const fullIndexAuditModels = new Set([
  "Tenant",
  "TenantSlug",
  "TenantMembership",
  "OperatorInvitation",
  "OperatorClientInvitation",
  "OperatorShipmentTrackingCounter",
  "OperatorContactQuery",
  "OperatorSupportSession",
  "OperatorCounterPayment",
  "FeatureAnnouncement",
  "FeatureAnnouncementView"
]);

const preActivationBackfillModels = new Set([
  "BusinessAccount",
  "Branch",
  ...accountCreditTenantOwnershipModelNames,
  ...operationalTenantOwnershipModelNames,
  ...shipmentTenantOwnershipModelNames
]);

function migrationExpectedIndexes(model: mongoose.Model<any>) {
  const schemaIndexes = model.schema.indexes() as Array<[Record<string, number>, mongoose.IndexOptions]>;
  if (fullIndexAuditModels.has(model.modelName)) return schemaIndexes;
  if (!hasTenantOwnership(model)) return [];
  return schemaIndexes.filter(([key, options]) =>
    key.tenantId === 1 && (Object.keys(key).length === 1 || options.unique === true)
  );
}

async function importModels() {
  const modelDirectory = path.resolve("src/models");
  const files = fs.readdirSync(modelDirectory)
    .filter((file) => file.endsWith(".model.ts"))
    .sort();
  for (const file of files) {
    await import(pathToFileURL(path.join(modelDirectory, file)).href);
  }
}

async function countOrphans(
  link: ParentLink,
  existingCollections: Set<string>
): Promise<{
  danglingParent: number;
  missingOrInvalidReference: number;
  crossTenantParent: number;
  identityMismatch: number;
  acceptedDanglingParent: number;
  rejectedExceptionCandidates: number;
  acceptedExceptionCode?: string;
}> {
  const child = mongoose.model(link.childModel);
  const parent = mongoose.model(link.parentModel);
  const schemaPath = child.schema.path(link.field);
  const arrayElement = schemaPath && link.array && Array.isArray(schemaPath.options.type)
    ? schemaPath.options.type[0] as { ref?: string; required?: boolean } | undefined
    : undefined;
  const expectedRequired = link.required ?? true;
  const nestedArrayPath = link.nestedArray ? child.schema.path(link.nestedArray) : undefined;
  const validSchemaLink = link.array
    ? schemaPath?.instance === "Array"
      && arrayElement?.ref === parent.modelName
      && Boolean(arrayElement.required) === expectedRequired
    : schemaPath?.options.ref === parent.modelName
      && Boolean(schemaPath.options.required) === expectedRequired
      && (!link.nestedArray || nestedArrayPath?.instance === "Array");
  if (!validSchemaLink) {
    throw new Error(`Reviewed parent link no longer matches the schema: ${link.childModel}.${link.field}.`);
  }
  const validIdentityFields = (link.identityFields ?? []).every((field) => {
    const childField = child.schema.path(field);
    const parentField = parent.schema.path(field);
    return childField?.instance === "ObjectId"
      && parentField?.instance === "ObjectId"
      && childField.options.ref === parentField.options.ref
      && Boolean(childField.options.required)
      && Boolean(parentField.options.required);
  });
  if (!validIdentityFields) {
    throw new Error(`Reviewed shipment identity fields no longer match the schemas: ${link.childModel} -> ${link.parentModel}.`);
  }
  const compareTenantOwners = hasTenantOwnership(child) && hasTenantOwnership(parent);
  const compareParentIdentity = Boolean(link.identityFields?.length);
  if (!existingCollections.has(child.collection.collectionName)) {
    return {
      danglingParent: 0,
      missingOrInvalidReference: 0,
      crossTenantParent: 0,
      identityMismatch: 0,
      acceptedDanglingParent: 0,
      rejectedExceptionCandidates: 0
    };
  }

  const invalidReferenceMatch = invalidObjectIdReferenceFilter(link.field, expectedRequired);
  const approvedException = approvedOrphanReferenceException(link.childModel, link.field);
  const missingParentStages = [
    { $match: { [link.field]: { $type: "objectId" } } },
    {
      $lookup: {
        from: parent.collection.collectionName,
        localField: link.field,
        foreignField: "_id",
        as: "_tenantAuditParent"
      }
    },
    { $match: { $expr: { $eq: [{ $size: "$_tenantAuditParent" }, 0] } } }
  ];
  const pipeline = [
    ...(link.array || link.nestedArray
      ? [{ $unwind: { path: `$${link.nestedArray ?? link.field}`, preserveNullAndEmptyArrays: Boolean(link.array && expectedRequired) } }]
      : []),
    {
      $facet: {
        dangling: [
          ...missingParentStages,
          ...(approvedException ? [{ $match: { $nor: [approvedException.match] } }] : []),
          { $count: "count" }
        ],
        ...(approvedException
          ? {
              approvedException: [
                ...missingParentStages,
                { $match: approvedException.match },
                {
                  $group: {
                    _id: null,
                    count: { $sum: 1 },
                    references: { $addToSet: `$${link.field}` }
                  }
                },
                {
                  $project: {
                    _id: 0,
                    count: 1,
                    distinctReferenceCount: { $size: "$references" }
                  }
                }
              ]
            }
          : {}),
        invalid: [
          { $match: invalidReferenceMatch },
          { $count: "count" }
        ],
        ...(compareTenantOwners || compareParentIdentity
          ? {
              parentIntegrity: tenantParentIntegrityPipeline(
                link.field,
                parent.collection.collectionName,
                link.identityFields
              )
            }
          : {})
      }
    }
  ];
  const rows = await child.collection.aggregate(pipeline, { maxTimeMS: 60_000 }).toArray();
  const results = rows[0] as {
    dangling?: Array<{ count: number }>;
    invalid?: Array<{ count: number }>;
    parentIntegrity?: Array<{ crossTenantParent?: number; identityMismatch?: number }>;
    approvedException?: Array<{ count?: number; distinctReferenceCount?: number }>;
  } | undefined;
  const exceptionCandidateCount = Number(results?.approvedException?.[0]?.count ?? 0);
  const exceptionDistinctReferenceCount = Number(results?.approvedException?.[0]?.distinctReferenceCount ?? 0);
  const exceptionClassification = approvedException
    ? classifyApprovedOrphanReferenceException(
        approvedException,
        exceptionCandidateCount,
        exceptionDistinctReferenceCount
      )
    : { acceptedCount: 0, rejectedCount: 0 };
  return {
    danglingParent: Number(results?.dangling?.[0]?.count ?? 0) + exceptionClassification.rejectedCount,
    missingOrInvalidReference: Number(results?.invalid?.[0]?.count ?? 0),
    crossTenantParent: Number(results?.parentIntegrity?.[0]?.crossTenantParent ?? 0),
    identityMismatch: Number(results?.parentIntegrity?.[0]?.identityMismatch ?? 0),
    acceptedDanglingParent: exceptionClassification.acceptedCount,
    rejectedExceptionCandidates: exceptionClassification.rejectedCount,
    acceptedExceptionCode: exceptionClassification.acceptedCount > 0 ? approvedException?.code : undefined
  };
}

async function run(
  args = process.argv.slice(2),
  configuredMongoUri?: string
): Promise<{ hasFindings: boolean; blockingFindings: string[] }> {
  const productionSafe = args.includes("--production-safe");
  const clusterIndex = args.indexOf("--cluster-host");
  const expectedClusterHost = clusterIndex >= 0 ? args[clusterIndex + 1] ?? "" : "";
  const selectedMongoUri = configuredMongoUri ?? (productionSafe ? tenantMigrationEnv.auditMongoUri : tenantMigrationEnv.applicationMongoUri);
  if (productionSafe) {
    if (tenantMigrationEnv.nodeEnvironment !== "production") throw new Error("--production-safe requires NODE_ENV=production.");
    if (!selectedMongoUri) throw new Error("TENANT_AUDIT_MONGODB_URI is required and must use a read-only database user.");
  } else {
    assertNonProductionEnvironment(tenantMigrationEnv.nodeEnvironment, "Tenant data audit");
    if (!selectedMongoUri) throw new Error("MONGODB_URI is required for a tenant data audit.");
  }
  const includeOrphanSummary = args.includes("--orphan-summary");
  const includeOrphanDetails = args.includes("--orphan-details");
  const databaseArgs = args.filter((argument, index) =>
    argument !== "--orphan-summary" && argument !== "--orphan-details" && argument !== "--production-safe" &&
    !(argument === "--cluster-host" || (clusterIndex >= 0 && index === clusterIndex + 1))
  );
  if (productionSafe && includeOrphanDetails) {
    throw new Error("Production-safe audit does not permit orphan detail output; use aggregate-only results.");
  }
  if (productionSafe) {
    assertProductionTenantAuditTarget({
      nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
      expectedDatabase: databaseArgs[1] ?? "",
      expectedClusterHost,
      mongoUri: selectedMongoUri!,
      allowedClusterHost: tenantMigrationEnv.allowedClusterHost,
      applyRequested: args.includes("--apply")
    });
  }
  if (args.filter((argument) => argument === "--orphan-summary").length > 1) {
    throw new Error("The --orphan-summary option may be provided only once.");
  }
  if (args.filter((argument) => argument === "--orphan-details").length > 1) {
    throw new Error("The --orphan-details option may be provided only once.");
  }
  const schemaOnly = databaseArgs.length === 1 && databaseArgs[0] === "--schema-only";
  if (schemaOnly && (includeOrphanSummary || includeOrphanDetails)) {
    throw new Error("The orphan summary and detail options require a read-only database audit.");
  }

  // Importing models registers indexes in memory. Disable automatic collection
  // creation and index builds explicitly; this script must remain read-only.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await importModels();

  const models = Object.values(mongoose.models).sort((left, right) => left.modelName.localeCompare(right.modelName));
  const uncoveredTenantModels = models.filter((model) =>
    hasTenantOwnership(model) && !preActivationBackfillModels.has(model.modelName) && !fullIndexAuditModels.has(model.modelName)
  );
  if (uncoveredTenantModels.length) {
    throw new Error(`Tenant migration coverage is missing model(s): ${uncoveredTenantModels.map((model) => model.modelName).join(", ")}.`);
  }
  const tenantOwnerLinks = tenantOwnerParentLinks(models);
  const supplementalParentLinks = parentLinks.filter((link) => !(link.field === "tenantId" && link.parentModel === "Tenant"));
  const auditedParentLinks = [...tenantOwnerLinks, ...supplementalParentLinks];

  // Validate the reviewed relationship map without requiring a database. This
  // catches schema drift before the read-only Atlas reconciliation is started.
  for (const link of auditedParentLinks) await countOrphans(link, new Set());
  for (const modelName of Object.keys(orphanSummaryFields)) validateOrphanSummaryDimensions(modelName);
  if (schemaOnly) {
    console.log(`Tenant schema audit passed: ${models.length} models, ${tenantOwnerLinks.length} tenant-owner links, ${supplementalParentLinks.length} reviewed parent links.`);
    return { hasFindings: false, blockingFindings: [] };
  }

  const expectedDatabase = expectedDatabaseName(databaseArgs);

  await mongoose.connect(selectedMongoUri!, {
    family: 4,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 15_000
  });

  try {
    const databaseName = mongoose.connection.db?.databaseName;
    assertExpectedDatabaseName(expectedDatabase, databaseName);

    let hasFindings = false;
    const blockingFindings: string[] = [];
    const tenantModel = mongoose.model("Tenant");
    const tenantCollection = tenantModel.collection;
    const rootTenants = await tenantCollection.find({ kind: "SWIFTLINE" }).limit(3).toArray();
    const activeRoots = rootTenants.filter((tenant) => tenant.status === "ACTIVE");
    const currentSwiftlineRoot = activeRoots.length === 1 ? activeRoots[0]!._id : "__MISSING_SWIFTLINE_ROOT__";
    const tenantSlugModel = mongoose.model("TenantSlug");
    const currentSlug = await tenantSlugModel.collection.findOne({ slug: "swiftline", isCurrent: true });
    const nonDraftOperatorCount = await tenantCollection.countDocuments({
      kind: "OPERATOR",
      status: { $ne: "DRAFT" }
    });
    console.log(`Swiftline root tenants: ${rootTenants.length}; active roots: ${activeRoots.length}; current swiftline slug: ${currentSlug ? "present" : "missing"}`);
    console.log(`Non-draft operator tenants: ${nonDraftOperatorCount}`);
    const tenantSlugConflicts = await tenantSlugModel.collection.countDocuments({
      slug: "swiftline",
      ...(activeRoots.length === 1 ? { tenantId: { $ne: currentSwiftlineRoot } } : {})
    });
    const tenantRootSlugConflicts = await tenantCollection.countDocuments({ slug: "swiftline", kind: { $ne: "SWIFTLINE" } });
    if (activeRoots.length > 1 || rootTenants.length > 1 || tenantSlugConflicts > 0 || tenantRootSlugConflicts > 0) {
      console.log("BLOCKER: Swiftline root or reserved slug has conflicting ownership.");
      blockingFindings.push("Swiftline root or reserved slug conflict");
      hasFindings = true;
    } else if (activeRoots.length !== 1 || !currentSlug) {
      console.log("PLANNED CHANGE: Swiftline root tenant and/or current reserved slug is missing.");
      hasFindings = true;
    }
    if (nonDraftOperatorCount > 0) {
      blockingFindings.push("An operator tenant is already outside DRAFT status");
      hasFindings = true;
    }

    const collectionNames = [...new Set(models.map((model) => model.collection.collectionName))];
    const existingCollections = new Set((await mongoose.connection.db!.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
    const collectionCounts: Array<{ collection: string; documents: number }> = [];
    for (let offset = 0; offset < collectionNames.length; offset += 8) {
      const batch = collectionNames.slice(offset, offset + 8);
      const results = await Promise.all(batch.map(async (collection) => ({
        collection,
        documents: existingCollections.has(collection)
          ? await mongoose.connection.db!.collection(collection).countDocuments({}, { hint: "_id_" })
          : 0
      })));
      collectionCounts.push(...results);
    }

    console.log(`Database: ${databaseName}`);
    console.log(`Model files: ${fs.readdirSync(path.resolve("src/models")).filter((file) => file.endsWith(".model.ts")).length}`);
    console.log(`Models: ${models.length}; collections: ${collectionNames.length}`);
    const nonEmpty = collectionCounts.filter((item) => item.documents > 0).sort((a, b) => a.collection.localeCompare(b.collection));
    console.log(`Collections with records: ${nonEmpty.length}; total records: ${nonEmpty.reduce((sum, item) => sum + item.documents, 0)}`);
    for (const item of nonEmpty) console.log(`  ${item.collection}: ${item.documents}`);

    console.log("Tenant ownership audit (missing or invalid tenantId):");
    let missingTenantOwnershipTotal = 0;
    let assignedToOtherTenantTotal = 0;
    let malformedTenantOwnershipTotal = 0;
    let uncoveredTenantOwnershipTotal = 0;
    for (const model of models.filter(hasTenantOwnership)) {
      const [missingOrInvalid, unassigned, malformed, assignedToOtherTenant] = existingCollections.has(model.collection.collectionName)
        ? await Promise.all([
            model.collection.countDocuments(missingTenantOwnershipFilter()),
            model.collection.countDocuments(unassignedTenantOwnershipFilter()),
            model.collection.countDocuments(malformedTenantOwnershipFilter()),
            preActivationBackfillModels.has(model.modelName)
              ? activeRoots.length === 1
                ? model.collection.countDocuments({ tenantId: { $type: "objectId", $ne: currentSwiftlineRoot } })
                : model.collection.countDocuments({ tenantId: { $type: "objectId" } })
              : 0
          ])
        : [0, 0, 0, 0];
      missingTenantOwnershipTotal += missingOrInvalid;
      assignedToOtherTenantTotal += assignedToOtherTenant;
      malformedTenantOwnershipTotal += malformed;
      if (unassigned && !preActivationBackfillModels.has(model.modelName)) {
        uncoveredTenantOwnershipTotal += unassigned;
        blockingFindings.push(`Unassigned tenant ownership is outside migration coverage for ${model.modelName}`);
      }
      console.log(`  ${model.modelName}: unassigned=${unassigned}; malformed=${malformed}`);
    }
    console.log(`Total missing or invalid tenant ownership: ${missingTenantOwnershipTotal}`);
    console.log(`Malformed tenant ownership values: ${malformedTenantOwnershipTotal}`);
    console.log(`Unassigned records outside migration coverage: ${uncoveredTenantOwnershipTotal}`);
    console.log(`Existing tenant assignments outside the Swiftline root: ${assignedToOtherTenantTotal}`);
    if (missingTenantOwnershipTotal) hasFindings = true;
    if (malformedTenantOwnershipTotal) {
      blockingFindings.push("Malformed tenant ownership values must be reviewed before migration");
      hasFindings = true;
    }
    if (uncoveredTenantOwnershipTotal) hasFindings = true;
    if (assignedToOtherTenantTotal) {
      blockingFindings.push("Existing tenant assignments do not match the Swiftline root");
      hasFindings = true;
    }

    console.log("Schema index and tenant-local uniqueness audit:");
    let missingExpectedIndexes = 0;
    let duplicateTenantKeyGroups = 0;
    for (const model of models) {
      const existingIndexes = existingCollections.has(model.collection.collectionName)
        ? await model.collection.listIndexes().toArray().catch((error: unknown) => {
            const mongoError = error as { code?: number; codeName?: string };
            if (mongoError.code === 26 || mongoError.codeName === "NamespaceNotFound") return [];
            throw error;
          })
        : [];
      const expectedIndexes = migrationExpectedIndexes(model);
      for (const [key, options] of expectedIndexes) {
        if (!existingIndexes.some((index) => indexEquivalent(index, key, options))) {
          missingExpectedIndexes += 1;
          console.log(`  MISSING INDEX: ${model.collection.collectionName}.${options.name ?? Object.keys(key).join("_")}`);
        }
      }

      if (!existingCollections.has(model.collection.collectionName)) continue;
      for (const indexPlan of tenantScopedUniqueIndexes(model)) {
        const arrayFields = Object.keys(indexPlan.key).filter((field) => model.schema.path(field)?.instance === "Array");
        if (arrayFields.length > 1) {
          console.log(`  REVIEW REQUIRED: ${model.modelName} has a tenant unique index across multiple array fields.`);
          blockingFindings.push(`${model.modelName} has a tenant unique index across multiple array fields`);
          hasFindings = true;
          continue;
        }
        const rows = await model.collection.aggregate(
          uniqueTenantKeyDuplicatePipeline(
            indexPlan.key,
            indexPlan.options.partialFilterExpression as Record<string, unknown> | undefined,
            currentSwiftlineRoot,
            arrayFields
          ),
          { maxTimeMS: 60_000 }
        ).toArray();
        const groups = Number((rows[0] as { duplicateGroups?: number } | undefined)?.duplicateGroups ?? 0);
        if (groups) {
          duplicateTenantKeyGroups += groups;
          console.log(`  DUPLICATE TENANT KEY: ${model.modelName}.${indexPlan.options.name ?? Object.keys(indexPlan.key).join("_")}: ${groups} group(s)`);
          blockingFindings.push(`Duplicate tenant-local keys exist for ${model.modelName}`);
        }
      }
    }
    console.log(`Missing schema indexes: ${missingExpectedIndexes}; duplicate tenant-local key groups: ${duplicateTenantKeyGroups}`);
    if (missingExpectedIndexes || duplicateTenantKeyGroups) hasFindings = true;

    const emailOutbox = mongoose.model("EmailOutbox");
    if (existingCollections.has(emailOutbox.collection.collectionName)) {
      const emailStatusCounts = await emailOutbox.collection.aggregate<{ _id: string | null; count: number }>(
        missingTenantEmailOutboxStatusPipeline()
      ).toArray();
      console.log("EmailOutbox status counts for records missing or invalid tenantId:");
      if (!emailStatusCounts.length) console.log("  none");
      for (const statusCount of emailStatusCounts) {
        console.log(`  ${statusCount._id || "<empty>"}: ${statusCount.count}`);
      }
    }

    console.log("Parent-link audit (orphan count):");
    let orphanTotal = 0;
    let acceptedOrphanExceptionTotal = 0;
    let crossTenantParentTotal = 0;
    let identityMismatchTotal = 0;
    for (const link of auditedParentLinks) {
      const result = await countOrphans(link, existingCollections);
      const count = result.danglingParent + result.missingOrInvalidReference;
      orphanTotal += count;
      acceptedOrphanExceptionTotal += result.acceptedDanglingParent;
      crossTenantParentTotal += result.crossTenantParent;
      identityMismatchTotal += result.identityMismatch;
      console.log(`  ${link.childModel}.${link.field} -> ${link.parentModel}: dangling=${result.danglingParent}, missing-or-invalid=${result.missingOrInvalidReference}, cross-tenant=${result.crossTenantParent}, account-or-branch-mismatch=${result.identityMismatch}, accepted-reviewed-exception=${result.acceptedDanglingParent}${result.acceptedExceptionCode ? ` (${result.acceptedExceptionCode})` : ""}`);
      if (includeOrphanSummary && result.danglingParent > 0) {
        const dimensions = validateOrphanSummaryDimensions(link.childModel);
        if (dimensions.length) {
          const acceptedException = result.acceptedDanglingParent > 0
            ? approvedOrphanReferenceException(link.childModel, link.field)
            : undefined;
          const summaries = await readOrphanSummary(link, dimensions, acceptedException?.match);
          console.log(`    Aggregate-only lifecycle summary (${dimensions.map((dimension) => dimension.name).join(", ")}; no IDs or personal data):`);
          for (const summary of summaries) {
            const label = Object.entries(summary.values).map(([name, value]) => `${name}=${value}`).join(", ");
            console.log(`      ${label}: ${summary.count}`);
          }
        }
      }
      if (includeOrphanDetails && result.danglingParent > 0) {
        const dimensions = validateOrphanSummaryDimensions(link.childModel);
        const acceptedException = result.acceptedDanglingParent > 0
          ? approvedOrphanReferenceException(link.childModel, link.field)
          : undefined;
        const records = await readOrphanDetails(link, dimensions, acceptedException?.match);
        console.log(`    Orphan detail records (ObjectIds and allowlisted lifecycle values only):`);
        for (const record of records) {
          const lifecycle = Object.entries(record.lifecycle).map(([name, value]) => `${name}=${String(value)}`).join(", ");
          console.log(`      child=${record.childId}, missingParent=${record.missingParentId}${lifecycle ? `, ${lifecycle}` : ""}`);
        }
      }
      if (link.field === "tenantId" && link.parentModel === "Tenant") {
        if (result.danglingParent > 0) blockingFindings.push(`Unresolved tenant-owner references exist in ${link.childModel}`);
      } else if (count > 0) {
        blockingFindings.push(`Orphaned or malformed references exist in ${link.childModel}.${link.field}`);
      }
      if (result.rejectedExceptionCandidates > 0) {
        blockingFindings.push(`Reviewed reference exception bounds were exceeded in ${link.childModel}.${link.field}`);
      }
      if (result.crossTenantParent > 0) blockingFindings.push(`Cross-tenant references exist in ${link.childModel}.${link.field}`);
      if (result.identityMismatch > 0) blockingFindings.push(`Account or branch mismatches exist in ${link.childModel}.${link.field}`);
    }
    console.log(`Total orphan references: ${orphanTotal}`);
    console.log(`Total accepted reviewed orphan exceptions: ${acceptedOrphanExceptionTotal}`);
    console.log(`Total cross-tenant parent references: ${crossTenantParentTotal}`);
    console.log(`Total shipment account/branch identity mismatches: ${identityMismatchTotal}`);
    if (orphanTotal > 0 || missingTenantOwnershipTotal > 0 || crossTenantParentTotal > 0 || identityMismatchTotal > 0) {
      hasFindings = true;
    }
    if (productionSafe) {
      if (blockingFindings.length) {
        console.log(`Production migration blockers: ${blockingFindings.length}`);
        for (const finding of [...new Set(blockingFindings)]) console.log(`  BLOCKER: ${finding}`);
      } else {
        console.log("Production migration preflight found no structural blockers. Ownership gaps and missing indexes, if any, remain listed as planned migration work.");
      }
    }
    return { hasFindings, blockingFindings: [...new Set(blockingFindings)] };
  } finally {
    await mongoose.disconnect();
  }
}

export function runProductionTenantAudit(input: { expectedClusterHost: string; mongoUri?: string }) {
  return run([
    "--production-safe",
    "--database",
    "swiftline",
    "--cluster-host",
    input.expectedClusterHost
  ], input.mongoUri);
}

if (isMainModule(import.meta.url)) {
  run().then((result) => {
    if (result.hasFindings) process.exitCode = 1;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Tenant data audit failed.");
    process.exitCode = 1;
  });
}
