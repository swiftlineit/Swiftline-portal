import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { validateShipmentDraftFields } from "./shipmentValidation.service.js";
import { ManualShipmentDraftError } from "./manualShipmentDraft.service.js";
import { isIndividualSentinel } from "./individualCustomer.service.js";
import {
  deleteObject,
  getObjectBuffer,
  putObject,
  shipmentKycKey
} from "./storage/storage.service.js";

/**
 * Rebooks a previously booked shipment into a new EDITABLE draft.
 *
 * Copies every field staff sees on the booking form - consignor, consignee,
 * parcels (with items + per-parcel Aadhaar/KYC), CSB/insurance/GST/service -
 * while keeping the *same* `businessAccountId` + `branchId` + `customerType`.
 * KYC documents are copied to new storage keys so the rebook does not share
 * deletable files with the source shipment. Per request, INDIVIDUAL walk-ins
 * keep the original branch; BUSINESS shipments keep their account's assigned
 * branch (validated fresh).
 *
 * Every shipment with a carrier booking record is eligible, regardless of its
 * carrier outcome or operational timeline. A legacy draft marked BOOKED is also
 * accepted when its carrier row is missing. The request key prevents retries
 * from creating a second editable draft.
 */
export async function rebookShipmentDraft(input: {
  sourceDraftId: string;
  createdBy: mongoose.Types.ObjectId;
  allowedBranchIds: string[] | null;
  idempotencyKey: string;
}) {
  const sourceId = input.sourceDraftId?.trim();
  if (!sourceId || !mongoose.Types.ObjectId.isValid(sourceId)) {
    throw new ManualShipmentDraftError("Shipment not found.", 404);
  }

  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new ManualShipmentDraftError("A valid rebook request identifier is required.", 400);
  }

  const source = await ShipmentDraft.findOne({ _id: sourceId, deletedAt: null }).exec();
  if (!source) throw new ManualShipmentDraftError("Shipment not found.", 404);

  // Branch scope: rebook touches the source branch, so an operations member
  // must already hold that branch. Admin is unscoped (null).
  assertBranchAllowed(input.allowedBranchIds, source.branchId);

  // Every carrier outcome is eligible. This is a copy action, not a second
  // carrier booking, so cancelled, held, manifested, delivered, and uncertain
  // shipments remain rebookable as requested.
  const sourceBooking = await DpdShipment.findOne({ shipmentDraftId: source._id })
    .select("_id status")
    .lean()
    .exec();
  if (!sourceBooking && source.bookingState !== "BOOKED") {
    throw new ManualShipmentDraftError("Only an existing shipment can be rebooked.", 409);
  }

  const existingRequest = await ShipmentDraft.findOne({
    rebookedFromDraftId: source._id,
    rebookIdempotencyKey: idempotencyKey
  }).exec();
  if (existingRequest) return existingRequest;

  const branch = await Branch.findById(source.branchId).exec();
  if (!branch) throw new ManualShipmentDraftError("Sender branch not found.", 404);
  if (branch.status !== "ACTIVE") {
    throw new ManualShipmentDraftError("The assigned branch is not active. Contact Swiftline support.", 409);
  }

  const businessAccount = await BusinessAccount.findById(source.businessAccountId).exec();
  if (!businessAccount) throw new ManualShipmentDraftError("Business account not found.", 404);

  const isIndividual = source.customerType === "INDIVIDUAL" || isIndividualSentinel(businessAccount);

  if (!isIndividual) {
    // BUSINESS: re-validate the assigned-branch invariant fresh (account may
    // have been reassigned or suspended since the original booking).
    if (!["approved", "active"].includes(businessAccount.status)) {
      throw new ManualShipmentDraftError("The business account must be approved before rebooking.", 409);
    }
    if (!businessAccount.assignedBranch) {
      throw new ManualShipmentDraftError("Assign a branch to this business account before rebooking.", 409);
    }
    if (String(businessAccount.assignedBranch) !== String(branch._id)) {
      throw new ManualShipmentDraftError("The assigned branch is no longer assigned to this business account.", 403);
    }
  } else {
    // INDIVIDUAL walk-ins use the sentinel; they keep the original branch exactly
    // - no account-grade assigned-branch check applies.
    if (String(source.branchId) !== String(branch._id)) {
      // Defensive - source.branchId and loaded branch already aligned.
      throw new ManualShipmentDraftError("Sender branch not found.", 404);
    }
  }

  // Deep-clone helpers: plain objects so mongoose subdocument ids are not carried.
  const targetDraftId = new mongoose.Types.ObjectId();
  const copiedStorageKeys: string[] = [];
  let clonedKycDocuments: Record<string, unknown>;
  const clonedParcels: Record<string, unknown>[] = [];
  try {
    clonedKycDocuments = await cloneKycDocuments(
      source.kycDocuments as Record<string, unknown>,
      String(targetDraftId),
      copiedStorageKeys
    );
    for (const [index, parcel] of (source.parcelList ?? []).entries()) {
      const items = (parcel.items ?? []).map((item) => ({
        description: item.description ?? "",
        hsnCode: item.hsnCode ?? "",
        unitType: item.unitType ?? "PCS",
        quantity: item.quantity ?? 0,
        unitRate: item.unitRate ?? 0
      }));
      clonedParcels.push({
        sequence: parcel.sequence ?? index + 1,
        weightKg: parcel.weightKg ?? 0,
        // Omit empty dimensions so “Not available” in source does not become 0;
        // validation will still demand them before booking.
        lengthCm: parcel.lengthCm ?? undefined,
        widthCm: parcel.widthCm ?? undefined,
        heightCm: parcel.heightCm ?? undefined,
        shipmentContentType: parcel.shipmentContentType ?? "PARCEL",
        items,
        contentsDescription: parcel.contentsDescription ?? "",
        shipmentReference1: parcel.shipmentReference1 ?? "",
        shipmentReference2: parcel.shipmentReference2 ?? "",
        aadhaarNumber: parcel.aadhaarNumber ?? "",
        kycDocuments: await cloneKycDocuments(
          (parcel.kycDocuments ?? {}) as Record<string, unknown>,
          String(targetDraftId),
          copiedStorageKeys
        )
      });
    }
  } catch {
    await discardStoredObjects(copiedStorageKeys);
    throw new ManualShipmentDraftError("The shipment documents could not be copied for rebooking.", 409);
  }

  const consignorAddress = source.consignorAddress
    ? {
        companyName: source.consignorAddress.companyName ?? "",
        contactName: source.consignorAddress.contactName ?? "",
        email: source.consignorAddress.email ?? "",
        mobileCountryCode: source.consignorAddress.mobileCountryCode ?? "+91",
        mobileNumber: source.consignorAddress.mobileNumber ?? "",
        aadhaarNumber: (source.consignorAddress.aadhaarNumber ?? "").replace(/\D/g, ""),
        countryCode: source.consignorAddress.countryCode ?? "IN",
        countryName: source.consignorAddress.countryName ?? "India",
        postcode: source.consignorAddress.postcode ?? "",
        addressLine1: source.consignorAddress.addressLine1 ?? "",
        addressLine2: source.consignorAddress.addressLine2 ?? "",
        townOrCity: source.consignorAddress.townOrCity ?? "",
        county: source.consignorAddress.county ?? "",
        pickupInstructions: source.consignorAddress.pickupInstructions ?? ""
      }
    : undefined;

  const consigneeEnteredAddress = source.consigneeEnteredAddress
    ? {
        companyName: source.consigneeEnteredAddress.companyName ?? "",
        contactName: source.consigneeEnteredAddress.contactName ?? "",
        email: source.consigneeEnteredAddress.email ?? "",
        mobileCountryCode: source.consigneeEnteredAddress.mobileCountryCode ?? "",
        mobileNumber: source.consigneeEnteredAddress.mobileNumber ?? "",
        countryCode: source.consigneeEnteredAddress.countryCode ?? "",
        countryName: source.consigneeEnteredAddress.countryName ?? "",
        postcode: source.consigneeEnteredAddress.postcode ?? "",
        addressLine1: source.consigneeEnteredAddress.addressLine1 ?? "",
        addressLine2: source.consigneeEnteredAddress.addressLine2 ?? "",
        townOrCity: source.consigneeEnteredAddress.townOrCity ?? "",
        county: source.consigneeEnteredAddress.county ?? "",
        stateCode: source.consigneeEnteredAddress.stateCode ?? "",
        deliveryInstructions: source.consigneeEnteredAddress.deliveryInstructions ?? ""
      }
    : {
        companyName: "",
        contactName: "",
        email: "",
        mobileCountryCode: "",
        mobileNumber: "",
        countryCode: "",
        countryName: "",
        postcode: "",
        addressLine1: "",
        addressLine2: "",
        townOrCity: "",
        county: "",
        stateCode: "",
        deliveryInstructions: ""
      };

  const session = await mongoose.startSession();
  let created: InstanceType<typeof ShipmentDraft> | null = null;
  let transactionCommitted = false;

  try {
    await session.withTransaction(async () => {
      const draft = new ShipmentDraft({
        _id: targetDraftId,
        creationSource: source.creationSource === "INDIVIDUAL" ? "INDIVIDUAL" : "MANUAL",
        // Never carry an import linkage - rebook is a manual copy.
        shipmentImportEntryId: null,
        rebookedFromDraftId: source._id,
        rebookIdempotencyKey: idempotencyKey,
        businessAccountId: source.businessAccountId,
        customerType: source.customerType ?? "BUSINESS",
        branchId: source.branchId,
        sender: {
          branchId: branch._id,
          name: branch.name,
          code: branch.code,
          address: branch.address,
          contact: branch.contact
        },
        consignorAddress,
        consignorPlaceId: "",
        kycUseForAllParcels: source.kycUseForAllParcels ?? true,
        kycDocuments: clonedKycDocuments,
        consigneeEnteredAddress,
        consigneeSelectedAddress: null,
        consigneeValidatedAddress: null,
        googlePlaceId: "",
        addressValidationStatus: "NOT_VALIDATED",
        addressValidationResult: {},
        parcelCount: clonedParcels.length || 1,
        parcelList: clonedParcels.length
          ? clonedParcels
          : [
              {
                sequence: 1,
                weightKg: 0,
                shipmentContentType: "PARCEL" as const,
                items: [],
                contentsDescription: "",
                shipmentReference1: "",
                shipmentReference2: "",
                aadhaarNumber: "",
                kycDocuments: {}
              }
            ],
        csbType: source.csbType ?? "CSB_IV",
        csbVGstin: source.csbVGstin ?? "",
        csbVAccountNumber: source.csbVAccountNumber ?? "",
        csbVInvoiceNumber: source.csbVInvoiceNumber ?? "",
        insuranceOptIn: source.insuranceOptIn ?? false,
        forceGst: source.forceGst ?? false,
        declarationNote: source.declarationNote ?? "",
        serviceType: source.serviceType ?? "COURIER",
        serviceCode: source.serviceCode ?? "",
        validationIssues: [],
        status: "NEEDS_REVIEW",
        bookingState: "EDITABLE",
        bookingAttemptId: "",
        lockedAt: null,
        allocatedTrackingNumber: "",
        deletedAt: null,
        deletedBy: null,
        createdBy: input.createdBy
      });

      // Recompute validation so the new draft opens with the same issues the
      // source would now show (rates, KYC checklist drift, etc.).
      draft.validationIssues = validateShipmentDraftFields(draft);
      // Keep NEEDS_REVIEW / READY signal but never carry a booked state.
      draft.status = draft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";

      await draft.save({ session });

      await new AuditLog({
        action: "SHIPMENT_DRAFT_REBOOKED",
        entityType: "SHIPMENT_DRAFT",
        entityId: draft._id,
        performedBy: input.createdBy,
        performedAt: new Date(),
        metadata: {
          sourceShipmentDraftId: source._id,
          sourceBookingState: source.bookingState,
          sourceCarrierStatus: sourceBooking?.status ?? null,
          businessAccountId: source.businessAccountId,
          branchId: source.branchId,
          customerType: source.customerType ?? "BUSINESS",
          creationSource: source.creationSource
        }
      }).save({ session });

      created = draft;
    });
    transactionCommitted = true;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const winner = await ShipmentDraft.findOne({
        rebookedFromDraftId: source._id,
        rebookIdempotencyKey: idempotencyKey
      }).exec();
      if (winner) return winner;
    }
    throw error;
  } finally {
    await session.endSession();
    if (!transactionCommitted) await discardStoredObjects(copiedStorageKeys);
  }

  const result = created as InstanceType<typeof ShipmentDraft> | null;
  if (!result) {
    throw new ManualShipmentDraftError("The rebooked shipment draft could not be created. Please try again.", 500);
  }
  return result;
}

function assertBranchAllowed(allowedBranchIds: string[] | null, branchId: mongoose.Types.ObjectId) {
  if (allowedBranchIds === null) return;
  if (allowedBranchIds.includes(String(branchId))) return;
  throw new ManualShipmentDraftError("You do not have access to this branch.", 403);
}

async function cloneKycDocuments(
  input: Record<string, unknown> | null | undefined,
  targetDraftId: string,
  copiedStorageKeys: string[]
): Promise<Record<string, unknown>> {
  if (!input || typeof input !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== "object") continue;
    const doc = value as Record<string, unknown>;
    if (!doc.storageKey || typeof doc.storageKey !== "string") continue;

    const body = await getObjectBuffer(doc.storageKey);
    const originalName = typeof doc.originalName === "string" ? doc.originalName : "document";
    const mimeType = typeof doc.mimeType === "string" ? doc.mimeType : "application/octet-stream";
    const stored = await putObject({
      key: shipmentKycKey(targetDraftId, originalName),
      body,
      contentType: mimeType,
      originalName
    });
    copiedStorageKeys.push(stored.key);

    output[key] = {
      type: doc.type,
      documentLabel: doc.documentLabel ?? "",
      originalName,
      storageKey: stored.key,
      mimeType,
      size: doc.size ?? body.length,
      uploadedAt: doc.uploadedAt ?? new Date(),
      uploadedBy: doc.uploadedBy ?? null
    };
  }

  return output;
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000;
}

async function discardStoredObjects(keys: string[]) {
  await Promise.all(keys.map((key) => deleteObject(key).catch(() => undefined)));
}
