import mongoose from "mongoose";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import {
  ShipmentSupportingDocument,
  shipmentSupportingDocumentLabels,
  type ShipmentSupportingDocumentType
} from "../models/shipmentSupportingDocument.model.js";
import { User } from "../models/user.model.js";
import { enqueueEmails, resolveUserRecipients } from "./email/enqueue.js";
import { notifyPortalUsers } from "./portalNotification.service.js";
import { matchesDeclaredType } from "./storage/fileSignature.js";
import { shipmentSupportingDocumentKey } from "./storage/keys.js";
import { putObject } from "./storage/storage.service.js";
import { suspensionMessage } from "./businessAccountSuspension.service.js";

export const maxSupportingDocumentBytes = 10 * 1024 * 1024;

export class ShipmentSupportingDocumentError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ShipmentSupportingDocumentError";
  }
}

/**
 * Whether this shipment can still take a supporting document.
 *
 * Only a booked shipment: before booking the KYC pack on the draft is the right
 * place, and a draft can still be edited. After delivery there is nothing left
 * for customs to ask for, and a claim is the proper channel for anything that
 * went wrong.
 */
export async function canAcceptSupportingDocuments(shipmentDraftId: mongoose.Types.ObjectId) {
  const booking = await DpdShipment.findOne({ shipmentDraftId, status: "LABEL_RECEIVED" })
    .select("_id swiftlineTrackingNumber dpdShipmentId")
    .lean()
    .exec();
  if (!booking) return { allowed: false as const, reason: "This shipment is not booked yet." };

  const latest = await ShipmentEvent.findOne({ shipmentDraftId, customerVisible: true })
    .sort({ eventAt: -1, createdAt: -1 })
    .select("status")
    .lean()
    .exec();

  if (latest && ["DELIVERED", "SHIPMENT_CANCELLED", "RETURNED"].includes(latest.status)) {
    return { allowed: false as const, reason: "This shipment has already completed its journey." };
  }

  return {
    allowed: true as const,
    trackingNumber: booking.swiftlineTrackingNumber || booking.dpdShipmentId || "",
    /** Whether documents were actually asked for, which the UI uses to lead with it. */
    requested: latest?.status === "ON_HOLD"
  };
}

export async function listSupportingDocuments(
  shipmentDraftId: mongoose.Types.ObjectId,
  options: { includeUploader?: boolean } = {}
) {
  const documents = await ShipmentSupportingDocument.find({ shipmentDraftId })
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  // Only staff are told who sent it. A client already knows- it was their own
  // account- and naming a colleague back to them adds nothing.
  const uploaders = options.includeUploader && documents.length
    ? new Map(
      (await User.find({ _id: { $in: documents.map((document) => document.uploadedBy) } })
        .select("name email")
        .lean()
        .exec()).map((user) => [String(user._id), user.name || user.email])
    )
    : new Map<string, string>();

  return documents.map((document) => ({
    id: String(document._id),
    documentType: document.documentType,
    documentLabel: shipmentSupportingDocumentLabels[document.documentType],
    originalName: document.originalName,
    mimeType: document.mimeType,
    size: document.size,
    note: document.note,
    uploadedAt: document.createdAt,
    uploadedBy: uploaders.get(String(document.uploadedBy)) ?? ""
  }));
}

/**
 * Stores one document and tells Operations it arrived.
 *
 * The notification and the email both lead with the tracking number: an
 * operator holding a queue of held shipments needs to know which one this
 * unblocks, and a document that lands silently helps nobody.
 */
export async function addSupportingDocument(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  documentType: ShipmentSupportingDocumentType;
  note: string;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
  uploadedBy: mongoose.Types.ObjectId;
}) {
  const draft = await ShipmentDraft.findById(input.shipmentDraftId)
    .select("_id businessAccountId branchId")
    .lean()
    .exec();
  if (!draft) throw new ShipmentSupportingDocumentError("Shipment not found.", 404);

  const account = await BusinessAccount.findById(draft.businessAccountId)
    .select("status accountKind")
    .lean()
    .exec();
  if (!account) throw new ShipmentSupportingDocumentError("Shipment not found.", 404);
  if (account.status === "suspended" && account.accountKind !== "INDIVIDUAL_SENTINEL") {
    throw new ShipmentSupportingDocumentError(suspensionMessage, 423);
  }

  const eligibility = await canAcceptSupportingDocuments(input.shipmentDraftId);
  if (!eligibility.allowed) throw new ShipmentSupportingDocumentError(eligibility.reason, 409);

  // The declared content type is whatever the client chose to send, so the
  // bytes are checked against it before anything is stored.
  if (!matchesDeclaredType(input.file.buffer, input.file.mimetype)) {
    throw new ShipmentSupportingDocumentError(
      "That file does not match the type it claims to be. Upload a valid PDF, JPG, PNG or WebP.",
      400
    );
  }

  const stored = await putObject({
    key: shipmentSupportingDocumentKey(String(input.shipmentDraftId), input.file.originalname),
    body: input.file.buffer,
    contentType: input.file.mimetype
  });

  const document = await ShipmentSupportingDocument.create({
    shipmentDraftId: draft._id,
    businessAccountId: draft.businessAccountId,
    branchId: draft.branchId,
    documentType: input.documentType,
    originalName: input.file.originalname,
    storageKey: stored.key,
    mimeType: input.file.mimetype,
    size: input.file.size,
    note: input.note,
    uploadedBy: input.uploadedBy
  });

  await notifyOperations({
    shipmentDraftId: String(draft._id),
    documentId: String(document._id),
    trackingNumber: eligibility.trackingNumber,
    documentLabel: shipmentSupportingDocumentLabels[input.documentType],
    note: input.note
  });

  return document;
}

/**
 * Operations and admin, by role.
 *
 * Addressed by role rather than to whoever placed the hold: that person may be
 * off shift, and a held shipment is the team's problem, not one operator's.
 */
async function notifyOperations(input: {
  shipmentDraftId: string;
  documentId: string;
  trackingNumber: string;
  documentLabel: string;
  note: string;
}) {
  const staff = await User.find({ role: { $in: ["operations", "admin"] }, userStatus: "active" })
    .select("_id")
    .lean()
    .exec();
  if (!staff.length) return;

  const reference = input.trackingNumber || "a booked shipment";
  const title = `Document uploaded for ${reference}`;
  const message = input.note
    ? `${input.documentLabel} received. Customer note: ${input.note}`
    : `${input.documentLabel} received from the customer.`;

  const recipients = staff.map((user) => user._id as mongoose.Types.ObjectId);
  const idempotencyKey = `SHIPMENT_DOCUMENT_UPLOADED:${input.documentId}`;

  await notifyPortalUsers(recipients, {
    type: "SHIPMENT_DOCUMENT_UPLOADED",
    title,
    message,
    href: `/dashboard/shipments/${input.shipmentDraftId}`,
    idempotencyKey
  });

  await enqueueEmails({
    notificationType: "SHIPMENT_DOCUMENT_UPLOADED",
    idempotencyKey,
    recipients: await resolveUserRecipients(recipients),
    // The tracking number leads the subject line so it is readable from a
    // notification list without opening the mail.
    subject: `${reference}- ${input.documentLabel} uploaded by customer`,
    payload: {
      trackingNumber: reference,
      documentLabel: input.documentLabel,
      note: input.note,
      shipmentUrl: `/dashboard/shipments/${input.shipmentDraftId}`
    }
  });
}
