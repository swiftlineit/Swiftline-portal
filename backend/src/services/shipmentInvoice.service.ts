import mongoose from "mongoose";
import { Branch } from "../models/branch.model.js";
import { BalanceReservation } from "../models/balanceReservation.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceCounter } from "../models/shipmentInvoiceCounter.model.js";
import { formatCsbType } from "./csbType.service.js";
import { resolveGstStateCode } from "./gstin.js";
import {
  buildPricingInputFromDraft,
  calculateShipmentPricingEstimate,
  type ShipmentPricingEstimate
} from "./shipmentPricing.service.js";
import { readShipmentBookingSnapshot } from "./shipmentBookingSnapshot.service.js";
import { normalizeParcelItems } from "./parcelItems.service.js";

async function syncProfitability(
  shipmentDraftId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
) {
  const { syncShipmentProfitability } = await import("./shipmentProfitability.service.js");
  await syncShipmentProfitability(shipmentDraftId, { session });
}

export class ShipmentInvoiceServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

function getFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

async function getNextInvoiceNumber(financialYear: string, session?: mongoose.ClientSession) {
  const counter = await ShipmentInvoiceCounter.findOneAndUpdate(
    { financialYear },
    { $inc: { sequence: 1 } },
    { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true, session }
  ).exec();

  return `SL/${financialYear}/${String(counter.sequence).padStart(5, "0")}`;
}

function normalizeState(value?: string | null) {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

function getTaxAmounts(baseAmountMinor: number, taxAmountMinor: number, supplierState: string, customerState: string) {
  const isIntraState = Boolean(normalizeState(supplierState) && normalizeState(supplierState) === normalizeState(customerState));

  if (isIntraState) {
    const cgstAmountMinor = Math.floor(taxAmountMinor / 2);
    return {
      taxType: "CGST_SGST" as const,
      cgstAmountMinor,
      sgstAmountMinor: taxAmountMinor - cgstAmountMinor,
      igstAmountMinor: 0
    };
  }

  return {
    taxType: "IGST" as const,
    cgstAmountMinor: 0,
    sgstAmountMinor: 0,
    igstAmountMinor: taxAmountMinor
  };
}

function toMinor(value: number) {
  return Math.round(value * 100);
}

export function resolveShipmentInvoicePaymentAllocation(input: {
  totalAmountMinor: number;
  paymentAllocation?: { advanceAppliedMinor: number; creditOutstandingMinor: number };
  existingAllocation?: { advanceAppliedMinor: number; creditOutstandingMinor: number } | null;
  reservationAllocation?: { advanceAmountMinor: number; creditAmountMinor: number } | null;
  /**
   * Value the customer has already settled against this invoice.
   *
   * Paying a billing statement clears an invoice's outstanding credit without
   * moving anything into the applied advance, so a paid invoice's two
   * allocations no longer add up to its total on their own. Zero for every
   * invoice that has not been paid, which is every invoice at the moment it is
   * first issued.
   */
  settledAmountMinor?: number;
}) {
  const advanceAppliedMinor = input.paymentAllocation?.advanceAppliedMinor
    ?? input.existingAllocation?.advanceAppliedMinor
    ?? input.reservationAllocation?.advanceAmountMinor
    ?? 0;
  const creditOutstandingMinor = input.paymentAllocation?.creditOutstandingMinor
    ?? input.existingAllocation?.creditOutstandingMinor
    ?? input.reservationAllocation?.creditAmountMinor
    ?? input.totalAmountMinor;
  const settledAmountMinor = input.settledAmountMinor ?? 0;

  if (advanceAppliedMinor + creditOutstandingMinor + settledAmountMinor !== input.totalAmountMinor) {
    throw new ShipmentInvoiceServiceError("The invoice payment allocation does not match its total amount.", 409);
  }

  return { advanceAppliedMinor, creditOutstandingMinor };
}

function addressLine(parts: Array<string | undefined | null>) {
  return parts.map((part) => part?.trim()).filter(Boolean).join(", ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function buildRevisionSnapshot(invoice: InstanceType<typeof ShipmentInvoice>) {
  return {
    revision: invoice.revision,
    revisedAt: invoice.revisedAt ?? invoice.issuedAt,
    supplier: invoice.supplier,
    customer: invoice.customer,
    shipment: invoice.shipment,
    sacCode: invoice.sacCode,
    taxableValueMinor: invoice.taxableValueMinor,
    gstRatePercent: invoice.gstRatePercent,
    taxTreatment: invoice.taxTreatment,
    taxType: invoice.taxType,
    cgstAmountMinor: invoice.cgstAmountMinor,
    sgstAmountMinor: invoice.sgstAmountMinor,
    igstAmountMinor: invoice.igstAmountMinor,
    totalTaxAmountMinor: invoice.totalTaxAmountMinor,
    totalAmountMinor: invoice.totalAmountMinor,
    advanceAppliedMinor: invoice.advanceAppliedMinor,
    creditOutstandingMinor: invoice.creditOutstandingMinor,
    pricingSnapshot: invoice.pricingSnapshot,
    description: invoice.description,
    reverseCharge: invoice.reverseCharge,
    status: invoice.status,
    validationWarnings: invoice.validationWarnings,
    paymentStatus: invoice.paymentStatus
  };
}

export async function ensureShipmentInvoiceForDraft(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  revise?: boolean;
  paymentAllocation?: {
    advanceAppliedMinor: number;
    creditOutstandingMinor: number;
  };
  /**
   * What stays settled against the invoice after the caller's money movement.
   *
   * Only needed alongside `paymentAllocation` when the revision refunds value
   * the customer had already paid; without it the settled amount is read from
   * the invoice as it stands, which is correct for every revision that leaves
   * paid value alone.
   */
  settledAmountMinor?: number;
  pricingOverride?: ShipmentPricingEstimate;
  session?: mongoose.ClientSession;
}) {
  const existingQuery = ShipmentInvoice.findOne({ shipmentDraftId: input.shipmentDraftId });
  if (input.session) existingQuery.session(input.session);
  const existing = await existingQuery.exec();
  // Draft invoices refresh from current GST master data when they are viewed again.
  if (existing && !input.revise && existing.status === "ISSUED") return existing;

  const draftQuery = ShipmentDraft.findById(input.shipmentDraftId);
  const dpdQuery = DpdShipment.findById(input.dpdShipmentId);
  if (input.session) {
    draftQuery.session(input.session);
    dpdQuery.session(input.session);
  }
  const draft = await draftQuery.exec();
  const dpdShipment = await dpdQuery.exec();
  if (!draft || !dpdShipment) throw new ShipmentInvoiceServiceError("Booked shipment information was not found.", 404);
  // The first legal invoice must use the exact values accepted at booking.
  // Approved amendments deliberately use current draft values and create a revision.
  const bookingSnapshot = input.revise
    ? null
    : readShipmentBookingSnapshot(dpdShipment.bookingSnapshot);

  const accountQuery = BusinessAccount.findById(draft.businessAccountId);
  const branchQuery = Branch.findById(draft.branchId);
  const chargeQuery = ShipmentCharge.findOne({ shipmentDraftId: draft._id });
  if (input.session) {
    accountQuery.session(input.session);
    branchQuery.session(input.session);
    chargeQuery.session(input.session);
  }
  const account = await accountQuery.exec();
  const branch = await branchQuery.exec();
  const charge = await chargeQuery.exec();
  if (!account || !branch) throw new ShipmentInvoiceServiceError("Invoice master data is incomplete.", 409);

  let pricing: ShipmentPricingEstimate;
  if (input.pricingOverride) {
    pricing = input.pricingOverride;
  } else if (bookingSnapshot) {
    pricing = bookingSnapshot.pricing;
  } else if (!input.revise && charge?.customerChargeStatus === "COMPLETED" && charge.pricingSnapshot?.totalAmount) {
    pricing = charge.pricingSnapshot as unknown as ShipmentPricingEstimate;
  } else {
    pricing = await calculateShipmentPricingEstimate({
      ...buildPricingInputFromDraft(draft),
      session: input.session
    });
  }
  if (charge?.customerChargeStatus === "COMPLETED" && toMinor(pricing.totalAmount) !== charge.customerChargeMinor) {
    throw new ShipmentInvoiceServiceError("The booked charge and invoice pricing snapshot do not match.", 409);
  }
  if (pricing.missingRate) {
    throw new ShipmentInvoiceServiceError("An applicable rate slab is required before the shipment invoice can be issued.", 409);
  }

  const reservation = charge?.balanceReservationId
    ? await BalanceReservation.findById(charge.balanceReservationId).session(input.session ?? null).exec()
    : null;
  const snapshotAllocation = bookingSnapshot
    ? {
        advanceAmountMinor: bookingSnapshot.payment.advanceAmountMinor,
        creditAmountMinor: bookingSnapshot.payment.creditAmountMinor
      }
    : null;
  const totalAmountMinor = toMinor(pricing.totalAmount);
  // Falls back to the invoice as it stands before this revision: whatever its
  // total is no longer accounted for by applied advance and outstanding credit
  // has already been paid. Zero for a new invoice and for any invoice still
  // unpaid.
  const settledAmountMinor = input.settledAmountMinor
    ?? (existing
      ? existing.totalAmountMinor - existing.advanceAppliedMinor - existing.creditOutstandingMinor
      : 0);
  const { advanceAppliedMinor, creditOutstandingMinor } = resolveShipmentInvoicePaymentAllocation({
    totalAmountMinor,
    paymentAllocation: input.paymentAllocation,
    existingAllocation: existing,
    reservationAllocation: reservation ?? snapshotAllocation,
    settledAmountMinor
  });
  const paymentStatus = creditOutstandingMinor === 0
    ? "PAID" as const
    : advanceAppliedMinor > 0 ? "PARTIALLY_PAID" as const : "UNPAID" as const;

  const snapshotSender = asRecord(bookingSnapshot?.sender);
  const snapshotSenderAddress = asRecord(snapshotSender.address);
  const snapshotSenderContact = asRecord(snapshotSender.contact);
  const snapshotAccount = asRecord(bookingSnapshot?.account);
  const snapshotCompany = asRecord(snapshotAccount.company);
  const snapshotContact = asRecord(snapshotAccount.contact);
  const snapshotConsignee = asRecord(bookingSnapshot?.consignee);
  // Every field below falls back to the business account when the snapshot leaves
  // it blank. For a walk-in that account is the shared sentinel, so the fallback
  // would print its bookkeeping identity- "Customers" as a surname, and its
  // internal system email address- onto a real customer's invoice. Individuals
  // are billed from their snapshot alone; a blank field stays blank.
  const isIndividualCustomer = draft.customerType === "INDIVIDUAL";
  const fallbackContact = isIndividualCustomer
    ? { firstName: "", lastName: "", email: "", countryCode: "", mobileNumber: "" }
    : account.contact;
  const fallbackCompany = isIndividualCustomer
    ? { companyName: "", registeredAddress: "", city: "", postalCode: "", addressCountry: "" }
    : account.company;
  const supplierState = asString(snapshotSenderAddress.stateOrProvince) || branch.address.stateOrProvince || "";
  const customerState = asString(snapshotCompany.stateOrProvince) || account.company.stateOrProvince || "";
  const supplierGstin = asString(snapshotSender.gstin) || branch.gstin || "";
  const customerGstin = asString(snapshotCompany.gstin) || account.company.gstin || "";
  const taxableValueMinor = toMinor(pricing.baseAmount);
  const totalTaxAmountMinor = toMinor(pricing.gstAmount);
  // Resolved to GST state codes so both sides of the place-of-supply test speak
  // the same language- see resolveGstStateCode.
  const supplierJurisdiction = resolveGstStateCode(supplierGstin, supplierState);
  const customerJurisdiction = resolveGstStateCode(customerGstin, customerState);
  const taxAmounts = getTaxAmounts(taxableValueMinor, totalTaxAmountMinor, supplierJurisdiction, customerJurisdiction);
  // Only Swiftline's own GSTIN can hold an invoice back: a tax invoice without
  // the supplier's registration number is not a tax invoice. A missing customer
  // GSTIN is ordinary- an unregistered recipient never has one- so the field
  // is left blank on the document and the invoice issues normally.
  const validationWarnings = supplierGstin ? [] : ["Branch GSTIN is not configured."];
  // A shipment with no GST is still a valid completed invoice, so the GST cells
  // are simply left empty rather than marking the whole invoice as a draft.
  const status = validationWarnings.length && totalTaxAmountMinor > 0 ? "DRAFT" : "ISSUED";
  const supplier = {
    legalName: "Swiftline Cargo and Express Logistics Pvt. Ltd.",
    branchName: asString(snapshotSender.name) || branch.name,
    branchCode: asString(snapshotSender.code) || branch.code,
    gstin: supplierGstin,
    state: supplierState,
    stateCode: supplierGstin.slice(0, 2),
    address: addressLine([
      asString(snapshotSenderAddress.address) || branch.address.address,
      asString(snapshotSenderAddress.city) || branch.address.city,
      supplierState,
      asString(snapshotSenderAddress.postalCode) || branch.address.postalCode,
      asString(snapshotSenderAddress.countryName) || branch.address.countryName
    ]),
    email: asString(snapshotSenderContact.email) || branch.contact.email || "",
    phone: asString(snapshotSenderContact.phone) || branch.contact.phone || ""
  };
  // A business account may keep a billing address separate from its registered
  // company address. When it does, that address is the one the tax invoice bills
  // to; otherwise the registered address stands in.
  const separateBilling = asRecord(
    asRecord(snapshotCompany.billingAddress).addressLine1 ? snapshotCompany.billingAddress : account.company.billingAddress
  );
  const usesCompanyAddress = Boolean(
    snapshotCompany.useCompanyAddressAsBillingAddress ?? account.company.useCompanyAddressAsBillingAddress
  );
  const separateBillingAddressLine = usesCompanyAddress ? "" : addressLine([
    asString(separateBilling.addressLine1),
    asString(separateBilling.addressLine2),
    asString(separateBilling.city),
    asString(separateBilling.stateOrProvince),
    asString(separateBilling.postalCode),
    asString(separateBilling.country)
  ]);
  const registeredAddressLine = addressLine([
    asString(snapshotCompany.registeredAddress) || fallbackCompany.registeredAddress,
    asString(snapshotCompany.city) || fallbackCompany.city,
    customerState,
    asString(snapshotCompany.postalCode) || fallbackCompany.postalCode,
    asString(snapshotCompany.addressCountry) || fallbackCompany.addressCountry
  ]);
  const customer = {
    accountId: asString(snapshotAccount.accountId) || account.accountId,
    companyName: asString(snapshotCompany.companyName) || fallbackCompany.companyName,
    contactName: `${asString(snapshotContact.firstName) || fallbackContact.firstName} ${asString(snapshotContact.lastName) || fallbackContact.lastName}`.trim(),
    gstin: customerGstin,
    state: customerState,
    stateCode: customerGstin.slice(0, 2),
    billingAddress: separateBillingAddressLine || registeredAddressLine,
    email: asString(snapshotContact.email) || fallbackContact.email,
    phone: `${asString(snapshotContact.countryCode) || fallbackContact.countryCode} ${asString(snapshotContact.mobileNumber) || fallbackContact.mobileNumber}`.trim()
  };
  const snapshotParcels = bookingSnapshot?.parcels ?? [];
  // The shipment's public identity is the Swiftline AWB.
  const shipmentReference = bookingSnapshot?.tracking.swiftlineTrackingNumber
    || dpdShipment.swiftlineTrackingNumber
    || "";
  const snapshotCustomerReference = bookingSnapshot?.parcels.find((parcel) => (
    typeof parcel.reference === "string" && Boolean(parcel.reference.trim())
  ))?.reference;
  const customerReference = typeof snapshotCustomerReference === "string"
    ? snapshotCustomerReference
    : draft.parcelList.find((parcel) => parcel.shipmentReference1?.trim())?.shipmentReference1 || "";
  const sourceInvoiceNumber = bookingSnapshot?.source.invoiceNumber || "";
  const serviceType = bookingSnapshot?.service.type || draft.serviceType;
  const serviceCode = bookingSnapshot?.service.code || draft.serviceCode || dpdShipment.serviceCode;
  const shipment = {
    shipmentReference,
    customerReference,
    sourceInvoiceNumber,
    dpdShipmentId: bookingSnapshot?.tracking.carrierShipmentId || dpdShipment.dpdShipmentId || "",
    serviceType,
    serviceCode,
    parcelCount: bookingSnapshot?.parcels.length || draft.parcelList.length,
    origin: addressLine([
      asString(snapshotSenderAddress.city) || branch.address.city,
      supplierState,
      asString(snapshotSenderAddress.countryName) || branch.address.countryName
    ]),
    destination: addressLine([
      asString(snapshotConsignee.townOrCity) || draft.consigneeEnteredAddress.townOrCity,
      asString(snapshotConsignee.county) || draft.consigneeEnteredAddress.county,
      asString(snapshotConsignee.countryName) || draft.consigneeEnteredAddress.countryName
    ]),
    deliveryAddress: addressLine([
      asString(snapshotConsignee.companyName) || draft.consigneeEnteredAddress.companyName,
      asString(snapshotConsignee.addressLine1) || draft.consigneeEnteredAddress.addressLine1,
      asString(snapshotConsignee.addressLine2) || draft.consigneeEnteredAddress.addressLine2,
      asString(snapshotConsignee.townOrCity) || draft.consigneeEnteredAddress.townOrCity,
      asString(snapshotConsignee.county) || draft.consigneeEnteredAddress.county,
      asString(snapshotConsignee.postcode) || draft.consigneeEnteredAddress.postcode,
      asString(snapshotConsignee.countryName) || draft.consigneeEnteredAddress.countryName
    ]),
    consigneeName: asString(snapshotConsignee.companyName) || asString(snapshotConsignee.contactName) || draft.consigneeEnteredAddress.companyName || draft.consigneeEnteredAddress.contactName || "",
    parcelNumbers: bookingSnapshot?.parcels.map((parcel) => parcel.carrierParcelNumber) || dpdShipment.parcelNumbers,
    parcels: pricing.parcels.map((pricedParcel, index) => {
      const sourceParcel = asRecord(snapshotParcels[index] ?? draft.parcelList[index]);
      return {
        ...pricedParcel,
        lengthCm: typeof sourceParcel.lengthCm === "number" ? sourceParcel.lengthCm : null,
        widthCm: typeof sourceParcel.widthCm === "number" ? sourceParcel.widthCm : null,
        heightCm: typeof sourceParcel.heightCm === "number" ? sourceParcel.heightCm : null,
        items: normalizeParcelItems(sourceParcel),
        contentsDescription: asString(sourceParcel.contentsDescription) || "Shipment goods"
      };
    })
  };
  const nextValues = {
    dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
    businessAccountId: draft.businessAccountId,
    branchId: draft.branchId,
    currency: asString(snapshotSender.baseCurrency) || branch.baseCurrency || "INR",
    supplier,
    customer,
    shipment,
    sacCode: asString(snapshotSender.invoiceSacCode) || branch.invoiceSacCode || "",
    // The CSB route is part of the invoice description so the customs category
    // this shipment was billed under is visible on the invoice record itself.
    description: `${serviceType === "CARGO" ? "Cargo" : "Courier"} shipment service (${formatCsbType(pricing.csbType)}) - ${shipmentReference || "AWB Pending"}`,
    taxableValueMinor,
    gstRatePercent: pricing.gstRate * 100,
    taxTreatment: pricing.taxTreatment ?? (pricing.gstRate === 0 ? "NO_GST" : "GST_APPLICABLE"),
    ...taxAmounts,
    totalTaxAmountMinor,
    totalAmountMinor,
    advanceAppliedMinor,
    creditOutstandingMinor,
    paymentStatus,
    reverseCharge: false,
    status,
    validationWarnings,
    pricingSnapshot: pricing,
    updatedBy: input.userId
  };

  if (existing) {
    if (input.revise) {
      existing.revisions = [...existing.revisions, buildRevisionSnapshot(existing)];
      existing.revision += 1;
      existing.revisedAt = new Date();
    }
    existing.set(nextValues);
    await existing.save({ session: input.session });
    await syncProfitability(draft._id as mongoose.Types.ObjectId, input.session);
    return existing;
  }

  const issuedAt = new Date();
  const financialYear = getFinancialYear(issuedAt);
  const invoice = new ShipmentInvoice({
    ...nextValues,
    invoiceNumber: await getNextInvoiceNumber(financialYear, input.session),
    financialYear,
    shipmentDraftId: draft._id,
    revision: 1,
    revisions: [],
    issuedAt,
    createdBy: input.userId
  });
  try {
    await invoice.save({ session: input.session });
    await syncProfitability(draft._id as mongoose.Types.ObjectId, input.session);
    return invoice;
  } catch (error) {
    // Concurrent view/download requests may race on the one-invoice-per-shipment index.
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      const concurrentInvoiceQuery = ShipmentInvoice.findOne({ shipmentDraftId: draft._id });
      if (input.session) concurrentInvoiceQuery.session(input.session);
      const concurrentInvoice = await concurrentInvoiceQuery.exec();
      if (concurrentInvoice) {
        await syncProfitability(draft._id as mongoose.Types.ObjectId, input.session);
        return concurrentInvoice;
      }
    }
    throw error;
  }
}

/**
 * Shipment statuses that settle a charge, so it can be billed.
 *
 * Collection is the point the service demonstrably began: the parcel is out of
 * the customer's hands and Swiftline is carrying it, so the charge is real and
 * belongs on the next statement. Waiting for hub receipt deferred revenue for as
 * long as a parcel sat in transit- and a parcel that never reached the hub was
 * never billed at all.
 *
 * Hub receipt stays in the list behind it. It settles nothing new once
 * collection already has, but it is what catches a shipment whose collection
 * went unrecorded, so no parcel can reach the hub still unbillable.
 */
export const chargeFinalizingStatuses = ["PARCEL_COLLECTED", "WAREHOUSE_SCAN_IN"] as const;

/**
 * Records the moment a shipment's charge stopped being provisional.
 *
 * The billing cycle bills invoices whose charge settled inside the period, so
 * this stamp is what puts a shipment on a statement. It is set by whichever
 * comes first: the parcel being collected, the hub receiving it, or Operations
 * correcting its weight.
 *
 * Written once and never moved. The `chargeFinalizedAt: null` filter is what
 * makes that true- a later Warehouse Scan In row, a re-scan, a second collection
 * row, or a correction recorded afterwards all leave the original date alone,
 * because re-dating an invoice would carry it into a later statement period
 * and delay a bill that was already due.
 */
export async function markShipmentChargeFinalized(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  finalizedAt: Date;
  session?: mongoose.ClientSession;
}) {
  await ShipmentInvoice.updateOne(
    { shipmentDraftId: input.shipmentDraftId, chargeFinalizedAt: null },
    { $set: { chargeFinalizedAt: input.finalizedAt } },
    { runValidators: true, session: input.session }
  ).exec();
}

/**
 * Batch form used when one operational action settles many shipment charges.
 *
 * Each invoice keeps its own event timestamp and the same write-once filter as
 * the single-shipment path, but MongoDB receives the updates in one round trip.
 */
export async function markShipmentChargesFinalized(inputs: Array<{
  shipmentDraftId: mongoose.Types.ObjectId;
  finalizedAt: Date;
}>, session?: mongoose.ClientSession) {
  if (!inputs.length) return;

  await ShipmentInvoice.bulkWrite(inputs.map((input) => ({
    updateOne: {
      filter: { shipmentDraftId: input.shipmentDraftId, chargeFinalizedAt: null },
      update: { $set: { chargeFinalizedAt: input.finalizedAt } }
    }
  })), { ordered: false, session });
}

export function serializeShipmentInvoice(
  invoice: InstanceType<typeof ShipmentInvoice>,
  requestedRevision = invoice.revision
) {
  if (!Number.isInteger(requestedRevision) || requestedRevision < 1 || requestedRevision > invoice.revision) {
    throw new ShipmentInvoiceServiceError("Invoice revision not found.", 404);
  }

  const storedRevision = requestedRevision === invoice.revision
    ? null
    : invoice.revisions.find((candidate) => candidate.revision === requestedRevision);
  if (requestedRevision !== invoice.revision && !storedRevision) {
    throw new ShipmentInvoiceServiceError("Invoice revision not found.", 404);
  }

  const selected = storedRevision ?? invoice;
  const selectedIssuedAt = storedRevision?.revisedAt
    ?? (invoice.revision > 1 ? invoice.revisedAt ?? invoice.issuedAt : invoice.issuedAt);
  const versions = [
    ...invoice.revisions.map((revision) => ({
      revision: revision.revision,
      issuedAt: revision.revisedAt,
      totalAmountMinor: revision.totalAmountMinor,
      status: revision.status ?? invoice.status,
      paymentStatus: revision.paymentStatus ?? invoice.paymentStatus,
      isLatest: false
    })),
    {
      revision: invoice.revision,
      issuedAt: invoice.revision > 1 ? invoice.revisedAt ?? invoice.issuedAt : invoice.issuedAt,
      totalAmountMinor: invoice.totalAmountMinor,
      status: invoice.status,
      paymentStatus: invoice.paymentStatus,
      isLatest: true
    }
  ].sort((left, right) => left.revision - right.revision);

  return {
    id: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber,
    financialYear: invoice.financialYear,
    shipmentDraftId: String(invoice.shipmentDraftId),
    dpdShipmentId: String(invoice.dpdShipmentId),
    businessAccountId: String(invoice.businessAccountId),
    branchId: String(invoice.branchId),
    currency: invoice.currency,
    supplier: selected.supplier,
    customer: selected.customer,
    shipment: selected.shipment,
    sacCode: selected.sacCode,
    description: storedRevision?.description ?? invoice.description,
    taxableValueMinor: selected.taxableValueMinor,
    gstRatePercent: selected.gstRatePercent,
    taxTreatment: selected.taxTreatment ?? (selected.gstRatePercent === 0 ? "NO_GST" : "GST_APPLICABLE"),
    taxType: selected.taxType,
    cgstAmountMinor: selected.cgstAmountMinor,
    sgstAmountMinor: selected.sgstAmountMinor,
    igstAmountMinor: selected.igstAmountMinor,
    totalTaxAmountMinor: selected.totalTaxAmountMinor,
    totalAmountMinor: selected.totalAmountMinor,
    advanceAppliedMinor: selected.advanceAppliedMinor,
    creditOutstandingMinor: selected.creditOutstandingMinor,
    reverseCharge: storedRevision?.reverseCharge ?? invoice.reverseCharge,
    status: storedRevision?.status ?? invoice.status,
    validationWarnings: storedRevision?.validationWarnings ?? invoice.validationWarnings,
    paymentStatus: storedRevision?.paymentStatus ?? invoice.paymentStatus,
    pricingSnapshot: selected.pricingSnapshot,
    revision: requestedRevision,
    issuedAt: selectedIssuedAt,
    revisedAt: requestedRevision > 1 ? selectedIssuedAt : null,
    isLatest: requestedRevision === invoice.revision,
    versions
  };
}
