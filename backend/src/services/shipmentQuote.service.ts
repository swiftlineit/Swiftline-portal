import { shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, type BusinessAccountMemberRole } from "../models/businessAccountMember.model.js";
import { ShipmentDraft, type ShipmentContentType, type ShipmentServiceType } from "../models/shipmentDraft.model.js";
import { ShipmentQuote, type IShipmentQuote, type ShipmentQuoteSource, type ShipmentQuoteStatus } from "../models/shipmentQuote.model.js";
import { ShipmentQuoteCounter } from "../models/shipmentQuoteCounter.model.js";
import { normalizeCsbType, type CsbType } from "./csbType.service.js";
import { normalizeQuoteDocuments, type QuoteDocumentCode } from "./quoteDocuments.service.js";
import { defaultParcelItemUnitType } from "./parcelItems.service.js";
import { createBlankShipmentDraft } from "./manualShipmentDraft.service.js";
import { notifyActiveAdmins, notifyBusinessQuoteMembers } from "./portalNotification.service.js";
import {
  allocateTaxExclusiveComponentMinors,
  calculateShipmentPricingEstimate,
  defaultShipmentGstRate,
  splitGstInclusiveAmountMinor
} from "./shipmentPricing.service.js";
import { findRoute } from "./swiftlineRoute.service.js";
import { validateShipmentDraftFields } from "./shipmentValidation.service.js";

export const quoteRequestRoles: BusinessAccountMemberRole[] = shipmentBookingRoles;
export const quoteViewRoles: BusinessAccountMemberRole[] = [...quoteRequestRoles, "finance"];

export type ShipmentQuoteRequestInput = {
  businessAccountId?: string;
  destinationCountryCode: string;
  destinationCountryName: string;
  // What is inside the boxes. Labelled "Content Type" in the UI.
  shipmentType: ShipmentContentType;
  // Customs route for the shipment; CSB-V adds a flat clearance charge.
  csbType: CsbType;
  serviceType: ShipmentServiceType;
  goodsValueMinor: number;
  // Export documents the customer already holds. Recorded on the request so the
  // branch can see what is in place when pricing the quote.
  availableDocuments: QuoteDocumentCode[];
  parcels: Array<{ sequence: number; actualWeightKg: number; lengthCm: number; widthCm: number; heightCm: number; contents: string }>;
};

export type QuoteContext = {
  businessAccountId: mongoose.Types.ObjectId;
  rateCardBand?: import("../models/countryRateCard.model.js").RateCardBand;
  accountId: string;
  companyName: string;
  branchId: mongoose.Types.ObjectId;
  branchName: string;
  branchCode: string;
  originCity: string;
  branchContact: { email: string; phone: string };
  membershipRole?: BusinessAccountMemberRole;
};

export class ShipmentQuoteError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ShipmentQuoteError";
  }
}

function getFinancialYear(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit"
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const startYear = month >= 4 ? year : year - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

async function nextQuoteNumber(now: Date) {
  const financialYear = getFinancialYear(now);
  const counter = await ShipmentQuoteCounter.findOneAndUpdate(
    { financialYear },
    { $inc: { sequence: 1 }, $setOnInsert: { financialYear } },
    { upsert: true, returnDocument: "after", runValidators: true }
  ).exec();
  if (!counter) throw new ShipmentQuoteError("A quote number could not be generated. Please try again.", 500);
  return `QT/${financialYear}/${String(counter.sequence).padStart(5, "0")}`;
}

function displayContextFrom(
  account: InstanceType<typeof BusinessAccount>,
  branch: InstanceType<typeof Branch>,
  role?: BusinessAccountMemberRole
) {
  return {
    businessAccountId: account._id,
    accountId: account.accountId,
    companyName: account.company.companyName,
    branchId: branch._id,
    branchName: branch.name,
    branchCode: branch.code,
    originCity: branch.address.city ?? "",
    branchContact: { email: branch.contact.email ?? "", phone: branch.contact.phone ?? "" },
    membershipRole: role
  };
}

function contextFrom(account: InstanceType<typeof BusinessAccount>, branch: InstanceType<typeof Branch>, role?: BusinessAccountMemberRole): QuoteContext {
  const privateCard = account.privateRateCardVersion != null;
  if (privateCard ? !account.privateRateCardReady : !account.rateCardBand) throw new ShipmentQuoteError("Configure the business account's rate card before requesting or estimating a quote.", 409);
  return {
    ...displayContextFrom(account, branch, role),
    rateCardBand: privateCard ? undefined : account.rateCardBand ?? undefined
  };
}

async function accountContext(accountValue: string) {
  const account = mongoose.Types.ObjectId.isValid(accountValue)
    ? await BusinessAccount.findById(accountValue).exec()
    : await BusinessAccount.findOne({ accountId: accountValue }).exec();
  if (!account) throw new ShipmentQuoteError("Business account not found.", 404);
  if (!["approved", "active"].includes(account.status)) {
    throw new ShipmentQuoteError("The business account must be approved or active before requesting a quote.", 409);
  }
  if (!account.assignedBranch) throw new ShipmentQuoteError("Assign a branch before requesting a quote.", 409);
  const branch = await Branch.findById(account.assignedBranch).exec();
  if (!branch || branch.status !== "ACTIVE") {
    throw new ShipmentQuoteError("The assigned branch is not active. Contact Swiftline support.", 409);
  }
  return { account, branch };
}

export async function resolveAdminQuoteContext(accountValue: string) {
  const { account, branch } = await accountContext(accountValue);
  return contextFrom(account, branch);
}

export async function resolveClientQuoteContext(userId: string, accountValue?: string, requireRequestPermission = false) {
  const query: Record<string, unknown> = { user: userId, status: "active" };
  if (accountValue && mongoose.Types.ObjectId.isValid(accountValue)) query.businessAccount = accountValue;
  const membership = (await BusinessAccountMember.find(query).sort({ createdAt: -1 }).exec())
    .find((item) => quoteViewRoles.includes(item.role));
  if (!membership) throw new ShipmentQuoteError("Your account role cannot access shipment quotes.", 403);
  if (requireRequestPermission && !quoteRequestRoles.includes(membership.role)) {
    throw new ShipmentQuoteError("Your account role can view quotes but cannot request or convert them.", 403);
  }
  const { account, branch } = await accountContext(String(membership.businessAccount));
  return contextFrom(account, branch, membership.role);
}

export async function calculateQuoteEstimate(context: QuoteContext, input: ShipmentQuoteRequestInput) {
  /**
   * How long this lane actually takes.
   *
   * The quote screen printed a hard-coded "3-5 days" for every destination-
   * a placeholder from before the route table existed that had quietly become
   * a false promise, telling a customer shipping to Australia the same as one
   * shipping to Nepal. Fetched alongside the price rather than on the booking
   * form's estimate path, which runs on every keystroke of a flow that needs
   * to stay fast.
   */
  const [pricing, route] = await Promise.all([
    calculateShipmentPricingEstimate({
    businessAccountId: context.businessAccountId,
    rateCardBand: context.rateCardBand,
    countryCode: input.destinationCountryCode,
    serviceType: input.serviceType,
    csbType: input.csbType,
    parcels: input.parcels.map((parcel) => ({
      sequence: parcel.sequence,
      weightKg: parcel.actualWeightKg,
      lengthCm: parcel.lengthCm,
      widthCm: parcel.widthCm,
      heightCm: parcel.heightCm
    }))
    }),
    findRoute({
      destinationCountryCode: input.destinationCountryCode,
      service: input.serviceType === "CARGO" ? "CARGO" : "COURIER"
    })
  ]);
  const minor = (amount: number) => Math.round(amount * 100);
  return {
    currency: "INR",
    originCity: context.originCity,
    destinationCountryCode: input.destinationCountryCode,
    destinationCountryName: input.destinationCountryName,
    serviceType: input.serviceType,
    parcels: pricing.parcels.map((parcel) => ({
      ...parcel,
      // The per-box quote is the commercial GST-inclusive rate-card amount.
      // Tax-exclusive parcel values remain in the pricing snapshot for invoices.
      baseAmountMinor: minor(parcel.inclusiveBaseAmount ?? parcel.baseAmount)
    })),
    freightMinor: minor(pricing.freightAmount),
    inclusiveFreightMinor: minor(pricing.inclusiveAmounts?.freightAmount ?? pricing.freightAmount),
    // Flat CSB-V clearance charge for the whole shipment; zero on CSB-IV.
    csbType: pricing.csbType,
    csbClearanceMinor: minor(pricing.csbClearanceAmount),
    inclusiveCsbClearanceMinor: minor(
      pricing.inclusiveAmounts?.csbClearanceAmount ?? pricing.csbClearanceAmount
    ),
    fuelSurchargeMinor: minor(pricing.fuelSurchargeAmount),
    inclusiveFuelSurchargeMinor: minor(
      pricing.inclusiveAmounts?.fuelSurchargeAmount ?? pricing.fuelSurchargeAmount
    ),
    // Everything taxable that is neither freight, clearance nor fuel: handling,
    // and any route discount netted off. A quote has no destination postcode and
    // no insurance choice yet, so remote area and insurance never apply here.
    taxableAddOnsMinor: minor(pricing.handlingAmount - pricing.discountAmount),
    inclusiveTaxableAddOnsMinor: minor(
      (pricing.inclusiveAmounts?.handlingAmount ?? pricing.handlingAmount)
      - (pricing.inclusiveAmounts?.discountAmount ?? pricing.discountAmount)
    ),
    // The full breakdown, so the quote shows the same charges the booking will.
    lines: pricing.lines,
    gstRate: pricing.gstRate,
    taxTreatment: pricing.taxTreatment ?? (pricing.gstRate === 0 ? "NO_GST" : "GST_APPLICABLE"),
    noGstEligible: Boolean(pricing.noGstEligible),
    gstBillingVersion: pricing.gstBillingVersion ?? 1,
    gstMinor: minor(pricing.gstAmount),
    totalMinor: minor(pricing.totalAmount),
    missingRate: pricing.missingRate,
    exceedsMaxBoxKg: pricing.exceedsMaxBoxKg,
    // Null when the lane has no route, so the quote shows no transit line at
    // all rather than a number nothing supports.
    transit: route?.serviceable
      ? { daysMin: route.transitDaysMin, daysMax: route.transitDaysMax, basis: route.transitBasis }
      : null
  };
}

function snapshot(context: QuoteContext, input: ShipmentQuoteRequestInput) {
  return {
    originCity: context.originCity,
    destinationCountryCode: input.destinationCountryCode,
    destinationCountryName: input.destinationCountryName,
    shipmentType: input.shipmentType,
    csbType: normalizeCsbType(input.csbType),
    serviceType: input.serviceType,
    goodsValueMinor: input.goodsValueMinor,
    // Route-aware, so a tick left over from a CSB-V draft is never stored on a
    // CSB-IV shipment.
    availableDocuments: normalizeQuoteDocuments(input.availableDocuments, input.csbType),
    parcels: input.parcels.map((parcel) => ({ ...parcel }))
  };
}

export async function createShipmentQuote(input: {
  context: QuoteContext; request: ShipmentQuoteRequestInput; source: ShipmentQuoteSource; userId: mongoose.Types.ObjectId;
}) {
  const now = new Date();
  const quote = await ShipmentQuote.create({
    quoteNumber: await nextQuoteNumber(now),
    businessAccountId: input.context.businessAccountId,
    branchId: input.context.branchId,
    source: input.source,
    status: "REQUESTED",
    requestSnapshot: snapshot(input.context, input.request),
    estimateSnapshot: await calculateQuoteEstimate(input.context, input.request),
    requestedBy: input.userId,
    statusHistory: [{ status: "REQUESTED", changedAt: now, changedBy: input.userId }]
  });
  await AuditLog.create({
    action: "SHIPMENT_QUOTE_REQUESTED", entityType: "SHIPMENT_QUOTE", entityId: quote._id,
    performedBy: input.userId, performedAt: now,
    metadata: { quoteNumber: quote.quoteNumber, businessAccountId: quote.businessAccountId, branchId: quote.branchId }
  });
  await notifyActiveAdmins({
    type: "SHIPMENT_QUOTE_REQUESTED", title: "Shipment quote requested",
    message: `${quote.quoteNumber} requires branch pricing review.`,
    href: `/dashboard/quote-requests/${String(quote._id)}`,
    idempotencyKey: `SHIPMENT_QUOTE_REQUESTED:${String(quote._id)}`,
    businessAccountId: quote.businessAccountId, metadata: { quoteId: quote._id }
  });
  return quote;
}

export function effectiveQuoteStatus(quote: Pick<IShipmentQuote, "status" | "validUntil">, now = new Date()): ShipmentQuoteStatus {
  return quote.status === "QUOTED" && quote.validUntil && quote.validUntil.getTime() < now.getTime()
    ? "EXPIRED"
    : quote.status;
}

export function calculatePublishedQuotePricing(input: {
  freightMinor: number; fuelSurchargeMinor: number; taxableAddOnsMinor: number;
  gstRate?: number;
}) {
  const inclusiveSubtotalMinor = input.freightMinor + input.fuelSurchargeMinor + input.taxableAddOnsMinor;
  const gstRate = input.gstRate ?? defaultShipmentGstRate;
  const split = splitGstInclusiveAmountMinor(inclusiveSubtotalMinor, gstRate);
  const [freightMinor = 0, fuelSurchargeMinor = 0, taxableAddOnsMinor = 0] = allocateTaxExclusiveComponentMinors(
    [input.freightMinor, input.fuelSurchargeMinor, input.taxableAddOnsMinor],
    split.taxableMinor,
    gstRate
  );
  return {
    currency: "INR" as const,
    freightMinor,
    fuelSurchargeMinor,
    taxableAddOnsMinor,
    taxableSubtotalMinor: split.taxableMinor,
    inclusiveFreightMinor: input.freightMinor,
    inclusiveFuelSurchargeMinor: input.fuelSurchargeMinor,
    inclusiveTaxableAddOnsMinor: input.taxableAddOnsMinor,
    inclusiveSubtotalMinor,
    gstRate,
    taxTreatment: gstRate === 0 ? "NO_GST" as const : "GST_APPLICABLE" as const,
    gstMinor: split.gstMinor,
    totalMinor: split.totalMinor
  };
}

export function serializeShipmentQuote(quote: InstanceType<typeof ShipmentQuote>, context?: Partial<QuoteContext>) {
  return {
    id: String(quote._id), quoteNumber: quote.quoteNumber,
    businessAccountId: String(quote.businessAccountId), branchId: String(quote.branchId),
    source: quote.source, status: effectiveQuoteStatus(quote),
    request: quote.requestSnapshot, estimate: quote.estimateSnapshot,
    finalPricing: quote.finalPricingSnapshot ?? null,
    customerNote: quote.customerNote, internalNote: quote.internalNote,
    validUntil: quote.validUntil ?? null,
    requestedBy: String(quote.requestedBy), reviewedBy: quote.reviewedBy ? String(quote.reviewedBy) : null,
    reviewedAt: quote.reviewedAt ?? null,
    convertedDraftId: quote.convertedDraftId ? String(quote.convertedDraftId) : null,
    convertedAt: quote.convertedAt ?? null,
    statusHistory: quote.statusHistory, createdAt: quote.createdAt, updatedAt: quote.updatedAt,
    account: context ? {
      accountId: context.accountId, companyName: context.companyName,
      branchName: context.branchName, branchCode: context.branchCode,
      originCity: context.originCity, branchContact: context.branchContact
    } : null
  };
}

export async function loadQuoteContext(quote: InstanceType<typeof ShipmentQuote>) {
  const [account, branch] = await Promise.all([
    BusinessAccount.findById(quote.businessAccountId).exec(), Branch.findById(quote.branchId).exec()
  ]);
  if (!account || !branch) throw new ShipmentQuoteError("Quote account information is no longer available.", 409);
  return contextFrom(account, branch);
}

export async function loadQuoteDisplayContext(quote: InstanceType<typeof ShipmentQuote>) {
  const [account, branch] = await Promise.all([
    BusinessAccount.findById(quote.businessAccountId).exec(), Branch.findById(quote.branchId).exec()
  ]);
  if (!account || !branch) return undefined;
  return displayContextFrom(account, branch);
}

export async function publishShipmentQuote(input: {
  quote: InstanceType<typeof ShipmentQuote>; userId: mongoose.Types.ObjectId;
  freightMinor: number; fuelSurchargeMinor: number; taxableAddOnsMinor: number;
  validUntil: Date; customerNote: string; internalNote: string;
}) {
  if (!["REQUESTED", "UNDER_REVIEW"].includes(input.quote.status)) {
    throw new ShipmentQuoteError("Only a requested quote can be published.", 409);
  }
  if (input.validUntil.getTime() <= Date.now()) throw new ShipmentQuoteError("Quote validity must end in the future.", 400);
  const now = new Date();
  // Re-resolve the account permission at publication time. A request may have
  // waited in the queue while no-GST access was approved or revoked.
  const currentEstimate = await calculateQuoteEstimate(
    await loadQuoteContext(input.quote),
    input.quote.requestSnapshot as unknown as ShipmentQuoteRequestInput
  );
  const finalPricing = calculatePublishedQuotePricing({
    ...input,
    gstRate: currentEstimate.gstRate
  });
  input.quote.status = "QUOTED";
  input.quote.finalPricingSnapshot = finalPricing;
  input.quote.estimateSnapshot = currentEstimate;
  input.quote.validUntil = input.validUntil;
  input.quote.customerNote = input.customerNote;
  input.quote.internalNote = input.internalNote;
  input.quote.reviewedBy = input.userId;
  input.quote.reviewedAt = now;
  input.quote.statusHistory.push({ status: "QUOTED", changedAt: now, changedBy: input.userId });
  await input.quote.save();
  await AuditLog.create({
    action: "SHIPMENT_QUOTE_PUBLISHED", entityType: "SHIPMENT_QUOTE", entityId: input.quote._id,
    performedBy: input.userId, performedAt: now,
    metadata: { quoteNumber: input.quote.quoteNumber, totalMinor: finalPricing.totalMinor }
  });
  await notifyBusinessQuoteMembers(input.quote.businessAccountId, {
    type: "SHIPMENT_QUOTE_PUBLISHED", title: "Shipment quote ready",
    message: `${input.quote.quoteNumber} has been priced and is ready to review.`,
    href: `/client/quotes/${String(input.quote._id)}`,
    idempotencyKey: `SHIPMENT_QUOTE_PUBLISHED:${String(input.quote._id)}`,
    metadata: { quoteId: input.quote._id }
  });
  return input.quote;
}

export async function changeShipmentQuoteStatus(input: {
  quote: InstanceType<typeof ShipmentQuote>; status: "UNDER_REVIEW" | "DECLINED";
  userId: mongoose.Types.ObjectId; note?: string;
}) {
  if (!["REQUESTED", "UNDER_REVIEW"].includes(input.quote.status)) {
    throw new ShipmentQuoteError("This quote request can no longer be changed.", 409);
  }
  if (input.status === "DECLINED" && !input.note?.trim()) {
    throw new ShipmentQuoteError("Add a clear reason before declining this quote.", 400);
  }
  const now = new Date();
  input.quote.status = input.status;
  input.quote.reviewedBy = input.userId;
  input.quote.reviewedAt = now;
  if (input.status === "DECLINED") input.quote.customerNote = input.note?.trim() ?? "";
  input.quote.statusHistory.push({ status: input.status, changedAt: now, changedBy: input.userId, note: input.note });
  await input.quote.save();
  await AuditLog.create({
    action: input.status === "DECLINED" ? "SHIPMENT_QUOTE_DECLINED" : "SHIPMENT_QUOTE_UNDER_REVIEW",
    entityType: "SHIPMENT_QUOTE", entityId: input.quote._id,
    performedBy: input.userId, performedAt: now, metadata: { note: input.note ?? "" }
  });
  if (input.status === "DECLINED") {
    await notifyBusinessQuoteMembers(input.quote.businessAccountId, {
      type: "SHIPMENT_QUOTE_DECLINED", title: "Shipment quote unavailable",
      message: `${input.quote.quoteNumber} could not be quoted. Review the branch note for details.`,
      href: `/client/quotes/${String(input.quote._id)}`,
      idempotencyKey: `SHIPMENT_QUOTE_DECLINED:${String(input.quote._id)}`,
      metadata: { quoteId: input.quote._id }
    });
  }
  return input.quote;
}

/**
 * Refuses a conversion into a branch the caller does not hold. `null` means
 * unscoped, as it does throughout the branch middleware.
 *
 * Raised as a ShipmentQuoteError rather than left to the draft service, because
 * handleQuoteError only translates quote errors- a ManualShipmentDraftError
 * would reach the client as a 500 instead of a 403.
 */
function assertQuoteBranchAllowed(allowedBranchIds: string[] | null, branchId: unknown) {
  if (allowedBranchIds === null) return;
  if (allowedBranchIds.includes(String(branchId))) return;

  throw new ShipmentQuoteError("You do not have access to this branch.", 403);
}

export async function createShipmentDraftFromEstimate(input: {
  context: QuoteContext;
  request: ShipmentQuoteRequestInput;
  userId: mongoose.Types.ObjectId;
  /**
   * Branches the caller may open a draft in, or null when unscoped. Clients
   * pass null: they hold no branch assignment, and the quote context already
   * confines them to their own account's branch.
   */
  allowedBranchIds: string[] | null;
}) {
  assertQuoteBranchAllowed(input.allowedBranchIds, input.context.branchId);
  const estimate = await calculateQuoteEstimate(input.context, input.request);
  if (estimate.missingRate) {
    throw new ShipmentQuoteError("No active rate is available for this route. Contact your assigned branch.", 409);
  }
  const draft = await createBlankShipmentDraft({
    businessAccountId: String(input.context.businessAccountId),
    branchId: String(input.context.branchId),
    createdBy: input.userId,
    allowedBranchIds: input.allowedBranchIds
  }) as unknown as InstanceType<typeof ShipmentDraft>;
  draft.consigneeEnteredAddress.countryCode = input.request.destinationCountryCode;
  draft.consigneeEnteredAddress.countryName = input.request.destinationCountryName;
  draft.serviceType = input.request.serviceType;
  // Carried across so the booked shipment prices on the same CSB route the
  // customer was quoted for.
    draft.csbType = normalizeCsbType(input.request.csbType);
    draft.forceGst = estimate.taxTreatment === "GST_APPLICABLE" && Boolean(estimate.noGstEligible);
  draft.parcelList = input.request.parcels.map((parcel) => ({
    sequence: parcel.sequence, weightKg: parcel.actualWeightKg,
    lengthCm: parcel.lengthCm, widthCm: parcel.widthCm, heightCm: parcel.heightCm,
    shipmentContentType: input.request.shipmentType,
    // The quote captures a single contents label per box; the HSN code is
    // collected per item later, on the shipment review form.
    items: [{ description: parcel.contents, hsnCode: "", unitType: defaultParcelItemUnitType, quantity: 0, unitRate: 0 }],
    contentsDescription: parcel.contents,
    shipmentReference1: "", shipmentReference2: ""
  }));
  draft.validationIssues = validateShipmentDraftFields(draft);
  await draft.save();
  return draft;
}

export async function convertShipmentQuoteToDraft(input: {
  quote: InstanceType<typeof ShipmentQuote>; userId: mongoose.Types.ObjectId;
  /** See createShipmentDraftFromEstimate; clients pass null. */
  allowedBranchIds: string[] | null;
}) {
  // Before the claim below, so a refused conversion never marks the quote as
  // being converted and relies on the rollback to undo it.
  assertQuoteBranchAllowed(input.allowedBranchIds, input.quote.branchId);
  if (effectiveQuoteStatus(input.quote) === "EXPIRED") throw new ShipmentQuoteError("This quote has expired and cannot be converted.", 409);
  if (input.quote.status === "CONVERTED" && input.quote.convertedDraftId) {
    return ShipmentDraft.findById(input.quote.convertedDraftId).exec();
  }
  if (input.quote.status !== "QUOTED") throw new ShipmentQuoteError("Only a valid published quote can create a shipment draft.", 409);
  const request = input.quote.requestSnapshot as unknown as ShipmentQuoteRequestInput;
  const estimate = await calculateQuoteEstimate(await loadQuoteContext(input.quote), request);
  if (estimate.missingRate) throw new ShipmentQuoteError("No active rate is available for this route. Contact your assigned branch.", 409);
  const claimed = await ShipmentQuote.findOneAndUpdate(
    { _id: input.quote._id, status: "QUOTED", convertedAt: null },
    { $set: { convertedAt: new Date() } }, { returnDocument: "after" }
  ).exec();
  if (!claimed) throw new ShipmentQuoteError("This quote is already being converted. Refresh the page to continue.", 409);

  try {
    const draft = await createBlankShipmentDraft({
      businessAccountId: String(input.quote.businessAccountId), branchId: String(input.quote.branchId), createdBy: input.userId,
      allowedBranchIds: input.allowedBranchIds
    }) as unknown as InstanceType<typeof ShipmentDraft>;
    draft.consigneeEnteredAddress.countryCode = request.destinationCountryCode;
    draft.consigneeEnteredAddress.countryName = request.destinationCountryName;
    draft.serviceType = request.serviceType;
    // Preserved from the published quote so the draft prices identically.
    draft.csbType = normalizeCsbType(request.csbType);
    const finalPricing = input.quote.finalPricingSnapshot as Record<string, unknown> | null;
    draft.forceGst = finalPricing?.taxTreatment === "GST_APPLICABLE" && Boolean(estimate.noGstEligible);
    draft.parcelList = request.parcels.map((parcel) => ({
      sequence: parcel.sequence, weightKg: parcel.actualWeightKg,
      lengthCm: parcel.lengthCm, widthCm: parcel.widthCm, heightCm: parcel.heightCm,
      shipmentContentType: request.shipmentType,
      // HSN codes are collected per item on the shipment review form.
      items: [{ description: parcel.contents, hsnCode: "", unitType: defaultParcelItemUnitType, quantity: 0, unitRate: 0 }],
      contentsDescription: parcel.contents,
      shipmentReference1: input.quote.quoteNumber, shipmentReference2: ""
    }));
    draft.validationIssues = validateShipmentDraftFields(draft);
    await draft.save();
    input.quote.status = "CONVERTED";
    input.quote.convertedDraftId = draft._id;
    input.quote.convertedAt = new Date();
    input.quote.statusHistory.push({ status: "CONVERTED", changedAt: input.quote.convertedAt, changedBy: input.userId });
    await input.quote.save();
    await AuditLog.create({
      action: "SHIPMENT_QUOTE_CONVERTED", entityType: "SHIPMENT_QUOTE", entityId: input.quote._id,
      performedBy: input.userId, performedAt: input.quote.convertedAt,
      metadata: { quoteNumber: input.quote.quoteNumber, shipmentDraftId: draft._id }
    });
    await notifyActiveAdmins({
      type: "SHIPMENT_QUOTE_CONVERTED", title: "Quote converted to shipment draft",
      message: `${input.quote.quoteNumber} was converted to an editable shipment draft.`,
      href: `/dashboard/dpd-labels/${String(draft._id)}`,
      idempotencyKey: `SHIPMENT_QUOTE_CONVERTED:${String(input.quote._id)}`,
      businessAccountId: input.quote.businessAccountId,
      metadata: { quoteId: input.quote._id, shipmentDraftId: draft._id }
    });
    return draft;
  } catch (error) {
    await ShipmentQuote.updateOne(
      { _id: input.quote._id, status: "QUOTED", convertedDraftId: null },
      { $set: { convertedAt: null } }
    ).exec();
    throw error;
  }
}
