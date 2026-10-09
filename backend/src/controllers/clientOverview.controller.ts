import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { buildClientOverview } from "../services/clientOverview.service.js";
import { collectClientAttention } from "../services/clientAttention.service.js";
import { searchClientRecords, searchStaffRecords } from "../services/clientSearch.service.js";
import { allowedBranchIds } from "../middleware/branchAccess.middleware.js";
import {
  ShipmentSupportingDocument,
  shipmentSupportingDocumentTypeValues
} from "../models/shipmentSupportingDocument.model.js";
import {
  addSupportingDocument,
  canAcceptSupportingDocuments,
  listSupportingDocuments,
  ShipmentSupportingDocumentError
} from "../services/shipmentSupportingDocument.service.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { clientCanAccessShipmentDraft } from "../services/shipmentDraftPolicy.service.js";
import { streamObjectToResponse } from "../services/storage/storage.service.js";
import { resolveClientScope } from "../utils/clientScope.js";

const supportingDocumentSchema = z.object({
  documentType: z.enum(shipmentSupportingDocumentTypeValues),
  note: z.string().trim().max(500).optional().default("")
});

function getRequestUserId(request: Request) {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  return user?._id ? String(user._id) : "";
}

/**
 * The shipment this caller is asking about, or null if it is not theirs.
 *
 * Membership is checked against the draft's own account and branch rather than
 * against a query parameter, so the URL alone cannot reach another customer's
 * shipment.
 */
async function resolveOwnedDraft(request: Request) {
  const userId = getRequestUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!userId || !mongoose.Types.ObjectId.isValid(draftId)) return null;

  const draft = await ShipmentDraft.findById(draftId)
    .select("_id businessAccountId branchId")
    .lean()
    .exec();
  if (!draft) return null;

  const allowed = await clientCanAccessShipmentDraft({ userId, draft });
  return allowed ? { userId, draftId, shipmentDraftId: draft._id as mongoose.Types.ObjectId } : null;
}

/** Every figure and list the client dashboard renders, in one call. */
export async function getClientOverview(request: Request, response: Response): Promise<Response> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) {
    return response.status(scope.status).json({ success: false, message: scope.message });
  }

  const overview = await buildClientOverview(scope);
  return response.status(200).json({ success: true, ...overview });
}

/** The Exceptions centre. The same engine, without the dashboard's summary. */
export async function listClientExceptions(request: Request, response: Response): Promise<Response> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) {
    return response.status(scope.status).json({ success: false, message: scope.message });
  }

  const { exceptions, exceptionCountsByType } = await collectClientAttention(scope);
  return response.status(200).json({ success: true, exceptions, exceptionCountsByType });
}

/** The Action Required page. */
export async function listClientActions(request: Request, response: Response): Promise<Response> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) {
    return response.status(scope.status).json({ success: false, message: scope.message });
  }

  const { actions } = await collectClientAttention(scope);
  return response.status(200).json({ success: true, actions });
}

/** Global search, across every kind of record a customer holds a number for. */
export async function searchClient(request: Request, response: Response): Promise<Response> {
  const scope = await resolveClientScope(request);
  if (!scope.ok) {
    return response.status(scope.status).json({ success: false, message: scope.message });
  }

  const term = typeof request.query.q === "string" ? request.query.q : "";
  // Long enough to be a pasted identifier, short enough that nobody is probing
  // with a payload.
  if (term.length > 80) {
    return response.status(400).json({ success: false, message: "Search term is too long." });
  }

  const results = await searchClientRecords({ ...scope, term });
  return response.status(200).json({ success: true, results });
}

// ── post-booking supporting documents ─────────────────────────────────────────

/**
 * Documents a customer supplies once a shipment is already booked, which is
 * when customs asks for them. Kept on this controller because it shares the
 * account-and-branch scoping every client-wide surface uses.
 */
export async function listClientShipmentDocuments(request: Request, response: Response): Promise<Response> {
  const owned = await resolveOwnedDraft(request);
  if (!owned) return response.status(404).json({ success: false, message: "Shipment not found." });

  const { shipmentDraftId } = owned;
  const [documents, eligibility] = await Promise.all([
    listSupportingDocuments(shipmentDraftId),
    canAcceptSupportingDocuments(shipmentDraftId)
  ]);

  return response.status(200).json({
    success: true,
    documents,
    canUpload: eligibility.allowed,
    documentsRequested: eligibility.allowed ? eligibility.requested : false,
    reason: eligibility.allowed ? "" : eligibility.reason
  });
}

export async function uploadClientShipmentDocument(request: Request, response: Response): Promise<Response> {
  const owned = await resolveOwnedDraft(request);
  if (!owned) return response.status(404).json({ success: false, message: "Shipment not found." });

  const file = (request as Request & { file?: Express.Multer.File }).file;
  if (!file) return response.status(400).json({ success: false, message: "Choose a document to upload." });

  const parsed = supportingDocumentSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Select what kind of document this is." });
  }

  try {
    await addSupportingDocument({
      shipmentDraftId: owned.shipmentDraftId,
      documentType: parsed.data.documentType,
      note: parsed.data.note,
      file,
      uploadedBy: new mongoose.Types.ObjectId(owned.userId)
    });
  } catch (error) {
    if (error instanceof ShipmentSupportingDocumentError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }

  return response.status(201).json({
    success: true,
    message: "Document sent to Swiftline Operations.",
    documents: await listSupportingDocuments(owned.shipmentDraftId)
  });
}

/**
 * The staff view of the same documents.
 *
 * Kept as its own pair of handlers rather than reusing the client ones, because
 * the two answer different access questions: a client is a member of the
 * shipment's account, a staff user is scoped by branch. Sharing one handler
 * would mean a runtime branch on the caller's role, which is exactly where a
 * scoping mistake hides.
 */
async function resolveStaffDraft(request: Request) {
  const user = (request as Request & {
    user?: { _id?: unknown; role?: string; assignedBranches?: unknown[] };
  }).user;
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!user?._id || !mongoose.Types.ObjectId.isValid(draftId)) return null;

  const draft = await ShipmentDraft.findById(draftId).select("_id branchId").lean().exec();
  if (!draft) return null;

  // Admin sees every branch; everyone else only the branches they are assigned,
  // matching how the rest of the staff shipment surfaces already scope.
  if (user.role !== "admin") {
    const allowed = (user.assignedBranches ?? []).map((branchId) => String(branchId));
    if (!allowed.includes(String(draft.branchId))) return null;
  }

  return { shipmentDraftId: draft._id as mongoose.Types.ObjectId };
}

export async function listStaffShipmentDocuments(request: Request, response: Response): Promise<Response> {
  const owned = await resolveStaffDraft(request);
  if (!owned) return response.status(404).json({ success: false, message: "Shipment not found." });

  return response.status(200).json({
    success: true,
    documents: await listSupportingDocuments(owned.shipmentDraftId, { includeUploader: true })
  });
}

export async function downloadStaffShipmentDocument(request: Request, response: Response): Promise<Response | void> {
  const owned = await resolveStaffDraft(request);
  if (!owned) return response.status(404).json({ success: false, message: "Shipment not found." });

  const document = await ShipmentSupportingDocument.findOne({
    _id: request.params.documentId,
    shipmentDraftId: owned.shipmentDraftId
  }).lean().exec();
  if (!document) return response.status(404).json({ success: false, message: "Document not found." });

  return streamObjectToResponse({
    key: document.storageKey,
    response,
    contentType: document.mimeType,
    filename: document.originalName
  });
}

export async function downloadClientShipmentDocument(request: Request, response: Response): Promise<Response | void> {
  const owned = await resolveOwnedDraft(request);
  if (!owned) return response.status(404).json({ success: false, message: "Shipment not found." });

  const document = await ShipmentSupportingDocument.findOne({
    _id: request.params.documentId,
    shipmentDraftId: owned.shipmentDraftId
  }).lean().exec();
  if (!document) return response.status(404).json({ success: false, message: "Document not found." });

  return streamObjectToResponse({
    key: document.storageKey,
    response,
    contentType: document.mimeType,
    filename: document.originalName
  });
}

/**
 * Staff global search. Scoped to the branches a staff user is assigned to, and
 * unscoped for those assigned none- which is how the staff shipment listings
 * already behave.
 */
export async function searchStaff(request: Request, response: Response): Promise<Response> {
  const user = (request as Request & { user?: { _id?: unknown; assignedBranches?: unknown[] } }).user;
  if (!user?._id) return response.status(401).json({ success: false, message: "Unauthorized" });

  const term = typeof request.query.q === "string" ? request.query.q : "";
  if (term.length > 80) {
    return response.status(400).json({ success: false, message: "Search term is too long." });
  }

  const allowed = allowedBranchIds(request);
  const branchIds = allowed === null ? undefined : allowed
    .filter((branchId) => mongoose.Types.ObjectId.isValid(branchId))
    .map((branchId) => new mongoose.Types.ObjectId(branchId));

  const results = await searchStaffRecords({ term, branchIds });
  return response.status(200).json({ success: true, results });
}
