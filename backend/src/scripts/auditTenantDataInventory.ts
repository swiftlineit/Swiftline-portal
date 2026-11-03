import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { assertExpectedDatabaseName, assertNonProductionEnvironment } from "./migrationSafety.js";
import {
  hasTenantOwnership,
  invalidObjectIdReferenceFilter,
  missingTenantEmailOutboxStatusPipeline,
  missingTenantOwnershipFilter,
  orphanReferenceDetailsPipeline,
  orphanReferenceSummaryPipeline,
  type OrphanSummaryDimension,
  tenantOwnerParentLinks,
  tenantParentIntegrityPipeline
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

async function readOrphanSummary(link: ParentLink, dimensions: ValidatedOrphanSummaryDimension[]) {
  if (!dimensions.length) return [];
  const child = mongoose.model(link.childModel);
  const parent = mongoose.model(link.parentModel);
  const rows = await child.collection.aggregate<{
    _id: Record<string, string | boolean | null>;
    count: number;
  }>(
    orphanReferenceSummaryPipeline(link.field, parent.collection.collectionName, dimensions),
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

async function readOrphanDetails(link: ParentLink, dimensions: ValidatedOrphanSummaryDimension[]) {
  const child = mongoose.model(link.childModel);
  const parent = mongoose.model(link.parentModel);
  const rows = await child.collection.aggregate<Record<string, unknown>>(
    orphanReferenceDetailsPipeline(
      link.field,
      parent.collection.collectionName,
      dimensions,
      link.array || link.nestedArray ? link.nestedArray ?? link.field : undefined
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
    return { danglingParent: 0, missingOrInvalidReference: 0, crossTenantParent: 0, identityMismatch: 0 };
  }

  const invalidReferenceMatch = invalidObjectIdReferenceFilter(link.field, expectedRequired);
  const pipeline = [
    ...(link.array || link.nestedArray
      ? [{ $unwind: { path: `$${link.nestedArray ?? link.field}`, preserveNullAndEmptyArrays: Boolean(link.array && expectedRequired) } }]
      : []),
    {
      $facet: {
        dangling: [
          { $match: { [link.field]: { $type: "objectId" } } },
          {
            $lookup: {
              from: parent.collection.collectionName,
              localField: link.field,
              foreignField: "_id",
              as: "_tenantAuditParent"
            }
          },
          { $match: { $expr: { $eq: [{ $size: "$_tenantAuditParent" }, 0] } } },
          { $count: "count" }
        ],
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
  } | undefined;
  return {
    danglingParent: Number(results?.dangling?.[0]?.count ?? 0),
    missingOrInvalidReference: Number(results?.invalid?.[0]?.count ?? 0),
    crossTenantParent: Number(results?.parentIntegrity?.[0]?.crossTenantParent ?? 0),
    identityMismatch: Number(results?.parentIntegrity?.[0]?.identityMismatch ?? 0)
  };
}

async function run() {
  assertNonProductionEnvironment(env.NODE_ENV, "Tenant data audit");
  const args = process.argv.slice(2);
  const includeOrphanSummary = args.includes("--orphan-summary");
  const includeOrphanDetails = args.includes("--orphan-details");
  const databaseArgs = args.filter((argument) => argument !== "--orphan-summary" && argument !== "--orphan-details");
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
  const tenantOwnerLinks = tenantOwnerParentLinks(models);
  const supplementalParentLinks = parentLinks.filter((link) => !(link.field === "tenantId" && link.parentModel === "Tenant"));
  const auditedParentLinks = [...tenantOwnerLinks, ...supplementalParentLinks];

  // Validate the reviewed relationship map without requiring a database. This
  // catches schema drift before the read-only Atlas reconciliation is started.
  for (const link of auditedParentLinks) await countOrphans(link, new Set());
  for (const modelName of Object.keys(orphanSummaryFields)) validateOrphanSummaryDimensions(modelName);
  if (schemaOnly) {
    console.log(`Tenant schema audit passed: ${models.length} models, ${tenantOwnerLinks.length} tenant-owner links, ${supplementalParentLinks.length} reviewed parent links.`);
    return;
  }

  const expectedDatabase = expectedDatabaseName(databaseArgs);

  await mongoose.connect(env.MONGODB_URI, {
    family: 4,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 15_000
  });

  try {
    const databaseName = mongoose.connection.db?.databaseName;
    assertExpectedDatabaseName(expectedDatabase, databaseName);

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
    for (const model of models.filter(hasTenantOwnership)) {
      const missing = existingCollections.has(model.collection.collectionName)
        ? await model.collection.countDocuments(missingTenantOwnershipFilter())
        : 0;
      missingTenantOwnershipTotal += missing;
      console.log(`  ${model.modelName}: ${missing}`);
    }
    console.log(`Total missing or invalid tenant ownership: ${missingTenantOwnershipTotal}`);

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
    let crossTenantParentTotal = 0;
    let identityMismatchTotal = 0;
    for (const link of auditedParentLinks) {
      const result = await countOrphans(link, existingCollections);
      const count = result.danglingParent + result.missingOrInvalidReference;
      orphanTotal += count;
      crossTenantParentTotal += result.crossTenantParent;
      identityMismatchTotal += result.identityMismatch;
      console.log(`  ${link.childModel}.${link.field} -> ${link.parentModel}: dangling=${result.danglingParent}, missing-or-invalid=${result.missingOrInvalidReference}, cross-tenant=${result.crossTenantParent}, account-or-branch-mismatch=${result.identityMismatch}`);
      if (includeOrphanSummary && result.danglingParent > 0) {
        const dimensions = validateOrphanSummaryDimensions(link.childModel);
        if (dimensions.length) {
          const summaries = await readOrphanSummary(link, dimensions);
          console.log(`    Aggregate-only lifecycle summary (${dimensions.map((dimension) => dimension.name).join(", ")}; no IDs or personal data):`);
          for (const summary of summaries) {
            const label = Object.entries(summary.values).map(([name, value]) => `${name}=${value}`).join(", ");
            console.log(`      ${label}: ${summary.count}`);
          }
        }
      }
      if (includeOrphanDetails && result.danglingParent > 0) {
        const dimensions = validateOrphanSummaryDimensions(link.childModel);
        const records = await readOrphanDetails(link, dimensions);
        console.log(`    Orphan detail records (ObjectIds and allowlisted lifecycle values only):`);
        for (const record of records) {
          const lifecycle = Object.entries(record.lifecycle).map(([name, value]) => `${name}=${String(value)}`).join(", ");
          console.log(`      child=${record.childId}, missingParent=${record.missingParentId}${lifecycle ? `, ${lifecycle}` : ""}`);
        }
      }
    }
    console.log(`Total orphan references: ${orphanTotal}`);
    console.log(`Total cross-tenant parent references: ${crossTenantParentTotal}`);
    console.log(`Total shipment account/branch identity mismatches: ${identityMismatchTotal}`);
    if (orphanTotal > 0 || missingTenantOwnershipTotal > 0 || crossTenantParentTotal > 0 || identityMismatchTotal > 0) {
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Tenant data audit failed.");
  process.exitCode = 1;
});
