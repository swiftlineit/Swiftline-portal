import crypto from "crypto";
import mongoose from "mongoose";
import { Claim } from "../../models/claim.model.js";
import { BusinessAccount } from "../../models/businessAccount.model.js";
import { ClaimDocument, ClaimDocumentAccess } from "../../models/claimDocument.model.js";
import type { ClaimDocumentCategory } from "../../models/claimDocument.model.js";
import { ClaimEvent } from "../../models/claimEvent.model.js";
import { AuditLog } from "../../models/auditLog.model.js";
import { claimDocumentKey, putObject, streamObjectToResponse } from "../storage/storage.service.js";
import type { ClaimDocumentStorageType } from "../storage/keys.js";
import type { Response } from "express";
import { notifyClaimDocumentRejected } from "./claimNotification.service.js";
import { securityLockMessage, suspensionMessage, suspensionMode } from "../businessAccountSuspension.service.js";

/**
 * Claim evidence: accepting it, and giving it back only to people entitled to
 * see it.
 *
 * Everything here goes through the storage service, so the same code works on
 * local disk and on S3. Rows persist a storage key and never a path or URL.
 */

export class ClaimDocumentError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ClaimDocumentError";
  }
}

export const maxClaimDocumentBytes = 10 * 1024 * 1024;
export const maxActiveClaimDocuments = 20;

/** Types we accept, and the byte signature each must actually start with. */
const acceptedTypes: Record<string, { extensions: string[]; signatures: Buffer[] }> = {
  "application/pdf": { extensions: ["pdf"], signatures: [Buffer.from("%PDF")] },
  "image/jpeg": { extensions: ["jpg", "jpeg"], signatures: [Buffer.from([0xff, 0xd8, 0xff])] },
  "image/png": {
    extensions: ["png"],
    signatures: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  },
  "image/webp": { extensions: ["webp"], signatures: [Buffer.from("RIFF")] }
};

/**
 * Confirms the bytes are what the upload claims they are.
 *
 * A declared MIME type is whatever the client chose to send, and an extension is
 * whatever they chose to name the file. Reading the leading bytes is the only
 * check of the three that the client cannot simply assert.
 */
function hasValidSignature(buffer: Buffer, mimeType: string) {
  const accepted = acceptedTypes[mimeType];
  if (!accepted) return false;
  return accepted.signatures.some((signature) => buffer.subarray(0, signature.length).equals(signature));
}

export async function uploadClaimDocument(input: {
  claimId: string;
  category: ClaimDocumentCategory;
  storageType?: ClaimDocumentStorageType;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy: string;
  uploadedByKind: "CLIENT" | "STAFF";
  visibility?: "PUBLIC" | "INTERNAL";
}) {
  const claim = await Claim.findById(input.claimId).exec();
  if (!claim) throw new ClaimDocumentError("Claim not found.", 404);

  if (input.uploadedByKind === "CLIENT") {
    const account = await BusinessAccount.findById(claim.businessAccountId)
      .select("status suspension.mode")
      .lean()
      .exec();
    const mode = account ? suspensionMode(account) : null;
    if (!account || mode === "SECURITY_LOCK") throw new ClaimDocumentError(securityLockMessage, 404);
    if (mode) throw new ClaimDocumentError(suspensionMessage, 423);
  }

  if (input.buffer.length === 0) throw new ClaimDocumentError("The uploaded file is empty.");
  if (input.buffer.length > maxClaimDocumentBytes) {
    throw new ClaimDocumentError("Each document must be 10 MB or smaller.");
  }

  const accepted = acceptedTypes[input.mimeType];
  if (!accepted) {
    throw new ClaimDocumentError("Evidence must be a PDF, JPG, PNG, or WebP file.");
  }

  if (!hasValidSignature(input.buffer, input.mimeType)) {
    // The declared type and the actual bytes disagree. Refused rather than
    // corrected, because a file pretending to be something else is not a
    // mistake we should quietly work around.
    throw new ClaimDocumentError("The uploaded file is not a valid document.");
  }

  const activeCount = await ClaimDocument.countDocuments({
    claimId: claim._id,
    deletedAt: null,
    reviewState: { $ne: "REPLACED" }
  });
  if (activeCount >= maxActiveClaimDocuments) {
    throw new ClaimDocumentError(
      `A claim can hold ${maxActiveClaimDocuments} documents. Remove one before adding another.`
    );
  }

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");

  // The same bytes already on this claim are almost always an accidental
  // re-upload. Returning the existing row keeps the evidence list honest.
  const duplicate = await ClaimDocument.findOne({ claimId: claim._id, sha256, deletedAt: null }).exec();
  if (duplicate) return { document: duplicate, duplicate: true };

  const storageKey = claimDocumentKey({
    claimId: String(claim._id),
    documentType: input.storageType ?? "evidence",
    originalName: input.originalName
  });

  await putObject({
    key: storageKey,
    body: input.buffer,
    contentType: input.mimeType,
    originalName: input.originalName
  });

  const document = await ClaimDocument.create({
    claimId: claim._id,
    category: input.category,
    storageKey,
    originalName: input.originalName,
    mimeType: input.mimeType,
    size: input.buffer.length,
    sha256,
    uploadedBy: new mongoose.Types.ObjectId(input.uploadedBy),
    uploadedByKind: input.uploadedByKind,
    visibility: input.visibility ?? "PUBLIC"
  });

  await ClaimEvent.create({
    claimId: claim._id,
    type: "DOCUMENT_UPLOADED",
    actorUserId: new mongoose.Types.ObjectId(input.uploadedBy),
    actorKind: input.uploadedByKind,
    visibility: "PUBLIC",
    reason: `${input.category.replace(/_/g, " ").toLowerCase()} uploaded.`,
    metadata: { documentId: String(document._id), category: input.category }
  });

  await AuditLog.create({
    action: "CLAIM_DOCUMENT_UPLOADED",
    entityType: "CLAIM_DOCUMENT",
    entityId: document._id,
    performedBy: new mongoose.Types.ObjectId(input.uploadedBy),
    performedAt: new Date(),
    // The storage key is recorded; the contents never are.
    metadata: { claimId: String(claim._id), category: input.category, sha256 }
  });

  return { document, duplicate: false };
}

/**
 * Streams a document to an authorised caller.
 *
 * Streamed rather than redirected to a signed URL. A signed URL stays valid for
 * its whole lifetime wherever it travels- forwarded in an email, sitting in a
 * browser history- and claim evidence contains loss photographs and bank
 * identifiers. A streamed response dies with the request.
 */
export async function streamClaimDocument(input: {
  response: Response;
  documentId: string;
  claimId: string;
  userId: string;
  ipAddress: string;
  disposition?: "inline" | "attachment";
}) {
  const document = await ClaimDocument.findOne({
    _id: input.documentId,
    claimId: input.claimId,
    deletedAt: null
  }).exec();

  if (!document) throw new ClaimDocumentError("Document not found.", 404);

  if (document.scanState === "QUARANTINED") {
    throw new ClaimDocumentError("This document is unavailable.", 409);
  }

  // Recorded before the bytes move, so an interrupted download still leaves a
  // trace of who asked for it.
  await ClaimDocumentAccess.create({
    claimId: document.claimId,
    documentId: document._id,
    userId: new mongoose.Types.ObjectId(input.userId),
    action: input.disposition === "inline" ? "VIEWED" : "DOWNLOADED",
    ipAddress: input.ipAddress
  });

  await streamObjectToResponse({
    response: input.response,
    key: document.storageKey,
    contentType: document.mimeType,
    filename: document.originalName,
    disposition: input.disposition ?? "attachment"
  });
}

/** Accepts or rejects a document during review. */
export async function reviewClaimDocument(input: {
  documentId: string;
  claimId: string;
  reviewerId: string;
  decision: "ACCEPTED" | "REJECTED";
  reason?: string;
}) {
  const document = await ClaimDocument.findOne({
    _id: input.documentId,
    claimId: input.claimId,
    deletedAt: null
  }).exec();

  if (!document) throw new ClaimDocumentError("Document not found.", 404);

  if (input.decision === "REJECTED" && !input.reason?.trim()) {
    // A rejection the client cannot act on just costs everyone another round.
    throw new ClaimDocumentError("Explain why the document is being rejected.");
  }

  document.reviewState = input.decision;
  document.reviewedBy = new mongoose.Types.ObjectId(input.reviewerId);
  document.reviewedAt = new Date();
  document.rejectionReason = input.decision === "REJECTED" ? (input.reason ?? "") : "";
  await document.save();

  await ClaimEvent.create({
    claimId: document.claimId,
    type: input.decision === "ACCEPTED" ? "DOCUMENT_ACCEPTED" : "DOCUMENT_REJECTED",
    actorUserId: new mongoose.Types.ObjectId(input.reviewerId),
    actorKind: "STAFF",
    visibility: "PUBLIC",
    reason: input.reason ?? "",
    metadata: { documentId: String(document._id), category: document.category }
  });

  await AuditLog.create({
    action: "CLAIM_DOCUMENT_REVIEWED",
    entityType: "CLAIM_DOCUMENT",
    entityId: document._id,
    performedBy: new mongoose.Types.ObjectId(input.reviewerId),
    performedAt: new Date(),
    metadata: { decision: input.decision }
  });

  // A rejection is the only outcome the client must act on, and the reason
  // travels with it so they can fix it without opening the portal to find out.
  if (input.decision === "REJECTED") {
    const claim = await Claim.findById(document.claimId).exec();
    if (claim) await notifyClaimDocumentRejected(claim, document.originalName, input.reason ?? "");
  }

  return document;
}

/**
 * Soft-deletes a document.
 *
 * The row survives so the timeline still references something real and a legal
 * hold still has something to hold. Purging the stored object is a retention
 * job's work, not a client action's.
 */
export async function removeClaimDocument(input: {
  documentId: string;
  claimId: string;
  userId: string;
}) {
  const document = await ClaimDocument.findOne({
    _id: input.documentId,
    claimId: input.claimId,
    deletedAt: null
  }).exec();

  if (!document) throw new ClaimDocumentError("Document not found.", 404);

  if (document.legalHold) {
    throw new ClaimDocumentError("This document is under legal hold and cannot be removed.", 409);
  }
  if (document.reviewState === "ACCEPTED") {
    throw new ClaimDocumentError("A document that has been accepted cannot be removed.", 409);
  }

  document.deletedAt = new Date();
  await document.save();

  return document;
}
