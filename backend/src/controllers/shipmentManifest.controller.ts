import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { DpdShipment, type IDpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft, type IShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentManifest, type IShipmentManifest } from "../models/shipmentManifest.model.js";
import { User } from "../models/user.model.js";
import { clientCanAccessShipmentDraft } from "../services/shipmentDraftPolicy.service.js";
import { readShipmentBookingSnapshot, snapshotDeclaredGoodsValueMinor } from "../services/shipmentBookingSnapshot.service.js";
import { notifyAdminsOfClientManifest } from "../services/shipmentManifestNotification.service.js";
import { buildShipmentManifestPdf } from "../services/shipmentManifestPdf.service.js";
import { dateRangeCondition, dateRangeParams } from "../utils/dateRangeFilter.js";
import {
  allocateShipmentManifestNumber,
  buildHandoverManifestLine,
  formatManifestOrigin,
  hydrateMissingManifestParcelChargeableWeights,
  manifestBusinessAccountName,
  serializeShipmentManifest,
  ShipmentManifestServiceError
} from "../services/shipmentManifest.service.js";

const manifestLineInputSchema = z.object({
  shipmentDraftId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select a valid shipment."),
  bagNumber: z.string().trim().min(1, "Bag number is required.").max(40)
});

const createManifestSchema = z.object({
  currentShipmentDraftId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Shipment not found."),
  destinationAgent: z.string().trim().max(1000, "Destination agent details must be 1000 characters or fewer.").default(""),
  flightNumber: z.string().trim().max(40).default(""),
  departureDate: z.string().trim().max(10).default("").refine((value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value), "Use YYYY-MM-DD for departure date."),
  mawbNumber: z.string().trim().max(40).default(""),
  originIataCode: z.string().trim().toUpperCase().max(3).default("").refine((value) => !value || /^[A-Z]{3}$/.test(value), "Origin IATA code must contain three letters."),
  destinationIataCode: z.string().trim().toUpperCase().max(3).default("").refine((value) => !value || /^[A-Z]{3}$/.test(value), "Destination IATA code must contain three letters."),
  valueType: z.string().trim().max(20).default("LV"),
  lines: z.array(manifestLineInputSchema).min(1, "Select at least one shipment.").max(100)
});

const createClientManifestSchema = z.object({
  currentShipmentDraftId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Shipment not found.")
});

type NormalizedManifestInput = z.infer<typeof createManifestSchema>;

function getUserId(request: Request) {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function getDraftId(request: Request) {
  const value = typeof request.params.draftId === "string" ? request.params.draftId : "";
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function getManifestId(request: Request) {
  const value = typeof request.params.manifestId === "string" ? request.params.manifestId : "";
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function sendManifestError(response: Response, error: unknown) {
  if (error instanceof ShipmentManifestServiceError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
    return response.status(409).json({
      success: false,
      message: "One of the selected shipments already belongs to a manifest. Refresh the shipment list and try again."
    });
  }
  throw error;
}

/**
 * Keeps one manifest to one walk-in customer.
 *
 * A manifest is a customer-facing document whose header names a single customer,
 * which the "same business account" rule above normally guarantees. That rule
 * stops guaranteeing it for individual shipments: every walk-in is booked against
 * the same system sentinel, so unrelated customers would pass it and end up on one
 * manifest headed with whichever name came first. Their identity lives on the
 * draft instead, so it is compared there- by mobile number, the field the counter
 * always captures.
 */
export function assertSameIndividualCustomer(drafts: IShipmentDraft[], reference: IShipmentDraft) {
  if (reference.customerType !== "INDIVIDUAL") return;

  const customerKey = (draft: IShipmentDraft) => [
    draft.consignorAddress?.mobileCountryCode ?? "",
    draft.consignorAddress?.mobileNumber ?? ""
  ].join("|").trim();

  if (drafts.some((draft) => customerKey(draft) !== customerKey(reference))) {
    throw new ShipmentManifestServiceError("All manifest shipments must belong to the same individual customer.");
  }
}

async function assertClientAccess(userId: mongoose.Types.ObjectId, draft: IShipmentDraft, requireCreate: boolean) {
  const allowed = await clientCanAccessShipmentDraft({
    userId,
    draft,
    requireEditPermission: requireCreate
  });
  if (!allowed) throw new ShipmentManifestServiceError("You do not have access to create this shipment manifest.", 403);
}

async function manifestForPdf(manifest: IShipmentManifest) {
  const linesNeedingHydration = manifest.lineSnapshots.filter((line) => (
    Array.isArray(line.parcels)
    && line.parcels.length > 0
    && line.parcels.some((parcel) => typeof parcel.chargeableWeightKg !== "number")
  ));
  if (!linesNeedingHydration.length) return manifest;

  const shipmentIds = [...new Set(linesNeedingHydration
    .map((line) => String(line.dpdShipmentId))
    .filter((value) => mongoose.Types.ObjectId.isValid(value)))]
    .map((value) => new mongoose.Types.ObjectId(value));
  const draftIds = [...new Set(linesNeedingHydration
    .map((line) => String(line.shipmentDraftId))
    .filter((value) => mongoose.Types.ObjectId.isValid(value)))]
    .map((value) => new mongoose.Types.ObjectId(value));
  const conditions = [
    ...(shipmentIds.length ? [{ _id: { $in: shipmentIds } }] : []),
    ...(draftIds.length ? [{ shipmentDraftId: { $in: draftIds } }] : [])
  ];
  if (!conditions.length) return manifest;

  const sources = await DpdShipment.find({ $or: conditions })
    .select("_id shipmentDraftId currentShipmentSnapshot bookingSnapshot")
    .lean()
    .exec();
  const lineSnapshots = hydrateMissingManifestParcelChargeableWeights(manifest.lineSnapshots, sources);
  if (lineSnapshots === manifest.lineSnapshots) return manifest;

  const plainManifest = typeof manifest.toObject === "function" ? manifest.toObject() : manifest;
  return { ...plainManifest, lineSnapshots } as unknown as IShipmentManifest;
}

function serializeEligibleShipment(draft: IShipmentDraft, dpdShipment: IDpdShipment) {
  const snapshot = readShipmentBookingSnapshot(dpdShipment.currentShipmentSnapshot)
    ?? readShipmentBookingSnapshot(dpdShipment.bookingSnapshot);
  if (!snapshot) return null;
  const customerReference = snapshot.parcels.find((parcel) => (
    typeof parcel.reference === "string" && Boolean(parcel.reference.trim())
  ))?.reference;
  return {
    shipmentDraftId: String(draft._id),
    dpdShipmentId: String(dpdShipment._id),
    consignmentNumber: snapshot.tracking.swiftlineTrackingNumber,
    shipmentReference: typeof customerReference === "string" ? customerReference : "",
    consignee: snapshot.consignee.companyName || snapshot.consignee.contactName || "Consignee",
    destination: [snapshot.consignee.townOrCity, snapshot.consignee.countryName || snapshot.consignee.countryCode].filter(Boolean).join(", "),
    pieces: snapshot.parcels.length,
    weightKg: Number(snapshot.parcels.reduce((sum, parcel) => sum + parcel.actualWeightKg, 0).toFixed(3)),
    declaredValueMinor: snapshotDeclaredGoodsValueMinor(snapshot),
    serviceInfo: snapshot.service.type === "CARGO" ? "CARGO" : "EXP"
  };
}

async function loadManifestContext(draftId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, actorRole: "admin" | "client") {
  const currentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!currentDraft) throw new ShipmentManifestServiceError("Shipment not found.", 404);

  let canCreate = true;
  if (actorRole === "client") {
    await assertClientAccess(userId, currentDraft, false);
    canCreate = await clientCanAccessShipmentDraft({ userId, draft: currentDraft, requireEditPermission: true });
  }

  const [existingManifests, drafts] = await Promise.all([
    ShipmentManifest.find({
      shipmentDraftIds: currentDraft._id,
      ...(actorRole === "client" ? { actorRole: "client" } : {})
    }).sort({ generatedAt: -1 }).exec(),
    ShipmentDraft.find({
      businessAccountId: currentDraft.businessAccountId,
      branchId: currentDraft.branchId,
      // Every walk-in shares the sentinel account, so filtering on it alone would
      // offer one customer's manifest the shipments of everyone else who used the
      // counter that day. Their identity lives on the draft, so it is matched
      // there- the same rule `assertSameIndividualCustomer` enforces on submit.
      ...(currentDraft.customerType === "INDIVIDUAL"
        ? {
            customerType: "INDIVIDUAL",
            "consignorAddress.mobileCountryCode": currentDraft.consignorAddress?.mobileCountryCode ?? "",
            "consignorAddress.mobileNumber": currentDraft.consignorAddress?.mobileNumber ?? ""
          }
        : {})
    }).sort({ updatedAt: -1 }).limit(100).exec()
  ]);

  const draftIds = drafts.map((draft) => draft._id);
  const [bookings, assignedManifests, cancelledEvents] = await Promise.all([
    DpdShipment.find({ shipmentDraftId: { $in: draftIds }, status: "LABEL_RECEIVED" }).exec(),
    ShipmentManifest.find({ shipmentDraftIds: { $in: draftIds }, actorRole })
      .select("shipmentDraftIds")
      .lean()
      .exec(),
    ShipmentEvent.find({ shipmentDraftId: { $in: draftIds }, status: "SHIPMENT_CANCELLED" })
      .select("shipmentDraftId")
      .lean()
      .exec()
  ]);
  const cancelledIds = new Set(cancelledEvents.map((event) => String(event.shipmentDraftId)));
  const assignedIds = new Set(assignedManifests.flatMap((manifest) => manifest.shipmentDraftIds.map(String)));
  const bookingByDraft = new Map(bookings.map((booking) => [String(booking.shipmentDraftId), booking]));
  const eligibleShipments = drafts.flatMap((draft) => {
    const booking = bookingByDraft.get(String(draft._id));
    if (!booking || cancelledIds.has(String(draft._id)) || assignedIds.has(String(draft._id))) return [];
    const serialized = serializeEligibleShipment(draft, booking);
    return serialized ? [serialized] : [];
  });

  return {
    canCreate,
    currentShipmentDraftId: String(currentDraft._id),
    existingManifests: existingManifests.map(serializeShipmentManifest),
    eligibleShipments
  };
}

async function createManifest(request: Request, response: Response, actorRole: "admin" | "client") {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  let manifestInput: NormalizedManifestInput;
  if (actorRole === "client") {
    const parsed = createClientManifestSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Manifest details are invalid." });
    }
    manifestInput = {
      currentShipmentDraftId: parsed.data.currentShipmentDraftId,
      destinationAgent: "",
      flightNumber: "",
      departureDate: "",
      mawbNumber: "",
      originIataCode: "",
      destinationIataCode: "",
      valueType: "",
      lines: [{
        shipmentDraftId: parsed.data.currentShipmentDraftId,
        bagNumber: "1"
      }]
    };
  } else {
    const parsed = createManifestSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Manifest details are invalid." });
    }
    manifestInput = parsed.data;
  }

  try {
    const currentDraft = await ShipmentDraft.findById(manifestInput.currentShipmentDraftId).exec();
    if (!currentDraft) throw new ShipmentManifestServiceError("Shipment not found.", 404);
    if (actorRole === "client") await assertClientAccess(userId, currentDraft, true);

    const selectedIds = [...new Set(manifestInput.lines.map((line) => line.shipmentDraftId))];
    if (!selectedIds.includes(manifestInput.currentShipmentDraftId)) {
      throw new ShipmentManifestServiceError("The current shipment must be included in its manifest.");
    }
    if (selectedIds.length !== manifestInput.lines.length) {
      throw new ShipmentManifestServiceError("A shipment cannot appear twice in the same manifest.");
    }

    const selectedObjectIds = selectedIds.map((id) => new mongoose.Types.ObjectId(id));
    const [drafts, bookings, existingAssignment, cancelledEvent, assignedBranch] = await Promise.all([
      ShipmentDraft.find({ _id: { $in: selectedObjectIds } }).exec(),
      DpdShipment.find({ shipmentDraftId: { $in: selectedObjectIds }, status: "LABEL_RECEIVED" }).exec(),
      ShipmentManifest.findOne({ shipmentDraftIds: { $in: selectedObjectIds }, actorRole }).lean().exec(),
      ShipmentEvent.findOne({ shipmentDraftId: { $in: selectedObjectIds }, status: "SHIPMENT_CANCELLED" }).lean().exec(),
      Branch.findById(currentDraft.branchId).lean().exec()
    ]);
    if (drafts.length !== selectedIds.length || bookings.length !== selectedIds.length) {
      throw new ShipmentManifestServiceError("Every selected shipment must be booked before it can be manifested.", 409);
    }
    if (existingAssignment) throw new ShipmentManifestServiceError("One of the selected shipments already belongs to a manifest.", 409);
    if (cancelledEvent) throw new ShipmentManifestServiceError("Cancelled shipments cannot be added to a manifest.", 409);
    if (!assignedBranch) throw new ShipmentManifestServiceError("The assigned branch details are unavailable. Contact Swiftline support.", 409);
    if (drafts.some((draft) => String(draft.businessAccountId) !== String(currentDraft.businessAccountId) || String(draft.branchId) !== String(currentDraft.branchId))) {
      throw new ShipmentManifestServiceError("All manifest shipments must belong to the same business account and branch.");
    }
    assertSameIndividualCustomer(drafts, currentDraft);

    const bookingByDraft = new Map(bookings.map((booking) => [String(booking.shipmentDraftId), booking]));
    const inputByDraft = new Map(manifestInput.lines.map((line) => [line.shipmentDraftId, line]));
    // All lines share one business account (enforced above), so the header name
    // is taken from the first shipment's immutable snapshot.
    let businessAccountName = "";
    const lineSnapshots = selectedIds.map((draftId) => {
      const booking = bookingByDraft.get(draftId);
      const lineInput = inputByDraft.get(draftId);
      const snapshot = booking
        ? readShipmentBookingSnapshot(booking.currentShipmentSnapshot) ?? readShipmentBookingSnapshot(booking.bookingSnapshot)
        : null;
      if (!booking || !lineInput || !snapshot) {
        throw new ShipmentManifestServiceError("Shipment booking information is incomplete.", 409);
      }
      const declaredValueMinor = snapshotDeclaredGoodsValueMinor(snapshot);
      if (declaredValueMinor <= 0) {
        throw new ShipmentManifestServiceError(
          "Goods value is unavailable for one of the selected shipments. Update the shipment contents before creating a manifest.",
          409
        );
      }
      if (!businessAccountName) businessAccountName = manifestBusinessAccountName(snapshot);
      // Handover columns are captured here too, so this manifest's PDF carries
      // the same detail as one raised from the shipments list.
      return buildHandoverManifestLine({
        shipmentDraftId: new mongoose.Types.ObjectId(draftId),
        dpdShipmentId: booking._id,
        snapshot,
        declaredValueMinor,
        bagNumber: lineInput.bagNumber,
        remark: "DONE"
      });
    });
    const manifestNumber = await allocateShipmentManifestNumber();
    const manifest = await ShipmentManifest.create({
      manifestNumber,
      businessAccountId: currentDraft.businessAccountId,
      branchId: currentDraft.branchId,
      shipmentDraftIds: selectedObjectIds,
      headerSnapshot: {
        businessAccountName,
        originBranch: [assignedBranch.name, assignedBranch.code].filter(Boolean).join(" - "),
        originAddress: formatManifestOrigin(assignedBranch),
        // This flow has no origin/destination inputs, so the handover header
        // falls back to the lodging branch and the shipments' destination.
        origin: assignedBranch.address?.city || assignedBranch.name || "",
        destination: manifestInput.destinationAgent || lineSnapshots[0]?.destination || "",
        coloader: "",
        paymentType: "",
        destinationAgent: manifestInput.destinationAgent,
        flightNumber: manifestInput.flightNumber,
        departureDate: manifestInput.departureDate,
        mawbNumber: manifestInput.mawbNumber,
        originIataCode: manifestInput.originIataCode,
        destinationIataCode: manifestInput.destinationIataCode,
        valueType: manifestInput.valueType
      },
      lineSnapshots,
      totalPieces: lineSnapshots.reduce((sum, line) => sum + line.pieces, 0),
      totalWeightKg: Number(lineSnapshots.reduce((sum, line) => sum + line.weightKg, 0).toFixed(3)),
      totalBags: new Set(lineSnapshots.map((line) => line.bagNumber)).size,
      createdBy: userId,
      actorRole,
      generatedAt: new Date()
    });
    await AuditLog.create({
      action: "SHIPMENT_MANIFEST_GENERATED",
      entityType: "SHIPMENT_MANIFEST",
      entityId: manifest._id,
      performedBy: userId,
      performedAt: new Date(),
      metadata: { manifestNumber, shipmentDraftIds: selectedObjectIds, actorRole }
    });
    return response.status(201).json({ success: true, manifest: serializeShipmentManifest(manifest) });
  } catch (error) {
    return sendManifestError(response, error);
  }
}

async function downloadManifest(request: Request, response: Response, actorRole: "admin" | "client") {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const manifestId = getManifestId(request);
  if (!manifestId) return response.status(404).json({ success: false, message: "Manifest not found." });
  const manifest = await ShipmentManifest.findById(manifestId).exec();
  if (!manifest) return response.status(404).json({ success: false, message: "Manifest not found." });

  if (actorRole === "client") {
    if (manifest.actorRole !== "client") {
      return response.status(404).json({ success: false, message: "Manifest not found." });
    }
    const draft = await ShipmentDraft.findById(manifest.shipmentDraftIds[0]).exec();
    if (!draft || !await clientCanAccessShipmentDraft({ userId, draft })) {
      return response.status(404).json({ success: false, message: "Manifest not found." });
    }
  }
  const headerSnapshot = manifest.headerSnapshot as Record<string, unknown>;
  if (typeof headerSnapshot.originAddress !== "string" || !headerSnapshot.originAddress.trim()) {
    const assignedBranch = await Branch.findById(manifest.branchId).lean().exec();
    if (assignedBranch) {
      manifest.headerSnapshot = {
        ...headerSnapshot,
        originAddress: formatManifestOrigin(assignedBranch)
      };
    }
  }
  await AuditLog.create({
    action: "SHIPMENT_MANIFEST_DOWNLOADED",
    entityType: "SHIPMENT_MANIFEST",
    entityId: manifest._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { manifestNumber: manifest.manifestNumber, actorRole }
  });
  const disposition = request.query.view === "1" ? "inline" : "attachment";
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `${disposition}; filename="MANIFEST-${manifest.manifestNumber}.pdf"`);
  return response.status(200).send(await buildShipmentManifestPdf(await manifestForPdf(manifest)));
}

export async function getAdminShipmentManifestContext(request: Request, response: Response) {
  const userId = getUserId(request);
  const draftId = getDraftId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment not found." });
  try {
    return response.status(200).json({ success: true, ...(await loadManifestContext(draftId, userId, "admin")) });
  } catch (error) {
    return sendManifestError(response, error);
  }
}

export async function getClientShipmentManifestContext(request: Request, response: Response) {
  const userId = getUserId(request);
  const draftId = getDraftId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!draftId) return response.status(404).json({ success: false, message: "Shipment not found." });
  try {
    return response.status(200).json({ success: true, ...(await loadManifestContext(draftId, userId, "client")) });
  } catch (error) {
    return sendManifestError(response, error);
  }
}

export async function createAdminShipmentManifest(request: Request, response: Response) {
  return createManifest(request, response, "admin");
}

export async function createClientShipmentManifest(request: Request, response: Response) {
  return createManifest(request, response, "client");
}

export async function downloadAdminShipmentManifest(request: Request, response: Response) {
  return downloadManifest(request, response, "admin");
}

export async function downloadClientShipmentManifest(request: Request, response: Response) {
  return downloadManifest(request, response, "client");
}

const bulkManifestSchema = z.object({
  shipmentDraftIds: z.array(
    z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select valid shipments.")
  ).min(1, "Select at least one shipment.").max(200, "A manifest can hold up to 200 shipments."),
  origin: z.string().trim().min(1, "Origin is required.").max(120),
  destination: z.string().trim().min(1, "Destination is required.").max(120),
  coloader: z.string().trim().max(120).default(""),
  paymentType: z.string().trim().max(60).default("")
});

/** The business accounts a client may read manifests for. */
async function clientBusinessAccountIds(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount")
    .lean()
    .exec();
  return memberships.map((membership) => membership.businessAccount);
}

async function serializeManifestList(manifests: IShipmentManifest[]) {
  const creatorIds = [...new Set(manifests.map((manifest) => String(manifest.createdBy)))];
  const creators = await User.find({ _id: { $in: creatorIds } }).select("name email").lean().exec();
  const creatorById = new Map(creators.map((creator) => [String(creator._id), creator]));

  return manifests.map((manifest) => {
    const creator = creatorById.get(String(manifest.createdBy));
    return {
      ...serializeShipmentManifest(manifest),
      generatedBy: creator?.name || creator?.email || "Not available",
      createdAt: manifest.createdAt
    };
  });
}

async function listManifests(request: Request, response: Response, actorRole: "admin" | "client") {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const requestedPage = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(request.query.limit ?? "15"), 10) || 15));
  const businessAccountId = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";

  const query: Record<string, unknown> = {};
  if (actorRole === "client") {
    // Clients see manifests raised for their own business accounts, whoever sealed them.
    const accountIds = await clientBusinessAccountIds(userId);
    if (!accountIds.length) {
      return response.status(200).json({
        success: true,
        manifests: [],
        pagination: { page: 1, limit, total: 0, totalPages: 1 }
      });
    }
    query.businessAccountId = { $in: accountIds };
  }
  if (businessAccountId && mongoose.Types.ObjectId.isValid(businessAccountId)) {
    query.businessAccountId = new mongoose.Types.ObjectId(businessAccountId);
  }
  const { dateFrom, dateTo } = dateRangeParams(request.query);
  const generatedAt = dateRangeCondition(dateFrom, dateTo);
  if (generatedAt) query.generatedAt = generatedAt;

  const total = await ShipmentManifest.countDocuments(query).exec();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const manifests = await ShipmentManifest.find(query)
    .sort({ generatedAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .exec();

  return response.status(200).json({
    success: true,
    manifests: await serializeManifestList(manifests),
    pagination: { page, limit, total, totalPages }
  });
}

/** Loads a manifest the actor is allowed to see, or throws a 404-shaped error. */
async function loadVisibleManifest(
  request: Request,
  userId: mongoose.Types.ObjectId,
  actorRole: "admin" | "client"
) {
  const manifestId = getManifestId(request);
  if (!manifestId) throw new ShipmentManifestServiceError("Manifest not found.", 404);
  const manifest = await ShipmentManifest.findById(manifestId).exec();
  if (!manifest) throw new ShipmentManifestServiceError("Manifest not found.", 404);
  if (actorRole === "client") {
    const accountIds = await clientBusinessAccountIds(userId);
    if (!accountIds.some((id) => String(id) === String(manifest.businessAccountId))) {
      throw new ShipmentManifestServiceError("Manifest not found.", 404);
    }
  }
  return manifest;
}

async function downloadManifestPdf(request: Request, response: Response, actorRole: "admin" | "client") {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const manifest = await loadVisibleManifest(request, userId, actorRole);
    await AuditLog.create({
      action: "SHIPMENT_MANIFEST_DOWNLOADED",
      entityType: "SHIPMENT_MANIFEST",
      entityId: manifest._id,
      performedBy: userId,
      performedAt: new Date(),
      metadata: { manifestNumber: manifest.manifestNumber, actorRole, format: "pdf" }
    });
    const disposition = request.query.view === "1" ? "inline" : "attachment";
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `${disposition}; filename="MANIFEST-${manifest.manifestNumber}.pdf"`);
    return response.status(200).send(await buildShipmentManifestPdf(await manifestForPdf(manifest)));
  } catch (error) {
    return sendManifestError(response, error);
  }
}

async function createBulkManifest(request: Request, response: Response, actorRole: "admin" | "client") {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = bulkManifestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Manifest details are invalid."
    });
  }

  try {
    const selectedIds = [...new Set(parsed.data.shipmentDraftIds)];
    const selectedObjectIds = selectedIds.map((id) => new mongoose.Types.ObjectId(id));
    const drafts = await ShipmentDraft.find({ _id: { $in: selectedObjectIds } }).exec();
    if (drafts.length !== selectedIds.length) {
      throw new ShipmentManifestServiceError("One of the selected shipments is no longer available.", 409);
    }

    const [firstDraft] = drafts;
    if (!firstDraft) throw new ShipmentManifestServiceError("Select at least one shipment.");
    if (drafts.some((draft) => String(draft.businessAccountId) !== String(firstDraft.businessAccountId)
      || String(draft.branchId) !== String(firstDraft.branchId))) {
      throw new ShipmentManifestServiceError("All manifest shipments must belong to the same business account and branch.");
    }
    assertSameIndividualCustomer(drafts, firstDraft);
    if (actorRole === "client") await assertClientAccess(userId, firstDraft, true);

    const [bookings, existingAssignment, cancelledEvent, assignedBranch] = await Promise.all([
      DpdShipment.find({ shipmentDraftId: { $in: selectedObjectIds }, status: "LABEL_RECEIVED" }).exec(),
      ShipmentManifest.findOne({ shipmentDraftIds: { $in: selectedObjectIds }, actorRole }).lean().exec(),
      ShipmentEvent.findOne({ shipmentDraftId: { $in: selectedObjectIds }, status: "SHIPMENT_CANCELLED" }).lean().exec(),
      Branch.findById(firstDraft.branchId).lean().exec()
    ]);
    if (bookings.length !== selectedIds.length) {
      throw new ShipmentManifestServiceError("Every selected shipment must be booked before it can be manifested.", 409);
    }
    if (existingAssignment) {
      throw new ShipmentManifestServiceError("One of the selected shipments already belongs to a manifest.", 409);
    }
    if (cancelledEvent) throw new ShipmentManifestServiceError("Cancelled shipments cannot be added to a manifest.", 409);
    if (!assignedBranch) {
      throw new ShipmentManifestServiceError("The assigned branch details are unavailable. Contact Swiftline support.", 409);
    }

    const bookingByDraft = new Map(bookings.map((booking) => [String(booking.shipmentDraftId), booking]));
    let businessAccountName = "";
    const lineSnapshots = selectedIds.map((draftId) => {
      const booking = bookingByDraft.get(draftId);
      const snapshot = booking
        ? readShipmentBookingSnapshot(booking.currentShipmentSnapshot) ?? readShipmentBookingSnapshot(booking.bookingSnapshot)
        : null;
      if (!booking || !snapshot) throw new ShipmentManifestServiceError("Shipment booking information is incomplete.", 409);
      if (!businessAccountName) businessAccountName = manifestBusinessAccountName(snapshot);
      return buildHandoverManifestLine({
        shipmentDraftId: new mongoose.Types.ObjectId(draftId),
        dpdShipmentId: booking._id,
        snapshot,
        // The handover manifest carries no goods-value column, so no value is
        // declared here. Goods values stay on the shipment's own invoice.
        declaredValueMinor: 0,
        bagNumber: "1",
        remark: "DONE"
      });
    });

    const manifestNumber = await allocateShipmentManifestNumber();
    const manifest = await ShipmentManifest.create({
      manifestNumber,
      businessAccountId: firstDraft.businessAccountId,
      branchId: firstDraft.branchId,
      shipmentDraftIds: selectedObjectIds,
      headerSnapshot: {
        businessAccountName,
        originBranch: [assignedBranch.name, assignedBranch.code].filter(Boolean).join(" - "),
        originAddress: formatManifestOrigin(assignedBranch),
        origin: parsed.data.origin,
        destination: parsed.data.destination,
        coloader: parsed.data.coloader,
        paymentType: parsed.data.paymentType,
        destinationAgent: parsed.data.destination,
        flightNumber: "",
        departureDate: "",
        mawbNumber: "",
        originIataCode: "",
        destinationIataCode: "",
        valueType: ""
      },
      lineSnapshots,
      totalPieces: lineSnapshots.reduce((sum, line) => sum + line.pieces, 0),
      totalWeightKg: Number(lineSnapshots.reduce((sum, line) => sum + line.weightKg, 0).toFixed(3)),
      totalBags: 1,
      createdBy: userId,
      actorRole,
      generatedAt: new Date()
    });

    await AuditLog.create({
      action: "SHIPMENT_MANIFEST_GENERATED",
      entityType: "SHIPMENT_MANIFEST",
      entityId: manifest._id,
      performedBy: userId,
      performedAt: new Date(),
      metadata: { manifestNumber, shipmentDraftIds: selectedObjectIds, actorRole, source: "BULK" }
    });

    if (actorRole === "client") {
      const creator = await User.findById(userId).select("name email").lean().exec();
      await notifyAdminsOfClientManifest({
        manifest,
        businessAccountName,
        generatedBy: creator?.name || creator?.email || ""
      });
    }

    return response.status(201).json({ success: true, manifest: serializeShipmentManifest(manifest) });
  } catch (error) {
    return sendManifestError(response, error);
  }
}

export async function createAdminBulkShipmentManifest(request: Request, response: Response) {
  return createBulkManifest(request, response, "admin");
}

export async function createClientBulkShipmentManifest(request: Request, response: Response) {
  return createBulkManifest(request, response, "client");
}

export async function listAdminShipmentManifests(request: Request, response: Response) {
  return listManifests(request, response, "admin");
}

export async function listClientShipmentManifests(request: Request, response: Response) {
  return listManifests(request, response, "client");
}

export async function downloadAdminShipmentManifestPdf(request: Request, response: Response) {
  return downloadManifestPdf(request, response, "admin");
}

export async function downloadClientShipmentManifestPdf(request: Request, response: Response) {
  return downloadManifestPdf(request, response, "client");
}

export async function deleteAdminShipmentManifest(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const manifestId = getManifestId(request);
  if (!manifestId) return response.status(404).json({ success: false, message: "Manifest not found." });
  const manifest = await ShipmentManifest.findById(manifestId).exec();
  if (!manifest) return response.status(404).json({ success: false, message: "Manifest not found." });

  await ShipmentManifest.deleteOne({ _id: manifestId }).exec();
  await AuditLog.create({
    action: "SHIPMENT_MANIFEST_DELETED",
    entityType: "SHIPMENT_MANIFEST",
    entityId: manifestId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      manifestNumber: manifest.manifestNumber,
      businessAccountId: manifest.businessAccountId,
      branchId: manifest.branchId,
      shipmentCount: manifest.lineSnapshots.length
    }
  });

  return response.status(200).json({
    success: true,
    message: `${manifest.manifestNumber} deleted successfully.`,
    deleted: { id: String(manifest._id), manifestNumber: manifest.manifestNumber }
  });
}

const bulkDeleteShipmentManifestSchema = z.object({
  manifestIds: z.array(
    z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select valid manifests.")
  ).min(1, "Select at least one manifest.").max(100, "You can delete up to 100 manifests at once.")
});

export async function deleteAdminBulkShipmentManifests(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = bulkDeleteShipmentManifestSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Select valid manifests."
    });
  }

  const uniqueIds = [...new Set(parsed.data.manifestIds)];
  const objectIds = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));

  const manifests = await ShipmentManifest.find({ _id: { $in: objectIds } })
    .select("manifestNumber businessAccountId branchId lineSnapshots")
    .lean()
    .exec();

  if (!manifests.length) {
    return response.status(404).json({ success: false, message: "No matching manifests found." });
  }

  const foundIds = manifests.map((manifest) => manifest._id);
  const foundIdStrings = new Set(foundIds.map(String));
  const notFoundCount = uniqueIds.length - foundIds.length;

  await ShipmentManifest.deleteMany({ _id: { $in: foundIds } }).exec();

  if (manifests.length) {
    await AuditLog.insertMany(
      manifests.map((manifest) => ({
        action: "SHIPMENT_MANIFEST_DELETED" as const,
        entityType: "SHIPMENT_MANIFEST" as const,
        entityId: manifest._id,
        performedBy: userId,
        performedAt: new Date(),
        metadata: {
          manifestNumber: manifest.manifestNumber,
          bulk: true
        }
      })),
      { ordered: false }
    ).catch(() => undefined);
  }

  return response.status(200).json({
    success: true,
    message:
      notFoundCount > 0
        ? `${manifests.length} manifest(s) deleted. ${notFoundCount} not found.`
        : `${manifests.length} manifest(s) deleted successfully.`,
    deletedCount: manifests.length,
    notFoundCount,
    deletedIds: foundIds.map(String)
  });
}
