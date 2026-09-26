import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { IShipmentDraft, ShipmentDraft, shipmentContentTypeValues, shipmentServiceTypeValues } from "../models/shipmentDraft.model.js";
import { ShipmentImportEntry } from "../models/shipmentImportEntry.model.js";
import { buildShipmentPayload, validateShipmentPayload } from "../services/shipmentPayload.service.js";
import { deleteObject } from "../services/storage/storage.service.js";
import { maskAadhaarNumber, normalizeAadhaarNumber } from "../services/aadhaarValidation.service.js";
import { csbTypeValues } from "../services/csbType.service.js";
import {
  defaultParcelItemUnitType,
  maxParcelsPerShipment,
  maxParcelItems,
  normalizeParcelItems
} from "../services/parcelItems.service.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";
import {
  assertShipmentDraftMutationAllowed,
  ShipmentDraftPolicyError,
  syncLegacyDraftBookingState
} from "../services/shipmentDraftPolicy.service.js";
import {
  deleteShipmentDrafts as softDeleteShipmentDrafts,
  deleteShipmentDraft as softDeleteShipmentDraft,
  restoreShipmentDraft as undoShipmentDraftDeletion
} from "../services/shipmentDraftDeletion.service.js";
import {
  createBlankShipmentDraft,
  createIndividualShipmentDraft,
  ManualShipmentDraftError
} from "../services/manualShipmentDraft.service.js";
import { rebookShipmentDraft } from "../services/rebookShipmentDraft.service.js";
import { buildShipmentCostEstimate } from "../services/shipmentCostEstimate.service.js";
import { getDeclaredGoodsValue } from "../services/parcelItems.service.js";
import { RateCardRequiredError } from "../services/shipmentPricing.service.js";
import { resolveRateCardBand } from "../services/shipmentPricing.service.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { operationsBranchIds } from "../middleware/operationsBranchAccess.middleware.js";

const manualDraftSchema = z.object({
  businessAccountId: z.string().trim().min(1),
  branchId: z.string().trim().min(1)
});

const bulkDraftDeleteSchema = z.object({
  shipmentDraftIds: z.array(
    z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Shipment draft id is invalid.")
  ).min(1, "Select at least one shipment draft.").max(100, "Select no more than 100 shipment drafts.")
}).refine(
  (value) => new Set(value.shipmentDraftIds).size === value.shipmentDraftIds.length,
  { message: "A shipment draft was selected more than once." }
);

// A walk-in has no account to select, so the payer's identity is captured here
// instead. Only name and mobile are mandatory: the rest of the address is
// completed during draft review like any other shipment.
const individualDraftSchema = z.object({
  branchId: z.string().trim().min(1),
  customer: z.object({
    // Only the name is taken at the counter; the rest of the sender's details are
    // captured on the draft form itself and enforced before booking.
    contactName: z.string().trim().toUpperCase().min(1).max(120),
    mobileCountryCode: z.string().trim().max(8).optional(),
    mobileNumber: z.string().trim().max(30).optional(),
    email: z.string().trim().max(160).optional(),
    aadhaarNumber: z.string().trim().max(20).optional(),
    addressLine1: z.string().trim().toUpperCase().max(120).optional(),
    addressLine2: z.string().trim().toUpperCase().max(120).optional(),
    townOrCity: z.string().trim().toUpperCase().max(80).optional(),
    county: z.string().trim().toUpperCase().max(80).optional(),
    postcode: z.string().trim().max(20).optional(),
    pickupInstructions: z.string().trim().toUpperCase().max(500).optional()
  })
});

const addressPatchSchema = z.object({
  companyName: z.string().trim().toUpperCase().max(120).optional(),
  contactName: z.string().trim().toUpperCase().max(120).optional(),
  email: z.string().trim().max(160).optional(),
  mobileCountryCode: z.string().trim().max(8).optional(),
  mobileNumber: z.string().trim().max(30).optional(),
  // Blank is accepted so an incomplete draft can be saved; a real two-letter code
  // is still required before booking, which validateShipmentDraftFields enforces.
  countryCode: z.string().trim().toUpperCase().length(2).or(z.literal("")).optional(),
  countryName: z.string().trim().toUpperCase().max(80).optional(),
  postcode: z.string().trim().toUpperCase().max(20).optional(),
  addressLine1: z.string().trim().toUpperCase().max(120).optional(),
  addressLine2: z.string().trim().toUpperCase().max(120).optional(),
  townOrCity: z.string().trim().toUpperCase().max(80).optional(),
  county: z.string().trim().toUpperCase().max(80).optional(),
  stateCode: z.string().trim().toUpperCase().max(20).optional(),
  deliveryInstructions: z.string().trim().toUpperCase().max(500).optional()
});

// Country, country name, and dialling code are pinned by the model, so they are
// intentionally absent here and cannot be overridden by a client.
const consignorPatchSchema = z.object({
  companyName: z.string().trim().toUpperCase().max(120).optional(),
  contactName: z.string().trim().toUpperCase().max(120).optional(),
  email: z.string().trim().max(160).optional(),
  mobileNumber: z.string().trim().max(30).optional(),
  aadhaarNumber: z.string().trim().max(20).transform((value) => normalizeAadhaarNumber(value)).optional(),
  postcode: z.string().trim().toUpperCase().max(20).optional(),
  addressLine1: z.string().trim().toUpperCase().max(120).optional(),
  addressLine2: z.string().trim().toUpperCase().max(120).optional(),
  townOrCity: z.string().trim().toUpperCase().max(80).optional(),
  county: z.string().trim().toUpperCase().max(80).optional(),
  pickupInstructions: z.string().trim().toUpperCase().max(500).optional()
});

const parcelPatchSchema = z.object({
  sequence: z.coerce.number().int().positive(),
  weightKg: z.coerce.number().nonnegative(),
  lengthCm: z.coerce.number().nonnegative().optional().nullable(),
  widthCm: z.coerce.number().nonnegative().optional().nullable(),
  heightCm: z.coerce.number().nonnegative().optional().nullable(),
  shipmentContentType: z.enum(shipmentContentTypeValues).default("PARCEL"),
  // Individual goods with their HSN codes. Blank entries are allowed here so a
  // partially filled draft can still be saved; completeness is enforced by
  // validateShipmentDraftFields before booking.
  items: z.array(z.object({
    description: z.string().trim().toUpperCase().max(120),
    // 4, 6, 8 or 10 digits; exact format is enforced by validateShipmentDraftFields.
    hsnCode: z.string().trim().max(10),
    unitType: z.string().trim().max(12).default(defaultParcelItemUnitType),
    quantity: z.coerce.number().min(0).max(1_000_000).default(0),
    unitRate: z.coerce.number().min(0).max(10_000_000).default(0)
  })).max(maxParcelItems).optional(),
  contentsDescription: z.string().trim().toUpperCase().max(120),
  shipmentReference1: z.string().trim().toUpperCase().max(120).optional(),
  shipmentReference2: z.string().trim().toUpperCase().max(120).optional(),
  // Per-parcel Aadhaar for shipments not sharing one KYC set. Uploaded files are
  // server-managed and preserved separately, never sent by the client.
  aadhaarNumber: z.string().trim().max(20).transform((value) => normalizeAadhaarNumber(value)).optional()
});

const draftPatchSchema = z.object({
  consignorAddress: consignorPatchSchema.optional(),
  consigneeEnteredAddress: addressPatchSchema.optional(),
  kycUseForAllParcels: z.boolean().optional(),
  parcelList: z.array(parcelPatchSchema).min(1).max(maxParcelsPerShipment).optional(),
  // Customs route for the shipment; drives the CSB-V clearance charge.
  csbType: z.enum(csbTypeValues).optional(),
  csbVGstin: z.string().trim().toUpperCase().max(20).optional(),
  csbVAccountNumber: z.string().trim().max(40).optional(),
  csbVInvoiceNumber: z.string().trim().max(80).optional(),
  // Optional transit cover; drives the insurance premium on the estimate.
  insuranceOptIn: z.boolean().optional(),
  forceGst: z.boolean().optional(),
  // Printed as the NOTE block on the customs (shipment) invoice.
  declarationNote: z.string().trim().toUpperCase().max(500).optional(),
  serviceType: z.enum(shipmentServiceTypeValues).optional(),
  serviceCode: z.string().trim().max(40).optional()
});

type FieldChange = {
  fieldName: string;
  originalValue: unknown;
  newValue: unknown;
  changedBy: string;
  changedAt: string;
  source: "manual";
};

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

function getAuthenticatedPortalRole(request: Request) {
  const user = (request as Request & { user?: { role?: unknown } }).user;
  return typeof user?.role === "string" ? user.role : "";
}

/**
 * Branches this caller may open a draft in, or null when unscoped.
 *
 * Only internal staff carry a branch assignment. Clients reach these handlers
 * through client.controller.ts, which resolves the branch from their own
 * account membership and overwrites the request body with it before delegating
 * here- so a client is already confined to its own branch, and reading a
 * branch assignment it does not have would refuse every client booking.
 */
function draftCreationBranchScope(request: Request) {
  return getAuthenticatedPortalRole(request) === "client" ? null : operationsBranchIds(request);
}

function sendDraftPolicyError(response: Response, error: unknown) {
  return error instanceof ShipmentDraftPolicyError
    ? response.status(error.statusCode).json({ success: false, message: error.message })
    : null;
}

function getDraftId(request: Request) {
  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  return mongoose.Types.ObjectId.isValid(draftId) ? draftId : "";
}

async function writeShipmentDraftAuditLog(
  action:
    | "SHIPMENT_DRAFT_UPDATED"
    | "SHIPMENT_VALIDATION_COMPLETED"
    | "SHIPMENT_DRAFT_DELETED"
    | "SHIPMENT_DRAFT_RESTORED",
  shipmentDraftId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  metadata: Record<string, unknown>
) {
  await AuditLog.create({
    action,
    entityType: "SHIPMENT_DRAFT",
    entityId: shipmentDraftId,
    performedBy: userId,
    performedAt: new Date(),
    metadata
  });
}

function valuesDiffer(originalValue: unknown, newValue: unknown) {
  return JSON.stringify(originalValue ?? "") !== JSON.stringify(newValue ?? "");
}

function recordFieldChange(
  changes: FieldChange[],
  fieldName: string,
  originalValue: unknown,
  newValue: unknown,
  userId: mongoose.Types.ObjectId,
  changedAt: string
) {
  if (!valuesDiffer(originalValue, newValue)) return;

  changes.push({
    fieldName,
    originalValue: originalValue ?? "",
    newValue: newValue ?? "",
    changedBy: String(userId),
    changedAt,
    source: "manual"
  });
}

function getDraftPatchValidationIssues(error: z.ZodError) {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");

    const itemsPath = path.match(/^parcelList\.(\d+)\.items$/);
    if (itemsPath && issue.code === "too_big") {
      return `Parcel ${Number(itemsPath[1]) + 1} can contain at most ${maxParcelItems} items`;
    }
    if (path === "parcelList") {
      if (issue.code === "too_big") return `Number of Parcels (PCS) must be ${maxParcelsPerShipment} or fewer`;
      return "At least one parcel is required";
    }
    if (path.endsWith(".sequence")) return "Parcel sequence must be a positive whole number";
    if (path.endsWith(".weightKg")) return "Parcel weight must be zero or greater";
    if (path.endsWith(".contentsDescription")) return "Parcel contents description is required";
    if (path === "serviceType") return "Service type must be Courier or Cargo";
    if (path === "serviceCode") return "Service code must be 40 characters or fewer";
    if (path === "consignorAddress.contactName") return "Consignor contact name must be 120 characters or fewer";
    if (path === "consignorAddress.email") return "Consignor email must be 160 characters or fewer";
    if (path === "consignorAddress.mobileNumber") return "Consignor mobile number must be 30 characters or fewer";
    if (path === "consignorAddress.aadhaarNumber") return "Aadhaar number must be 12 digits";
    if (path === "consignorAddress.addressLine1") return "Consignor address line 1 must be 120 characters or fewer";
    if (path === "consignorAddress.townOrCity") return "Consignor town or city must be 80 characters or fewer";
    if (path === "consignorAddress.postcode") return "Consignor PIN code must be 20 characters or fewer";
    if (path === "consigneeEnteredAddress.contactName") return "Contact name must be 120 characters or fewer";
    if (path === "consigneeEnteredAddress.mobileCountryCode") return "Mobile country code must be 8 characters or fewer";
    if (path === "consigneeEnteredAddress.mobileNumber") return "Mobile number must be 30 characters or fewer";
    if (path === "consigneeEnteredAddress.addressLine1") return "Address line 1 must be 120 characters or fewer";
    if (path === "consigneeEnteredAddress.townOrCity") return "Town or city must be 80 characters or fewer";
    if (path === "consigneeEnteredAddress.postcode") return "Postcode must be 20 characters or fewer";

    return issue.message;
  });
}

async function syncReviewValidationIssues(shipmentDraft: IShipmentDraft) {
  const reviewIssues = validateShipmentDraftFields(shipmentDraft);
  if (JSON.stringify(shipmentDraft.validationIssues ?? []) === JSON.stringify(reviewIssues)) return;

  shipmentDraft.validationIssues = reviewIssues;
  await shipmentDraft.save();
}

export async function getShipmentDraft(request: Request, response: Response): Promise<Response> {
  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const shipmentDraft = await ShipmentDraft.findOne({ _id: draftId, deletedAt: null }).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  try {
    const bookingState = await syncLegacyDraftBookingState(shipmentDraft);
    if (bookingState === "EDITABLE") {
      await syncReviewValidationIssues(shipmentDraft);
    }
  } catch {
    // Keep loading the draft even if the original invoice is no longer parseable.
  }

  return response.status(200).json({
    success: true,
    shipmentDraft,
    shipmentImport: await getShipmentImportSummary(shipmentDraft)
  });
}

/**
 * The in-progress form values the estimator prices.
 *
 * Every field is optional: the panel posts whatever the customer has filled in so
 * far, and anything missing falls back to what is stored on the draft. Only the
 * inputs that affect price are accepted- this endpoint reads, it never writes.
 */
const costEstimateSchema = z.object({
  countryCode: z.string().trim().toUpperCase().max(2).optional(),
  destinationPostcode: z.string().trim().max(20).optional(),
  serviceType: z.enum(shipmentServiceTypeValues).optional(),
  csbType: z.enum(csbTypeValues).optional(),
  insuranceOptIn: z.boolean().optional(),
  forceGst: z.boolean().optional(),
  parcels: z.array(z.object({
    sequence: z.coerce.number().int().positive().optional(),
    weightKg: z.coerce.number().nonnegative().optional(),
    lengthCm: z.coerce.number().nonnegative().optional(),
    widthCm: z.coerce.number().nonnegative().optional(),
    heightCm: z.coerce.number().nonnegative().optional(),
    // Priced only for the declared goods value that the insurance premium uses.
    items: z.array(z.object({
      quantity: z.coerce.number().nonnegative().optional(),
      unitRate: z.coerce.number().nonnegative().optional()
    })).max(maxParcelItems).optional()
  })).max(maxParcelsPerShipment).optional()
});

/**
 * Prices a shipment draft and previews how it would be paid for.
 *
 * Read-only, and safe to call on every keystroke the booking form debounces. The
 * returned `pricingHash` is what the customer is accepting: it goes back with the
 * booking call, and the booking is refused if the price has moved since.
 */
export async function getShipmentDraftCostEstimate(request: Request, response: Response): Promise<Response> {
  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const parsed = costEstimateSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Shipment details are invalid.",
      errors: parsed.error.issues.map((issue) => issue.message)
    });
  }

  const { parcels, ...scalarOverrides } = parsed.data;
  let estimate;
  try {
    estimate = await buildShipmentCostEstimate({
      draft: shipmentDraft,
      overrides: {
        ...scalarOverrides,
        ...(parcels
          ? {
            parcels,
            // Recomputed from the submitted items so the insurance premium tracks
            // the value the customer is currently declaring.
            declaredGoodsValue: getDeclaredGoodsValue(parcels)
          }
          : {})
      }
    });
  } catch (error) {
    if (error instanceof RateCardRequiredError) {
      return response.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    }
    throw error;
  }

  return response.status(200).json({ success: true, estimate });
}

export async function getShipmentDraftRateCardContext(request: Request, response: Response): Promise<Response> {
  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const draft = await ShipmentDraft.findById(draftId).select("businessAccountId").lean().exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  let band;
  try {
    band = await resolveRateCardBand({ businessAccountId: draft.businessAccountId });
  } catch (error) {
    if (error instanceof RateCardRequiredError && error.code === "RATE_CARD_REQUIRED") {
      return response.status(200).json({
        success: true,
        title: "Your Swiftline Rate Card",
        rateCardAssigned: false,
        rates: [],
        routeCharges: []
      });
    }
    throw error;
  }

  const [rates, routeCharges] = await Promise.all([
    CountryRateCard.find({ band })
      .select("-band -createdBy -updatedBy")
      .sort({ countryName: 1, service: 1, fromKg: 1 })
      .lean().exec(),
    CountryRouteCharge.find({ band })
      .select("-band -createdBy -updatedBy")
      .sort({ countryCode: 1, service: 1 })
      .lean().exec()
  ]);
  const role = String((request as Request & { user?: { role?: string } }).user?.role ?? "");

  return response.status(200).json({
    success: true,
    title: "Your Swiftline Rate Card",
    rateCardAssigned: true,
    ...(role === "client" ? {} : { band }),
    rates,
    routeCharges
  });
}

/**
 * Where the draft came from, and what the import could not fill.
 * Null for manually created drafts, so the banner only shows where it is relevant.
 */
async function getShipmentImportSummary(shipmentDraft: IShipmentDraft) {
  if (shipmentDraft.creationSource !== "SHIPMENT_IMPORT" || !shipmentDraft.shipmentImportEntryId) return null;

  const entry = await ShipmentImportEntry.findById(shipmentDraft.shipmentImportEntryId)
    .select("originalFilename warnings")
    .lean()
    .exec();
  return {
    originalFilename: entry?.originalFilename ?? "",
    warnings: entry?.warnings ?? []
  };
}

export async function createManualShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = manualDraftSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Select a business account and sender branch before creating a blank shipment."
    });
  }

  try {
    const shipmentDraft = await createBlankShipmentDraft({
      ...parsed.data,
      createdBy: userId,
      allowedBranchIds: draftCreationBranchScope(request)
    });

    return response.status(201).json({ success: true, shipmentDraft });
  } catch (error) {
    if (error instanceof ManualShipmentDraftError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

export async function createIndividualShipmentDraftHandler(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = individualDraftSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Enter the customer's name and select a sender branch."
    });
  }

  try {
    const shipmentDraft = await createIndividualShipmentDraft({
      ...parsed.data,
      createdBy: userId,
      allowedBranchIds: draftCreationBranchScope(request)
    });

    return response.status(201).json({ success: true, shipmentDraft });
  } catch (error) {
    if (error instanceof ManualShipmentDraftError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

export async function rebookShipmentDraftHandler(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const idempotencyKey = String(request.header("Idempotency-Key") ?? "").trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return response.status(400).json({ success: false, message: "A valid rebook request identifier is required." });
  }

  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment not found." });

  try {
    const shipmentDraft = await rebookShipmentDraft({
      sourceDraftId: draftId,
      createdBy: userId,
      allowedBranchIds: draftCreationBranchScope(request),
      idempotencyKey
    });
    return response.status(201).json({ success: true, shipmentDraft });
  } catch (error) {
    if (error instanceof ManualShipmentDraftError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

export async function updateShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const parsed = draftPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "Shipment changes are invalid.",
      errors: getDraftPatchValidationIssues(parsed.error)
    });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  try {
    await assertShipmentDraftMutationAllowed({
      draft: shipmentDraft,
      userId,
      portalRole: getAuthenticatedPortalRole(request)
    });
  } catch (error) {
    const policyResponse = sendDraftPolicyError(response, error);
    if (policyResponse) return policyResponse;
    throw error;
  }

  const changedAt = new Date().toISOString();
  const changedFields: FieldChange[] = [];

  if (parsed.data.consignorAddress) {
    const originalConsignor = { ...(shipmentDraft.consignorAddress ?? {}) } as Record<string, unknown>;

    for (const [fieldName, newValue] of Object.entries(parsed.data.consignorAddress)) {
      // Aadhaar numbers never reach the audit trail in full.
      const isAadhaar = fieldName === "aadhaarNumber";
      recordFieldChange(
        changedFields,
        `consignorAddress.${fieldName}`,
        isAadhaar ? maskAadhaarNumber(originalConsignor[fieldName]) : originalConsignor[fieldName],
        isAadhaar ? maskAadhaarNumber(newValue) : newValue,
        userId,
        changedAt
      );
    }

    shipmentDraft.consignorAddress = {
      ...(shipmentDraft.consignorAddress ?? {}),
      ...parsed.data.consignorAddress
    } as typeof shipmentDraft.consignorAddress;
  }

  if (parsed.data.consigneeEnteredAddress) {
    const originalAddress = { ...shipmentDraft.consigneeEnteredAddress } as Record<string, unknown>;

    for (const [fieldName, newValue] of Object.entries(parsed.data.consigneeEnteredAddress)) {
      recordFieldChange(
        changedFields,
        `consigneeEnteredAddress.${fieldName}`,
        (originalAddress as Record<string, unknown>)[fieldName],
        newValue,
        userId,
        changedAt
      );
    }

    shipmentDraft.consigneeEnteredAddress = {
      ...shipmentDraft.consigneeEnteredAddress,
      ...parsed.data.consigneeEnteredAddress
    };

    // Only a change to the postal address itself invalidates a prior address
    // validation. Editing contact fields (name, email, phone, delivery notes) must
    // NOT reset it, otherwise a manual "use address as entered" confirmation is lost
    // every time an unrelated field is corrected, forcing the user to re-confirm.
    const addressRelevantFields = new Set([
      "countryCode",
      "countryName",
      "addressLine1",
      "addressLine2",
      "townOrCity",
      "county",
      "stateCode",
      "postcode"
    ]);
    const postalAddressChanged = changedFields.some((field) =>
      field.fieldName.startsWith("consigneeEnteredAddress.")
      && addressRelevantFields.has(field.fieldName.slice("consigneeEnteredAddress.".length))
    );

    if (postalAddressChanged) {
      shipmentDraft.addressValidationStatus = "NOT_VALIDATED";
      shipmentDraft.consigneeValidatedAddress = null;
    }
  }

  if (parsed.data.parcelList) {
    parsed.data.parcelList.forEach((nextParcel, index) => {
      const originalParcel = { ...(shipmentDraft.parcelList[index] ?? {}) } as Record<string, unknown>;

      for (const [fieldName, newValue] of Object.entries(nextParcel)) {
        // Parcel Aadhaar numbers, like the consignor's, are masked in the audit log.
        const isAadhaar = fieldName === "aadhaarNumber";
        recordFieldChange(
          changedFields,
          `parcelList.${index}.${fieldName}`,
          isAadhaar ? maskAadhaarNumber(originalParcel[fieldName]) : originalParcel[fieldName],
          isAadhaar ? maskAadhaarNumber(newValue) : (newValue ?? ""),
          userId,
          changedAt
        );
      }
    });

    // KYC uploads are server-managed and are preserved by sequence across a parcel
    // edit. Documents belonging to parcels that no longer exist are cleaned up.
    const existingBySequence = new Map(shipmentDraft.parcelList.map((parcel) => [parcel.sequence, parcel]));
    const nextSequences = new Set(parsed.data.parcelList.map((parcel) => parcel.sequence));
    const removedKycKeys = shipmentDraft.parcelList
      .filter((parcel) => !nextSequences.has(parcel.sequence))
      .flatMap((parcel) => Object.values(parcel.kycDocuments ?? {}))
      .map((document) => document?.storageKey)
      .filter((key): key is string => Boolean(key));

    shipmentDraft.parcelList = parsed.data.parcelList.map((parcel) => {
      const existing = existingBySequence.get(parcel.sequence);
      return {
        sequence: parcel.sequence,
        weightKg: parcel.weightKg,
        lengthCm: parcel.lengthCm ?? undefined,
        widthCm: parcel.widthCm ?? undefined,
        heightCm: parcel.heightCm ?? undefined,
        shipmentContentType: parcel.shipmentContentType,
        // contentsDescription is recomposed from items by the model's
        // pre-validate hook, so every downstream consumer stays in step.
        items: parcel.items ?? existing?.items ?? [],
        contentsDescription: parcel.contentsDescription,
        shipmentReference1: parcel.shipmentReference1 ?? "",
        shipmentReference2: parcel.shipmentReference2 ?? "",
        aadhaarNumber: parcel.aadhaarNumber ?? existing?.aadhaarNumber ?? "",
        kycDocuments: existing?.kycDocuments ?? {}
      };
    });
    shipmentDraft.parcelCount = shipmentDraft.parcelList.length;

    await Promise.all(removedKycKeys.map((key) => deleteObject(key).catch(() => undefined)));
  }

  if (typeof parsed.data.kycUseForAllParcels === "boolean") {
    recordFieldChange(
      changedFields,
      "kycUseForAllParcels",
      shipmentDraft.kycUseForAllParcels,
      parsed.data.kycUseForAllParcels,
      userId,
      changedAt
    );
    shipmentDraft.kycUseForAllParcels = parsed.data.kycUseForAllParcels;
  }

  if (typeof parsed.data.serviceCode === "string") {
    recordFieldChange(
      changedFields,
      "serviceCode",
      shipmentDraft.serviceCode,
      parsed.data.serviceCode,
      userId,
      changedAt
    );
    shipmentDraft.serviceCode = parsed.data.serviceCode;
  }

  if (parsed.data.serviceType) {
    recordFieldChange(
      changedFields,
      "serviceType",
      shipmentDraft.serviceType,
      parsed.data.serviceType,
      userId,
      changedAt
    );
    shipmentDraft.serviceType = parsed.data.serviceType;
  }

  // Audited like serviceType: switching to CSB-V changes what the customer is
  // charged, so the change needs an attributable trail.
  if (parsed.data.csbType) {
    recordFieldChange(
      changedFields,
      "csbType",
      shipmentDraft.csbType,
      parsed.data.csbType,
      userId,
      changedAt
    );
    shipmentDraft.csbType = parsed.data.csbType;
  }

  for (const fieldName of ["csbVGstin", "csbVAccountNumber", "csbVInvoiceNumber"] as const) {
    const nextValue = parsed.data[fieldName];
    if (typeof nextValue !== "string") continue;

    recordFieldChange(
      changedFields,
      fieldName,
      shipmentDraft[fieldName],
      nextValue,
      userId,
      changedAt
    );
    shipmentDraft[fieldName] = nextValue;
  }

  // Audited for the same reason as csbType: opting in or out moves the price.
  if (parsed.data.insuranceOptIn !== undefined) {
    recordFieldChange(
      changedFields,
      "insuranceOptIn",
      shipmentDraft.insuranceOptIn,
      parsed.data.insuranceOptIn,
      userId,
      changedAt
    );
    shipmentDraft.insuranceOptIn = parsed.data.insuranceOptIn;
  }
  if (parsed.data.forceGst !== undefined) {
    recordFieldChange(
      changedFields,
      "forceGst",
      shipmentDraft.forceGst,
      parsed.data.forceGst,
      userId,
      changedAt
    );
    shipmentDraft.forceGst = parsed.data.forceGst;
  }

  if (parsed.data.declarationNote !== undefined) {
    shipmentDraft.declarationNote = parsed.data.declarationNote;
  }

  shipmentDraft.validationIssues = validateShipmentDraftFields(shipmentDraft);
  shipmentDraft.status = shipmentDraft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
  await shipmentDraft.save();

  await writeShipmentDraftAuditLog("SHIPMENT_DRAFT_UPDATED", shipmentDraft._id as mongoose.Types.ObjectId, userId, {
    changedFields,
    changeCount: changedFields.length
  });

  return response.status(200).json({ success: true, shipmentDraft });
}

export async function validateShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  try {
    await assertShipmentDraftMutationAllowed({
      draft: shipmentDraft,
      userId,
      portalRole: getAuthenticatedPortalRole(request)
    });
  } catch (error) {
    const policyResponse = sendDraftPolicyError(response, error);
    if (policyResponse) return policyResponse;
    throw error;
  }

  const issues = validateShipmentDraftFields(shipmentDraft, { requireValidatedAddress: true });

  // Only run the booking-payload checks once the draft's own fields are sound,
  // so the booker is not shown the same missing value reported twice over.
  if (issues.length === 0) {
    issues.push(...validateShipmentPayload(buildShipmentPayload(shipmentDraft)));
  }

  shipmentDraft.validationIssues = issues;
  shipmentDraft.status = issues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
  await shipmentDraft.save();

  await writeShipmentDraftAuditLog(
    "SHIPMENT_VALIDATION_COMPLETED",
    shipmentDraft._id as mongoose.Types.ObjectId,
    userId,
    { issueCount: issues.length }
  );

  return response.status(200).json({
    success: true,
    readyForDpd: shipmentDraft.status === "READY_FOR_DPD",
    validationIssues: shipmentDraft.validationIssues,
    shipmentDraft
  });
}

export async function deleteShipmentDraftHandler(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const shipmentDraft = await ShipmentDraft.findOne({ _id: draftId, deletedAt: null }).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  try {
    await softDeleteShipmentDraft({
      draft: shipmentDraft,
      userId,
      portalRole: getAuthenticatedPortalRole(request)
    });
  } catch (error) {
    const handled = sendDraftPolicyError(response, error);
    if (handled) return handled;
    throw error;
  }

  return response.status(200).json({
    success: true,
    message: "Shipment draft deleted.",
    shipmentDraftId: draftId
  });
}

export async function deleteShipmentDraftsHandler(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = bulkDraftDeleteSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Select valid shipment drafts."
    });
  }

  const objectIds = parsed.data.shipmentDraftIds.map((id) => new mongoose.Types.ObjectId(id));
  const found = await ShipmentDraft.find({ _id: { $in: objectIds }, deletedAt: null }).exec();
  if (found.length !== objectIds.length) {
    return response.status(404).json({ success: false, message: "One or more shipment drafts were not found." });
  }
  const foundById = new Map(found.map((draft) => [String(draft._id), draft]));
  const drafts = parsed.data.shipmentDraftIds.map((id) => foundById.get(id)!);

  try {
    const deletedIds = await softDeleteShipmentDrafts({
      drafts,
      userId,
      portalRole: getAuthenticatedPortalRole(request)
    });
    return response.status(200).json({
      success: true,
      message: `${deletedIds.length} shipment draft${deletedIds.length === 1 ? "" : "s"} deleted.`,
      shipmentDraftIds: deletedIds.map(String)
    });
  } catch (error) {
    const handled = sendDraftPolicyError(response, error);
    if (handled) return handled;
    throw error;
  }
}

export async function restoreShipmentDraftHandler(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = getDraftId(request);
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  try {
    const shipmentDraft = await undoShipmentDraftDeletion({
      draftId: new mongoose.Types.ObjectId(draftId),
      userId,
      portalRole: getAuthenticatedPortalRole(request)
    });

    return response.status(200).json({
      success: true,
      message: "Shipment draft restored.",
      shipmentDraft
    });
  } catch (error) {
    const handled = sendDraftPolicyError(response, error);
    if (handled) return handled;
    throw error;
  }
}

/**
 * Unbooked drafts, newest first.
 *
 * Booked shipments have their own listing built from DpdShipment records; this
 * one exists because a draft that never reached the carrier appeared in no admin
 * list at all, leaving it unreachable once the operator navigated away.
 */
export async function listEditableShipmentDrafts(request: Request, response: Response): Promise<Response> {
  const page = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "20"), 10) || 20));

  const query: Record<string, unknown> = { deletedAt: null, bookingState: "EDITABLE" };

  // Operations sees only its own branches; admin passes through unscoped.
  const allowedBranchIds = operationsBranchIds(request);
  if (allowedBranchIds) {
    query.branchId = { $in: allowedBranchIds.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const requestedBranchId = typeof request.query.branchId === "string" ? request.query.branchId : "";
  if (requestedBranchId && mongoose.Types.ObjectId.isValid(requestedBranchId)) {
    if (allowedBranchIds && !allowedBranchIds.includes(requestedBranchId)) {
      return response.status(403).json({ success: false, message: "You do not have access to this branch." });
    }
    query.branchId = new mongoose.Types.ObjectId(requestedBranchId);
  }

  const requestedAccountId = typeof request.query.businessAccountId === "string"
    ? request.query.businessAccountId
    : "";
  if (requestedAccountId && mongoose.Types.ObjectId.isValid(requestedAccountId)) {
    query.businessAccountId = new mongoose.Types.ObjectId(requestedAccountId);
  }

  const total = await ShipmentDraft.countDocuments(query).exec();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const drafts = await ShipmentDraft.find(query)
    // Most recently worked on first: a draft list is a resume-where-you-left-off
    // list, unlike the booked listing which is ordered by creation.
    .sort({ updatedAt: -1, _id: -1 })
    .skip((currentPage - 1) * limit)
    .limit(limit)
    .lean()
    .exec();

  const [branches, accounts] = await Promise.all([
    Branch.find({ _id: { $in: drafts.map((draft) => draft.branchId) } })
      .select("name code")
      .lean()
      .exec(),
    BusinessAccount.find({ _id: { $in: drafts.map((draft) => draft.businessAccountId) } })
      .select("accountId company.companyName")
      .lean()
      .exec()
  ]);

  const branchesById = new Map(branches.map((branch) => [String(branch._id), branch]));
  const accountsById = new Map(accounts.map((account) => [String(account._id), account]));

  return response.status(200).json({
    success: true,
    drafts: drafts.map((draft) => {
      const branch = branchesById.get(String(draft.branchId));
      const account = accountsById.get(String(draft.businessAccountId));
      const shipmentReference = draft.parcelList?.find((parcel) => parcel.shipmentReference1?.trim())?.shipmentReference1 ?? "";

      return {
        id: String(draft._id),
        customerType: draft.customerType ?? "BUSINESS",
        status: draft.status,
        bookingState: draft.bookingState,
        invoiceNumber: "",
        shipmentReference,
        consigneeName: draft.consigneeEnteredAddress?.contactName
          ?? draft.consigneeEnteredAddress?.companyName
          ?? "",
        destination: draft.consigneeEnteredAddress?.townOrCity
          ?? draft.consigneeEnteredAddress?.postcode
          ?? "",
        parcelCount: draft.parcelList?.length ?? 0,
        totalWeightKg: (draft.parcelList ?? []).reduce((sum, parcel) => sum + (parcel.weightKg || 0), 0),
        businessAccount: {
          accountId: account?.accountId ?? "",
          companyName: account?.company?.companyName ?? ""
        },
        branch: { name: branch?.name ?? "", code: branch?.code ?? "" },
        validationIssues: draft.validationIssues ?? [],
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt
      };
    }),
    pagination: { page: currentPage, limit, total, totalPages }
  });
}
