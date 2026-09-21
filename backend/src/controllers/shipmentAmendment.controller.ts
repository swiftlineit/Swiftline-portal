import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { CounterPayment, counterPaymentMethodValues } from "../models/counterPayment.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentEvent, type ShipmentEventStatus } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import {
  ShipmentDraft,
  shipmentContentTypeValues,
  shipmentServiceTypeValues,
  type IShipmentDraft
} from "../models/shipmentDraft.model.js";
import { normalizeCsbType } from "../services/csbType.service.js";
import { defaultParcelItemUnitType, maxParcelItems, maxParcelsPerShipment, normalizeParcelItems } from "../services/parcelItems.service.js";
import { findRestrictedCategories } from "../services/restrictedGoods.service.js";
import {
  buildPricingInputFromDraft,
  calculateShipmentPricingEstimate,
  RateCardRequiredError,
  type ShipmentPricingEstimate
} from "../services/shipmentPricing.service.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";
import {
  ensureShipmentInvoiceForDraft,
  ShipmentInvoiceServiceError
} from "../services/shipmentInvoice.service.js";
import {
  AmendmentBillingError,
  applyApprovedAmendmentBilling,
  previewAmendmentFunding
} from "../services/amendmentBilling.service.js";
import { regenerateShipmentLabels } from "../services/dpdShipment.service.js";
import { notifyActiveAdmins, notifyBusinessShipmentMembers } from "../services/portalNotification.service.js";
import { dateRangeCondition, dateRangeParams } from "../utils/dateRangeFilter.js";
import {
  buildRevisedShipmentSnapshot,
  readShipmentBookingSnapshot
} from "../services/shipmentBookingSnapshot.service.js";

const postParcelCollectedStatuses: ShipmentEventStatus[] = [
  "WAREHOUSE_SCAN_IN",
  "ORIGIN_HUB_PROCESSED",
  "READY_FOR_EXPORT",
  "ORIGIN_HUB_DISPATCHED",
  "EXPORT_CUSTOMS_CLEARED",
  "FLIGHT_ASSIGNED",
  "FLIGHT_DEPARTED",
  "DESTINATION_ARRIVED",
  "IMPORT_CUSTOMS_CLEARANCE",
  "IMPORT_CUSTOMS_CLEARED",
  "DELIVERY_PARTNER_TRANSFERRED",
  "DELIVERY_HUB_ARRIVED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "LOST",
  "DAMAGED"
];

const amendmentAddressSchema = z.object({
  companyName: z.string().trim().max(120).optional(),
  contactName: z.string().trim().max(120).optional(),
  email: z.string().trim().max(160).optional(),
  mobileCountryCode: z.string().trim().max(8).optional(),
  mobileNumber: z.string().trim().max(30).optional(),
  countryCode: z.string().trim().toUpperCase().length(2).optional(),
  countryName: z.string().trim().max(80).optional(),
  postcode: z.string().trim().toUpperCase().max(20).optional(),
  addressLine1: z.string().trim().max(120).optional(),
  addressLine2: z.string().trim().max(120).optional(),
  townOrCity: z.string().trim().max(80).optional(),
  county: z.string().trim().max(80).optional(),
  deliveryInstructions: z.string().trim().max(500).optional()
});

const amendmentParcelSchema = z.object({
  sequence: z.coerce.number().int().positive(),
  weightKg: z.coerce.number().nonnegative(),
  lengthCm: z.coerce.number().nonnegative().optional().nullable(),
  widthCm: z.coerce.number().nonnegative().optional().nullable(),
  heightCm: z.coerce.number().nonnegative().optional().nullable(),
  shipmentContentType: z.enum(shipmentContentTypeValues).default("PARCEL"),
  // Item rows carry the per-item HS code, unit and value that print on the
  // customs invoice, so an amendment can correct them.
  items: z.array(z.object({
    description: z.string().trim().max(120),
    hsnCode: z.string().trim().max(10),
    unitType: z.string().trim().max(12).default(defaultParcelItemUnitType),
    quantity: z.coerce.number().min(0).max(1_000_000).default(0),
    unitRate: z.coerce.number().min(0).max(10_000_000).default(0)
  })).max(maxParcelItems).optional(),
  contentsDescription: z.string().trim().min(1).max(120),
  shipmentReference1: z.string().trim().max(120).optional(),
  shipmentReference2: z.string().trim().max(120).optional()
}).superRefine((parcel, context) => {
  const descriptions = [
    ...(parcel.items ?? []).map((item) => item.description),
    parcel.contentsDescription
  ];
  const categories = descriptions.flatMap((description) => findRestrictedCategories(description));
  const uniqueCategories = categories.filter((category, index) => categories.indexOf(category) === index);
  if (!uniqueCategories.length) return;

  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["items"],
    message: `${uniqueCategories.join(", ")} is a restricted item and cannot be shipped.`
  });
});

const createShipmentAmendmentSchema = z.object({
  reason: z.string().trim().max(500).optional().default(""),
  changes: z.object({
    serviceType: z.enum(shipmentServiceTypeValues).optional(),
    consigneeEnteredAddress: amendmentAddressSchema.optional(),
    parcelList: z.array(amendmentParcelSchema).min(1).max(maxParcelsPerShipment).optional()
  }).refine((changes) => Boolean(changes.serviceType || changes.consigneeEnteredAddress || changes.parcelList), {
    message: "At least one amendment change is required."
  })
});

const reviewShipmentAmendmentSchema = z.object({
  note: z.string().trim().max(500).optional().default(""),
  // Walk-in shipments only, and only when the amendment changes the price. The
  // approval is rejected if a counter sale moves money and this is missing.
  counterPayment: z.object({
    method: z.enum(counterPaymentMethodValues),
    reference: z.string().trim().max(80).optional(),
    note: z.string().trim().max(300).optional()
  }).optional()
});

type AppliedChange = {
  fieldName: string;
  originalValue: unknown;
  newValue: unknown;
};

type ShipmentDraftForAmendment = Pick<
  IShipmentDraft,
  "businessAccountId" | "consigneeEnteredAddress" | "parcelList" | "serviceType" | "csbType" | "addressValidationStatus" | "status"
>;

type AmendmentChanges = z.infer<typeof createShipmentAmendmentSchema>["changes"];

type DraftSnapshot = ReturnType<typeof snapshotDraft>;

type PricingImpact = {
  current: ShipmentPricingEstimate;
  requested: ShipmentPricingEstimate;
  deltaAmount: number;
};

class AmendmentReviewError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

function getDraftId(request: Request) {
  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  return mongoose.Types.ObjectId.isValid(draftId) ? draftId : "";
}

function getAmendmentId(request: Request) {
  const amendmentId = typeof request.params.id === "string" ? request.params.id : "";
  return mongoose.Types.ObjectId.isValid(amendmentId) ? amendmentId : "";
}

function normalizeComparableValue(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  return value;
}

function valuesDiffer(originalValue: unknown, newValue: unknown) {
  return JSON.stringify(normalizeComparableValue(originalValue)) !== JSON.stringify(normalizeComparableValue(newValue));
}

function addAppliedChange(changes: AppliedChange[], fieldName: string, originalValue: unknown, newValue: unknown) {
  if (!valuesDiffer(originalValue, newValue)) return;
  changes.push({ fieldName, originalValue: originalValue ?? "", newValue: newValue ?? "" });
}

function getValidationIssues(error: z.ZodError) {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");

    if (path === "changes") return "At least one amendment change is required.";
    if (path === "changes.parcelList") {
      if (issue.code === "too_big") return `Number of Parcels (PCS) must be ${maxParcelsPerShipment} or fewer.`;
      return "At least one parcel is required.";
    }
    const itemsPath = path.match(/^changes\.parcelList\.(\d+)\.items$/);
    if (itemsPath && issue.code === "too_big") return `Parcel ${Number(itemsPath[1]) + 1} can contain at most ${maxParcelItems} items.`;
    if (path.endsWith(".weightKg")) return "Parcel weight must be zero or greater.";
    if (path.endsWith(".contentsDescription")) return "Parcel contents description is required.";
    if (path.endsWith(".townOrCity")) return "Town or city must be 80 characters or fewer.";
    if (path.endsWith(".postcode")) return "Postcode must be 20 characters or fewer.";

    return issue.message;
  });
}

function snapshotDraft(draft: ShipmentDraftForAmendment) {
  const address = draft.consigneeEnteredAddress;

  return {
    businessAccountId: draft.businessAccountId,
    consigneeEnteredAddress: {
      companyName: address.companyName ?? "",
      contactName: address.contactName ?? "",
      email: address.email ?? "",
      mobileCountryCode: address.mobileCountryCode ?? "",
      mobileNumber: address.mobileNumber ?? "",
      countryCode: address.countryCode,
      countryName: address.countryName ?? "",
      postcode: address.postcode,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 ?? "",
      townOrCity: address.townOrCity,
      county: address.county ?? "",
      deliveryInstructions: address.deliveryInstructions ?? ""
    },
    parcelList: draft.parcelList.map((parcel, index) => ({
      sequence: parcel.sequence ?? index + 1,
      weightKg: parcel.weightKg,
      lengthCm: parcel.lengthCm ?? null,
      widthCm: parcel.widthCm ?? null,
      heightCm: parcel.heightCm ?? null,
      shipmentContentType: parcel.shipmentContentType,
      // Items carry the per-item HSN codes; contentsDescription stays the derived
      // summary so an amendment round-trip cannot lose either one.
      items: normalizeParcelItems(parcel),
      contentsDescription: parcel.contentsDescription,
      shipmentReference1: parcel.shipmentReference1 ?? "",
      shipmentReference2: parcel.shipmentReference2 ?? ""
    })),
    serviceType: draft.serviceType,
    // Preserved so an amendment reprice keeps the shipment's original CSB route
    // and its clearance charge.
    csbType: normalizeCsbType(draft.csbType),
    addressValidationStatus: draft.addressValidationStatus,
    status: draft.status
  };
}

function getRequestedAppliedChanges(draft: ShipmentDraftForAmendment, changes: AmendmentChanges) {
  const appliedChanges: AppliedChange[] = [];
  const baseline = snapshotDraft(draft);

  if (changes.serviceType) {
    addAppliedChange(appliedChanges, "serviceType", baseline.serviceType, changes.serviceType);
  }

  if (changes.consigneeEnteredAddress) {
    const originalAddress = baseline.consigneeEnteredAddress as Record<string, unknown>;

    for (const [fieldName, newValue] of Object.entries(changes.consigneeEnteredAddress)) {
      addAppliedChange(appliedChanges, `consigneeEnteredAddress.${fieldName}`, originalAddress[fieldName], newValue);
    }
  }

  if (changes.parcelList) {
    changes.parcelList.forEach((nextParcel, index) => {
      const originalParcel = (baseline.parcelList[index] ?? {}) as Record<string, unknown>;

      for (const [fieldName, newValue] of Object.entries(nextParcel)) {
        addAppliedChange(appliedChanges, `parcelList.${index}.${fieldName}`, originalParcel[fieldName], newValue);
      }
    });
  }

  return appliedChanges;
}

function readSnapshotValue(snapshot: DraftSnapshot, fieldName: string) {
  if (fieldName === "serviceType") return snapshot.serviceType;

  if (fieldName.startsWith("consigneeEnteredAddress.")) {
    const key = fieldName.replace("consigneeEnteredAddress.", "");
    return (snapshot.consigneeEnteredAddress as Record<string, unknown>)[key];
  }

  const parcelMatch = fieldName.match(/^parcelList\.(\d+)\.(.+)$/);
  if (!parcelMatch) return undefined;
  const parcel = snapshot.parcelList[Number(parcelMatch[1])];
  const parcelField = parcelMatch[2];
  return parcel && parcelField ? (parcel as Record<string, unknown>)[parcelField] : undefined;
}

function applyChangesToSnapshot(snapshot: DraftSnapshot, changes: AppliedChange[]): DraftSnapshot {
  // `structuredClone` does not preserve a Mongoose ObjectId as an ObjectId.
  // Keep the original account reference so amendment repricing can still resolve
  // the business account's current rate-card band.
  const next = {
    ...structuredClone(snapshot),
    businessAccountId: snapshot.businessAccountId
  } as DraftSnapshot;

  for (const change of changes) {
    if (change.fieldName === "serviceType") {
      next.serviceType = change.newValue as DraftSnapshot["serviceType"];
      continue;
    }

    if (change.fieldName.startsWith("consigneeEnteredAddress.")) {
      const key = change.fieldName.replace("consigneeEnteredAddress.", "");
      (next.consigneeEnteredAddress as Record<string, unknown>)[key] = change.newValue;
      continue;
    }

    const parcelMatch = change.fieldName.match(/^parcelList\.(\d+)\.(.+)$/);
    if (!parcelMatch) continue;
    const parcel = next.parcelList[Number(parcelMatch[1])];
    const parcelField = parcelMatch[2];
    if (parcel && parcelField) (parcel as Record<string, unknown>)[parcelField] = change.newValue;
  }

  return next;
}

async function getPricingImpact(
  current: DraftSnapshot,
  requested: DraftSnapshot,
  session?: mongoose.ClientSession,
  currentPricing?: ShipmentPricingEstimate,
  repriceRequested = true
): Promise<PricingImpact> {
  const currentEstimate = currentPricing ?? await calculateShipmentPricingEstimate({
      ...buildPricingInputFromDraft(current),
      session
    });
  const requestedEstimate = repriceRequested
    ? await calculateShipmentPricingEstimate({
        ...buildPricingInputFromDraft(requested),
        // A booked shipment keeps its original GST/no-GST treatment through all
        // approved amendments, even if the account permission later changes.
        gstRate: currentEstimate.gstRate,
        session
      })
    : currentEstimate;

  return {
    current: currentEstimate,
    requested: requestedEstimate,
    deltaAmount: requestedEstimate.totalAmount - currentEstimate.totalAmount
  };
}

function applyRequestedChanges(draft: IShipmentDraft, appliedChanges: AppliedChange[]) {
  const requestedSnapshot = applyChangesToSnapshot(snapshotDraft(draft), appliedChanges);

  draft.serviceType = requestedSnapshot.serviceType;
  draft.set("consigneeEnteredAddress", requestedSnapshot.consigneeEnteredAddress);
  draft.set("parcelList", requestedSnapshot.parcelList);
  draft.parcelCount = requestedSnapshot.parcelList.length;

  if (appliedChanges.some((change) => change.fieldName.startsWith("consigneeEnteredAddress."))) {
    draft.addressValidationStatus = "NOT_VALIDATED";
    draft.consigneeValidatedAddress = null;
  }

  // Amendments only touch consignee, parcel, and service fields. Shipments booked
  // before consignor capture existed must not be failed for missing consignor KYC.
  // Amendments run against shipments booked before consignor capture and before
  // per-item HSN codes existed, so neither is demanded retroactively here.
  draft.validationIssues = validateShipmentDraftFields(draft, {
    requireConsignorDetails: false,
    requireItemHsnCodes: false
  });
  draft.status = draft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";

  return requestedSnapshot;
}

function getConflictingChanges(current: DraftSnapshot, requestedChanges: AppliedChange[]) {
  return requestedChanges.filter((change) => valuesDiffer(readSnapshotValue(current, change.fieldName), change.originalValue));
}

function pricingEstimatesMatch(first: ShipmentPricingEstimate, second: ShipmentPricingEstimate) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function affectsPricing(changes: AppliedChange[]) {
  return changes.some((change) =>
    change.fieldName === "serviceType"
    || change.fieldName === "consigneeEnteredAddress.countryCode"
    || /^parcelList\.\d+\.(weightKg|lengthCm|widthCm|heightCm)$/.test(change.fieldName)
  );
}

async function getCurrentInvoicePricing(
  shipmentDraftId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
) {
  const invoiceQuery = ShipmentInvoice.findOne({ shipmentDraftId });
  if (session) invoiceQuery.session(session);
  const invoice = await invoiceQuery.exec();
  if (!invoice) throw new AmendmentReviewError(409, "Shipment billing information is incomplete.");

  const pricing = invoice.pricingSnapshot as unknown as ShipmentPricingEstimate;
  if (!pricing || !Number.isFinite(pricing.totalAmount) || Math.round(pricing.totalAmount * 100) !== invoice.totalAmountMinor) {
    throw new AmendmentReviewError(409, "The existing shipment invoice pricing is inconsistent.");
  }
  return pricing;
}

async function assertShipmentCanBeAmended(
  shipmentDraftId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
) {
  const dpdShipmentQuery = DpdShipment.findOne({ shipmentDraftId });
  const blockingEventQuery = ShipmentEvent.findOne({
    shipmentDraftId,
    status: { $in: postParcelCollectedStatuses }
  }).lean();
  const cancellationQuery = ShipmentCancellation.findOne({
    shipmentDraftId,
    status: { $in: ["REQUESTED", "COMPLETED"] }
  }).select("status").lean();
  if (session) {
    dpdShipmentQuery.session(session);
    blockingEventQuery.session(session);
    cancellationQuery.session(session);
  }

  const dpdShipment = await dpdShipmentQuery.exec();
  const blockingEvent = await blockingEventQuery.exec();
  const cancellation = await cancellationQuery.exec();

  if (!dpdShipment) {
    return {
      allowed: false as const,
      message: "Only booked shipments can be amended.",
      dpdShipment: null
    };
  }
  if (dpdShipment.status !== "LABEL_RECEIVED") {
    return {
      allowed: false as const,
      message: "Complete the shipment documents before requesting an amendment.",
      dpdShipment
    };
  }
  if (cancellation) {
    return {
      allowed: false as const,
      message: cancellation.status === "COMPLETED"
        ? "This shipment has been cancelled and can no longer be amended."
        : "This shipment has a pending cancellation request. Resolve it before requesting an amendment.",
      dpdShipment
    };
  }

  if (blockingEvent) {
    return {
      allowed: false as const,
      message: "Shipment amendments are blocked after Parcel Collected.",
      dpdShipment
    };
  }

  // A prior charge verification remains an immutable audit snapshot. Any
  // approved amendment creates a revised invoice and a separate adjustment.
  return { allowed: true as const, message: "", dpdShipment };
}

async function buildAmendmentPreview(
  shipmentDraft: IShipmentDraft,
  changes: AmendmentChanges,
  dpdShipmentId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId
) {
  const previousSnapshot = snapshotDraft(shipmentDraft);
  const requestedChanges = getRequestedAppliedChanges(shipmentDraft, changes);
  if (!requestedChanges.length) {
    throw new AmendmentReviewError(400, "No amendment changes were detected.");
  }

  const requestedSnapshot = applyChangesToSnapshot(previousSnapshot, requestedChanges);
  const pricingChanges = affectsPricing(requestedChanges);
  if (!await ShipmentInvoice.exists({ shipmentDraftId: shipmentDraft._id })) {
    try {
      await ensureShipmentInvoiceForDraft({
        shipmentDraftId: shipmentDraft._id as mongoose.Types.ObjectId,
        dpdShipmentId,
        userId
      });
    } catch (error) {
      if (error instanceof ShipmentInvoiceServiceError) {
        throw new AmendmentReviewError(error.statusCode, error.message);
      }
      throw error;
    }
  }
  const currentPricing = await getCurrentInvoicePricing(shipmentDraft._id as mongoose.Types.ObjectId);
  const pricingImpact = await getPricingImpact(
    previousSnapshot,
    requestedSnapshot,
    undefined,
    currentPricing,
    pricingChanges
  );
  if (pricingChanges && pricingImpact.requested.missingRate) {
    throw new AmendmentReviewError(
      409,
      "Charges cannot be calculated because an applicable rate slab is missing. Contact your assigned branch."
    );
  }

  const fundingPreview = await previewAmendmentFunding({
    shipmentDraftId: shipmentDraft._id as mongoose.Types.ObjectId,
    businessAccountId: shipmentDraft.businessAccountId as mongoose.Types.ObjectId,
    pricing: pricingImpact.requested
  });

  return {
    previousSnapshot,
    requestedChanges,
    requestedSnapshot,
    pricingImpact,
    fundingPreview
  };
}

export async function previewShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment not found" });

  const parsed = createShipmentAmendmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Shipment amendment is invalid.",
      errors: getValidationIssues(parsed.error)
    });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment not found" });

  const amendmentGate = await assertShipmentCanBeAmended(shipmentDraft._id as mongoose.Types.ObjectId);
  if (!amendmentGate.allowed) {
    return response.status(409).json({ success: false, message: amendmentGate.message });
  }

  try {
    const preview = await buildAmendmentPreview(
      shipmentDraft,
      parsed.data.changes,
      amendmentGate.dpdShipment._id as mongoose.Types.ObjectId,
      userId
    );
    return response.status(200).json({
      success: true,
      pricingImpact: preview.pricingImpact,
      fundingPreview: preview.fundingPreview
    });
  } catch (error) {
    if (error instanceof AmendmentReviewError || error instanceof AmendmentBillingError || error instanceof RateCardRequiredError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

export async function createShipmentAmendment(
  request: Request,
  response: Response,
  actorRole: "admin" | "client" = "admin"
): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment not found" });

  const parsed = createShipmentAmendmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Shipment amendment is invalid.",
      errors: getValidationIssues(parsed.error)
    });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment not found" });

  const amendmentGate = await assertShipmentCanBeAmended(shipmentDraft._id as mongoose.Types.ObjectId);
  if (!amendmentGate.allowed) {
    return response.status(409).json({ success: false, message: amendmentGate.message });
  }

  let preview: Awaited<ReturnType<typeof buildAmendmentPreview>>;
  try {
    preview = await buildAmendmentPreview(
      shipmentDraft,
      parsed.data.changes,
      amendmentGate.dpdShipment._id as mongoose.Types.ObjectId,
      userId
    );
  } catch (error) {
    if (error instanceof AmendmentReviewError || error instanceof AmendmentBillingError || error instanceof RateCardRequiredError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
  if (!preview.fundingPreview.canFund) {
    return response.status(402).json({
      success: false,
      message: preview.fundingPreview.message,
      fundingPreview: preview.fundingPreview
    });
  }

  const amendment = await ShipmentAmendment.create({
    shipmentDraftId: shipmentDraft._id,
    dpdShipmentId: amendmentGate.dpdShipment._id,
    businessAccountId: shipmentDraft.businessAccountId,
    branchId: shipmentDraft.branchId,
    requestedBy: userId,
    actorRole,
    status: "REQUESTED",
    reason: parsed.data.reason,
    requestedChanges: parsed.data.changes,
    previousSnapshot: preview.previousSnapshot,
    requestedSnapshot: preview.requestedSnapshot,
    changePreview: preview.requestedChanges,
    pricingImpact: preview.pricingImpact,
    fundingPreview: preview.fundingPreview,
    appliedChanges: [],
    requestedAt: new Date()
  });

  await AuditLog.create({
    action: "SHIPMENT_AMENDMENT_REQUESTED",
    entityType: "SHIPMENT_AMENDMENT",
    entityId: amendment._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      shipmentDraftId: shipmentDraft._id,
      dpdShipmentId: amendmentGate.dpdShipment._id,
      actorRole,
      changeCount: preview.requestedChanges.length,
      changedFields: preview.requestedChanges.map((change) => change.fieldName)
    }
  });

  // An admin raising the amendment is already in the review queue, so only a
  // client-raised request needs to reach the operations team.
  if (actorRole === "client") {
    await notifyActiveAdmins({
      type: "SHIPMENT_AMENDMENT_REQUESTED",
      title: "Shipment amendment requested",
      message: `A client requested ${preview.requestedChanges.length} change(s) to shipment `
        + `${amendmentGate.dpdShipment.swiftlineTrackingNumber || String(shipmentDraft._id)}.`,
      href: `/dashboard/amendments#amendment-${String(amendment._id)}`,
      idempotencyKey: `SHIPMENT_AMENDMENT_REQUESTED:${String(amendment._id)}`,
      businessAccountId: shipmentDraft.businessAccountId,
      metadata: { amendmentId: amendment._id, shipmentDraftId: shipmentDraft._id }
    });
  }

  return response.status(200).json({
    success: true,
    amendment
  });
}

export async function createAdminShipmentAmendment(request: Request, response: Response): Promise<Response> {
  return createShipmentAmendment(request, response, "admin");
}

export async function listShipmentAmendments(request: Request, response: Response): Promise<Response> {
  const limitValue = typeof request.query.limit === "string" ? Number(request.query.limit) : 50;
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(limitValue, 1), 100) : 50;
  const pageValue = typeof request.query.page === "string" ? Number(request.query.page) : 1;
  const requestedPage = Number.isFinite(pageValue) ? Math.max(1, pageValue) : 1;
  const status = typeof request.query.status === "string" ? request.query.status : "";
  const filters: Record<string, unknown> = {};

  if (status) filters.status = status;
  const { dateFrom, dateTo } = dateRangeParams(request.query);
  const requestedAt = dateRangeCondition(dateFrom, dateTo);
  if (requestedAt) filters.requestedAt = requestedAt;

  const total = await ShipmentAmendment.countDocuments(filters).exec();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const amendments = await ShipmentAmendment.find(filters)
    .sort({ requestedAt: -1, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean()
    .exec();
  const draftIds = amendments.map((amendment) => amendment.shipmentDraftId);
  const branchIds = amendments.map((amendment) => amendment.branchId);
  const dpdShipmentIds = amendments.map((amendment) => amendment.dpdShipmentId);

  const [drafts, branches, dpdShipments] = await Promise.all([
    ShipmentDraft.find({ _id: { $in: draftIds } }).lean().exec(),
    Branch.find({ _id: { $in: branchIds } }).lean().exec(),
    DpdShipment.find({ _id: { $in: dpdShipmentIds } }).lean().exec()
  ]);

  const draftsById = new Map(drafts.map((draft) => [String(draft._id), draft]));
  const branchesById = new Map(branches.map((branch) => [String(branch._id), branch]));
  const dpdShipmentsById = new Map(dpdShipments.map((shipment) => [String(shipment._id), shipment]));

  const amendmentRows = await Promise.all(amendments.map(async (amendment) => {
      const draft = draftsById.get(String(amendment.shipmentDraftId));
      const branch = branchesById.get(String(amendment.branchId));
      const dpdShipment = dpdShipmentsById.get(String(amendment.dpdShipmentId));
      const parsedChanges = createShipmentAmendmentSchema.shape.changes.safeParse(amendment.requestedChanges);
      const previousSnapshot = amendment.previousSnapshot as unknown as DraftSnapshot;
      const changePreview = amendment.changePreview?.length
        ? amendment.changePreview
        : parsedChanges.success
          ? getRequestedAppliedChanges(previousSnapshot as unknown as ShipmentDraftForAmendment, parsedChanges.data)
          : amendment.appliedChanges;
      const requestedSnapshot = amendment.requestedSnapshot
        ? amendment.requestedSnapshot as unknown as DraftSnapshot
        : applyChangesToSnapshot(previousSnapshot, changePreview);
      // Legacy records did not persist pricing. Their fallback is calculated once from their saved shipment snapshot.
      const pricingImpact = amendment.pricingImpact
        ? amendment.pricingImpact as unknown as PricingImpact
        : parsedChanges.success
          ? await getPricingImpact(previousSnapshot, requestedSnapshot)
          : null;
      const storedFundingPreview = amendment.fundingPreview as Record<string, unknown> | null;
      const fundingPreview = storedFundingPreview
        ? {
            ...storedFundingPreview,
            billingMode: storedFundingPreview.billingMode
              ?? (dpdShipment?.paymentSource === "TEST"
                ? "TEST"
                : dpdShipment?.paymentSource === "ADMIN_DIRECT"
                  ? "DIRECT"
                  : "BUSINESS_ACCOUNT")
          }
        : null;

      return {
        id: amendment._id,
        shipmentDraftId: amendment.shipmentDraftId,
        dpdShipmentId: amendment.dpdShipmentId,
        shipmentId: dpdShipment?.dpdShipmentId || String(amendment.dpdShipmentId),
        consignee: draft?.consigneeEnteredAddress?.companyName || draft?.consigneeEnteredAddress?.contactName || "Not set",
        branch: branch
          ? {
              id: branch._id,
              name: branch.name,
              code: branch.code,
              city: branch.address?.city ?? ""
            }
          : null,
        status: amendment.status,
        actorRole: amendment.actorRole,
        reason: amendment.reason,
        requestedChanges: amendment.requestedChanges,
        changePreview,
        pricingImpact,
        fundingPreview,
        billingAdjustment: amendment.billingAdjustment ?? null,
        appliedChanges: amendment.appliedChanges,
        reviewNote: amendment.reviewNote ?? "",
        requestedAt: amendment.requestedAt,
        reviewedAt: amendment.reviewedAt ?? null,
        appliedAt: amendment.appliedAt ?? null
      };
    }));

  return response.status(200).json({
    success: true,
    amendments: amendmentRows,
    pagination: { page, limit, total, totalPages }
  });
}

export async function approveShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const amendmentId = getAmendmentId(request);
  if (!amendmentId) return response.status(404).json({ success: false, message: "Amendment not found" });

  const parsed = reviewShipmentAmendmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Review note is invalid." });
  }

  const session = await mongoose.startSession();
  let result: {
    amendment: unknown;
    shipmentDraft: unknown;
    dpdShipmentId: mongoose.Types.ObjectId;
  } | null = null;

  try {
    await session.withTransaction(async () => {
      const amendment = await ShipmentAmendment.findById(amendmentId).session(session).exec();
      if (!amendment) throw new AmendmentReviewError(404, "Amendment not found");
      if (amendment.status !== "REQUESTED") {
        throw new AmendmentReviewError(409, "Only requested amendments can be approved.");
      }

      const shipmentDraft = await ShipmentDraft.findById(amendment.shipmentDraftId).session(session).exec();
      if (!shipmentDraft) throw new AmendmentReviewError(404, "Shipment not found");

      const amendmentGate = await assertShipmentCanBeAmended(
        shipmentDraft._id as mongoose.Types.ObjectId,
        session
      );
      if (!amendmentGate.allowed) throw new AmendmentReviewError(409, amendmentGate.message);

      const parsedChanges = createShipmentAmendmentSchema.shape.changes.safeParse(amendment.requestedChanges);
      if (!parsedChanges.success) {
        throw new AmendmentReviewError(400, "Saved amendment changes are invalid.");
      }

      const previousSnapshot = amendment.previousSnapshot as unknown as DraftSnapshot;
      const changePreview = amendment.changePreview.length
        ? amendment.changePreview
        : getRequestedAppliedChanges(previousSnapshot as unknown as ShipmentDraftForAmendment, parsedChanges.data);
      if (!changePreview.length) throw new AmendmentReviewError(400, "No amendment changes were detected.");

      const currentSnapshot = snapshotDraft(shipmentDraft);
      const conflicts = getConflictingChanges(currentSnapshot, changePreview);
      if (conflicts.length) {
        throw new AmendmentReviewError(
          409,
          "Shipment details changed after this amendment was requested. Review the latest shipment and submit a new amendment."
        );
      }

      const requestedSnapshot = applyChangesToSnapshot(currentSnapshot, changePreview);
      if (requestedSnapshot.parcelList.length !== currentSnapshot.parcelList.length) {
        throw new AmendmentReviewError(
          409,
          "Parcel count cannot be changed after booking. Create a new shipment for additional parcels."
        );
      }
      const pricingChanges = affectsPricing(changePreview);
      const currentPricing = await getCurrentInvoicePricing(
        shipmentDraft._id as mongoose.Types.ObjectId,
        session
      );
      const livePricingImpact = await getPricingImpact(
        currentSnapshot,
        requestedSnapshot,
        session,
        currentPricing,
        pricingChanges
      );
      const savedPricingImpact = amendment.pricingImpact as unknown as PricingImpact | null;

      if (pricingChanges && savedPricingImpact && !pricingEstimatesMatch(savedPricingImpact.requested, livePricingImpact.requested)) {
        throw new AmendmentReviewError(
          409,
          "The applicable rate card changed after this amendment was requested. Submit a new amendment with refreshed charges."
        );
      }

      if (pricingChanges && livePricingImpact.requested.missingRate) {
        throw new AmendmentReviewError(
          409,
          "This amendment cannot be approved because one or more parcels do not have an applicable rate slab."
        );
      }

      let billingAdjustment: Awaited<ReturnType<typeof applyApprovedAmendmentBilling>>;
      try {
        billingAdjustment = await applyApprovedAmendmentBilling({
          amendmentId: amendment._id as mongoose.Types.ObjectId,
          shipmentDraftId: shipmentDraft._id as mongoose.Types.ObjectId,
          businessAccountId: amendment.businessAccountId,
          pricing: livePricingImpact.requested,
          createdBy: userId,
          session
        });
      } catch (error) {
        if (error instanceof AmendmentBillingError) {
          throw new AmendmentReviewError(error.statusCode, error.message);
        }
        throw error;
      }

      // A walk-in settles any amendment delta at the counter, so the movement is
      // recorded here alongside the revised invoice. `deltaAmountMinor` carries the
      // direction: positive means the customer paid more, negative means money went
      // back to them.
      if (shipmentDraft.customerType === "INDIVIDUAL" && billingAdjustment.deltaAmountMinor !== 0) {
        if (!parsed.data.counterPayment) {
          throw new AmendmentReviewError(
            400,
            billingAdjustment.deltaAmountMinor > 0
              ? "Record how the customer paid the additional amount before approving this amendment."
              : "Record how the difference was refunded to the customer before approving this amendment."
          );
        }

        await CounterPayment.create([{
          shipmentDraftId: shipmentDraft._id,
          branchId: shipmentDraft.branchId,
          direction: billingAdjustment.deltaAmountMinor > 0 ? "COLLECTED" : "REFUNDED",
          amountMinor: Math.abs(billingAdjustment.deltaAmountMinor),
          method: parsed.data.counterPayment.method,
          reference: parsed.data.counterPayment.reference ?? "",
          note: parsed.data.counterPayment.note ?? "",
          recordedBy: userId,
          recordedAt: new Date()
        }], { session });
      }

      applyRequestedChanges(shipmentDraft, changePreview);
      shipmentDraft.bookingState = "REVIEW_REQUIRED";
      await shipmentDraft.save({ session });
      const revisedInvoice = await ensureShipmentInvoiceForDraft({
        shipmentDraftId: shipmentDraft._id as mongoose.Types.ObjectId,
        dpdShipmentId: amendment.dpdShipmentId,
        userId,
        revise: true,
        paymentAllocation: {
          advanceAppliedMinor: billingAdjustment.advanceAppliedMinor,
          creditOutstandingMinor: billingAdjustment.creditOutstandingMinor
        },
        settledAmountMinor: billingAdjustment.settledAmountMinor,
        pricingOverride: livePricingImpact.requested,
        session
      });

      const previousShipmentSnapshot = readShipmentBookingSnapshot(
        amendmentGate.dpdShipment.currentShipmentSnapshot
      ) ?? readShipmentBookingSnapshot(amendmentGate.dpdShipment.bookingSnapshot);
      if (!previousShipmentSnapshot) {
        throw new AmendmentReviewError(
          409,
          "The locked shipment snapshot is unavailable. Contact technical support before approving this amendment."
        );
      }
      amendmentGate.dpdShipment.currentShipmentSnapshot = buildRevisedShipmentSnapshot({
        previousSnapshot: previousShipmentSnapshot,
        draft: shipmentDraft,
        pricing: livePricingImpact.requested,
        advanceAmountMinor: billingAdjustment.advanceAppliedMinor,
        creditAmountMinor: billingAdjustment.creditOutstandingMinor
      }) as unknown as Record<string, unknown>;
      amendmentGate.dpdShipment.snapshotRevision = (amendmentGate.dpdShipment.snapshotRevision || 1) + 1;
      amendmentGate.dpdShipment.status = "DPD_CREATED";
      await amendmentGate.dpdShipment.save({ session });

      const reviewedAt = new Date();
      amendment.status = "APPROVED";
      amendment.reviewedBy = userId;
      amendment.reviewNote = parsed.data.note;
      amendment.reviewedAt = reviewedAt;
      amendment.appliedAt = reviewedAt;
      amendment.changePreview = changePreview;
      amendment.appliedChanges = changePreview;
      amendment.requestedSnapshot = requestedSnapshot;
      amendment.resultingSnapshot = snapshotDraft(shipmentDraft);
      amendment.pricingImpact = (savedPricingImpact ?? livePricingImpact) as unknown as Record<string, unknown>;
      amendment.billingAdjustment = billingAdjustment as unknown as Record<string, unknown>;
      await amendment.save({ session });

      await AuditLog.create([{
        action: "SHIPMENT_AMENDMENT_APPLIED",
        entityType: "SHIPMENT_AMENDMENT",
        entityId: amendment._id,
        performedBy: userId,
        performedAt: reviewedAt,
        metadata: {
          shipmentDraftId: shipmentDraft._id,
          dpdShipmentId: amendment.dpdShipmentId,
          changeCount: changePreview.length,
          changedFields: changePreview.map((change) => change.fieldName),
          previousCharge: livePricingImpact.current.totalAmount,
          approvedCharge: livePricingImpact.requested.totalAmount,
          billingAdjustment,
          invoiceNumber: revisedInvoice.invoiceNumber,
          invoiceRevision: revisedInvoice.revision
        }
      }], { session });

      await notifyBusinessShipmentMembers(amendment.businessAccountId, {
        type: "SHIPMENT_AMENDMENT_APPROVED",
        title: "Shipment amendment approved",
        message: `${changePreview.length} change(s) were applied to your shipment. `
          + `Revised invoice ${revisedInvoice.invoiceNumber} is available.`,
        href: `/client/shipments/${String(shipmentDraft._id)}#shipment-amendments`,
        idempotencyKey: `SHIPMENT_AMENDMENT_APPROVED:${String(amendment._id)}`,
        metadata: { amendmentId: amendment._id, shipmentDraftId: shipmentDraft._id }
      }, session);

      result = {
        amendment,
        shipmentDraft,
        dpdShipmentId: amendmentGate.dpdShipment._id as mongoose.Types.ObjectId
      };
    });
  } catch (error) {
    if (error instanceof AmendmentReviewError || error instanceof RateCardRequiredError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  if (!result) return response.status(500).json({ success: false, message: "Amendment approval did not complete." });
  const approvalResult = result as {
    amendment: unknown;
    shipmentDraft: unknown;
    dpdShipmentId: mongoose.Types.ObjectId;
  };
  let documentWarning = "";
  try {
    await regenerateShipmentLabels(approvalResult.dpdShipmentId, userId);
  } catch (error) {
    console.error("Approved amendment requires document reconciliation.", error);
    documentWarning = "The amendment was approved, but its revised labels require Swiftline Operations review.";
  }
  return response.status(200).json({
    success: true,
    message: documentWarning || "Amendment approved and shipment documents updated.",
    documentWarning,
    amendment: approvalResult.amendment,
    shipmentDraft: approvalResult.shipmentDraft
  });
}

export async function rejectShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const amendmentId = getAmendmentId(request);
  if (!amendmentId) return response.status(404).json({ success: false, message: "Amendment not found" });

  const parsed = reviewShipmentAmendmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Review note is invalid." });
  }

  const amendment = await ShipmentAmendment.findById(amendmentId).exec();
  if (!amendment) return response.status(404).json({ success: false, message: "Amendment not found" });
  if (amendment.status !== "REQUESTED") {
    return response.status(409).json({ success: false, message: "Only requested amendments can be rejected." });
  }

  amendment.status = "REJECTED";
  amendment.reviewedBy = userId;
  amendment.reviewNote = parsed.data.note;
  amendment.reviewedAt = new Date();
  await amendment.save();

  await AuditLog.create({
    action: "SHIPMENT_AMENDMENT_REJECTED",
    entityType: "SHIPMENT_AMENDMENT",
    entityId: amendment._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      shipmentDraftId: amendment.shipmentDraftId,
      dpdShipmentId: amendment.dpdShipmentId
    }
  });

  await notifyBusinessShipmentMembers(amendment.businessAccountId, {
    type: "SHIPMENT_AMENDMENT_REJECTED",
    title: "Shipment amendment rejected",
    message: amendment.reviewNote
      ? `Your amendment request was not approved. Reason: ${amendment.reviewNote}`
      : "Your amendment request was not approved. Contact your Swiftline branch for details.",
    href: `/client/shipments/${String(amendment.shipmentDraftId)}#shipment-amendments`,
    idempotencyKey: `SHIPMENT_AMENDMENT_REJECTED:${String(amendment._id)}`,
    metadata: { amendmentId: amendment._id, shipmentDraftId: amendment.shipmentDraftId }
  });

  return response.status(200).json({ success: true, amendment });
}
