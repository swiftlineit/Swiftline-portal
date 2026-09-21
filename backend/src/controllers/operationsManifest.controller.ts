import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Branch } from "../models/branch.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { buildOperationsManifestEdi } from "../services/edi/ediExport.service.js";
import {
  buildOperationsManifestExcel,
  buildOperationsManifestPdf,
  cancelOperationsBag,
  cancelOperationsManifest,
  closeOperationsBag,
  closeOperationsBags,
  createOperationsBag,
  createOperationsManifest,
  deleteOperationsManifest,
  dispatchOperationsManifest,
  getOperationsManifestDetail,
  listOperationsManifests,
  markOperationsBagReady,
  moveOperationsConsignment,
  OperationsManifestServiceError,
  removeOperationsScan,
  reopenOperationsBag,
  scanOperationsParcel,
  sealOperationsManifest,
  setOperationsParcelDisposition,
  updateOperationsManifest
} from "../services/operationsManifest.service.js";
import {
  buildOperationsManifestUkExcel,
  ukOperationsManifestFilename
} from "../services/operationsManifestUk.service.js";
import { operationsBranchIds, operationsUser } from "../middleware/operationsBranchAccess.middleware.js";
import {
  assertCameraScanSession,
  OperationsScanSessionError
} from "../services/operationsScanSession.service.js";

const headerSchema = z.object({
  destinationAgent: z.string().trim().max(1000).default(""),
  destinationCountryCode: z.string().trim().toUpperCase().max(2).default(""),
  destinationCountryName: z.string().trim().max(100).default(""),
  flightNumber: z.string().trim().toUpperCase().max(40).default(""),
  departureDate: z.string().trim().max(10).default(""),
  mawbNumber: z.string().trim().toUpperCase().max(40).default(""),
  originIataCode: z.string().trim().toUpperCase().max(3).default(""),
  destinationIataCode: z.string().trim().toUpperCase().max(3).default(""),
  valueType: z.string().trim().toUpperCase().max(20).default("LV")
});

const reasonSchema = z.object({ reason: z.string().trim().min(5, "Enter a clear reason of at least 5 characters.").max(500) });
const optionalReasonSchema = z.object({ reason: z.string().trim().max(500).optional().default("") });

function userId(request: Request) {
  const id = String((request as Request & { user?: { _id?: unknown } }).user?._id ?? "");
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function parsedBody<T>(response: Response, schema: z.ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Check the entered details." });
  return null;
}

function sendError(response: Response, error: unknown) {
  if (error instanceof OperationsScanSessionError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error instanceof OperationsManifestServiceError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
    return response.status(409).json({ success: false, message: "This operation was already completed. Refresh the manifest and try again." });
  }
  throw error;
}

export async function listBranchOptions(request: Request, response: Response) {
  const allowedBranches = operationsBranchIds(request);
  const branches = await Branch.find({
    status: "ACTIVE",
    ...(allowedBranches === null ? {} : { _id: { $in: allowedBranches } })
  }).select("name code address").sort({ name: 1 }).lean().exec();
  return response.json({ success: true, branches: branches.map((branch) => ({ id: String(branch._id), name: branch.name, code: branch.code, address: branch.address })) });
}

export async function listManifests(request: Request, response: Response) {
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(15), status: z.string().optional(), branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional() }).safeParse(request.query);
  if (!query.success) return response.status(400).json({ success: false, message: "Manifest filters are invalid." });
  const allowedBranches = operationsBranchIds(request);
  if (query.data.branchId && allowedBranches !== null && !allowedBranches.includes(query.data.branchId)) {
    return response.status(403).json({ success: false, message: "You do not have access to this branch." });
  }
  return response.json({
    success: true,
    ...(await listOperationsManifests({ ...query.data, allowedBranchIds: allowedBranches }))
  });
}

export async function createManifest(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    const input = parsedBody(response, z.object({ branchId: z.string(), header: headerSchema }), request.body);
    if (!actorId || !input) return;
    const manifest = await createOperationsManifest({ ...input, userId: actorId });
    return response.status(201).json({ success: true, manifestId: String(manifest._id), manifestNumber: manifest.manifestNumber });
  } catch (error) { return sendError(response, error); }
}

export async function getManifest(request: Request, response: Response) {
  try { return response.json({ success: true, ...(await getOperationsManifestDetail(String(request.params.manifestId))) }); }
  catch (error) { return sendError(response, error); }
}

export async function updateManifest(request: Request, response: Response) {
  try {
    const actorId = userId(request); const header = parsedBody(response, headerSchema, request.body.header);
    if (!actorId || !header) return;
    await updateOperationsManifest({ manifestId: String(request.params.manifestId), header, userId: actorId });
    return response.json({ success: true, message: "Manifest details updated." });
  } catch (error) { return sendError(response, error); }
}

export async function createBag(request: Request, response: Response) {
  try { const actorId = userId(request); if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" }); const bag = await createOperationsBag(String(request.params.manifestId), actorId); return response.status(201).json({ success: true, bag }); }
  catch (error) { return sendError(response, error); }
}

export async function scanParcel(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    const input = parsedBody(response, z.object({
      bagId: z.string().optional(),
      parcelNumber: z.string().trim().min(1, "Scan or enter a Swiftline parcel barcode."),
      scanRequestId: z.string().uuid().optional(),
      scanSource: z.enum(["MANUAL", "CAMERA", "HARDWARE"]).optional().default("MANUAL"),
      sessionId: z.string().optional(),
      responseMode: z.enum(["DETAIL", "COMPACT"]).optional().default("DETAIL")
    }).superRefine((data, context) => {
      if (data.scanSource === "CAMERA" && !data.sessionId) {
        context.addIssue({ code: "custom", path: ["sessionId"], message: "Connect this phone to the manifest before scanning." });
      }
    }), request.body);
    if (!actorId || !input) return;
    const currentUser = operationsUser(request);
    if (input.sessionId && currentUser) {
      await assertCameraScanSession({
        sessionId: input.sessionId,
        manifestId: String(request.params.manifestId),
        actor: {
          userId: actorId,
          role: currentUser.role,
          assignedBranchIds: (currentUser.assignedBranches ?? []).map(String)
        }
      });
    }
    return response.json({
      success: true,
      ...(await scanOperationsParcel({
        manifestId: String(request.params.manifestId),
        ...input,
        scanSessionId: input.sessionId,
        userId: actorId
      }))
    });
  } catch (error) { return sendError(response, error); }
}

// Bag handling is a physical workflow, so open, close, reopen, and cancel all run
// without a mandatory explanation. A note is kept when the operator supplies one.
async function bagAction(request: Request, response: Response, action: "close" | "reopen" | "cancel") {
  try {
    const actorId = userId(request); if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const manifestId = String(request.params.manifestId);
    const bagId = String(request.params.bagId);
    const note = parsedBody(response, optionalReasonSchema, request.body ?? {});
    if (!note) return;
    if (action === "close") await closeOperationsBag(manifestId, bagId, actorId);
    else if (action === "reopen") await reopenOperationsBag(manifestId, bagId, note.reason, actorId);
    else await cancelOperationsBag(manifestId, bagId, note.reason, actorId);
    return response.json({ success: true, message: `Bag ${action}d successfully.` });
  } catch (error) { return sendError(response, error); }
}

export const closeBag = (request: Request, response: Response) => bagAction(request, response, "close");
export const reopenBag = (request: Request, response: Response) => bagAction(request, response, "reopen");
export const cancelBag = (request: Request, response: Response) => bagAction(request, response, "cancel");

export async function closeAllBags(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const result = await closeOperationsBags(String(request.params.manifestId), actorId);
    return response.json({
      success: true,
      message: result.closed ? `${result.closed} bag${result.closed === 1 ? "" : "s"} closed.` : "Every bag is already closed.",
      result
    });
  } catch (error) { return sendError(response, error); }
}

export async function markBagReady(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    const input = parsedBody(response, z.object({
      bagBarcode: z.string().trim().min(1, "Scan the closed bag barcode.").max(80)
    }), request.body);
    if (!actorId || !input) return;
    const result = await markOperationsBagReady({
      manifestId: String(request.params.manifestId),
      bagBarcode: input.bagBarcode,
      userId: actorId
    });
    return response.json({
      success: true,
      message: result.alreadyReady
        ? `${result.bagNumber} was already Ready for Dispatch.`
        : `${result.bagNumber} is Ready for Dispatch. ${result.updatedShipments} shipment milestone(s) updated.`,
      result
    });
  } catch (error) { return sendError(response, error); }
}

export async function removeScan(request: Request, response: Response) {
  try { const actorId = userId(request); const input = parsedBody(response, reasonSchema, request.body); if (!actorId || !input) return; await removeOperationsScan({ manifestId: String(request.params.manifestId), scanId: String(request.params.scanId), ...input, userId: actorId }); return response.json({ success: true, message: "Parcel scan removed." }); }
  catch (error) { return sendError(response, error); }
}

export async function moveConsignment(request: Request, response: Response) {
  try { const actorId = userId(request); const input = parsedBody(response, reasonSchema.extend({ targetBagId: z.string() }), request.body); if (!actorId || !input) return; await moveOperationsConsignment({ manifestId: String(request.params.manifestId), consignmentId: String(request.params.consignmentId), ...input, userId: actorId }); return response.json({ success: true, message: "Consignment moved." }); }
  catch (error) { return sendError(response, error); }
}

export async function setParcelDisposition(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    const input = parsedBody(response, reasonSchema.extend({
      parcelNumber: z.string().trim().min(1).max(80),
      disposition: z.enum(["HELD", "DEFERRED_TO_NEXT_MANIFEST", "CANCELLED"])
    }), request.body);
    if (!actorId || !input) return;
    await setOperationsParcelDisposition({
      manifestId: String(request.params.manifestId),
      consignmentId: String(request.params.consignmentId),
      ...input,
      userId: actorId
    });
    return response.json({ success: true, message: "Parcel disposition recorded." });
  } catch (error) { return sendError(response, error); }
}

export async function sealManifest(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    const input = parsedBody(response, z.object({ confirmMixedDestinations: z.boolean().optional().default(false) }), request.body ?? {});
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    if (!input) return;
    await sealOperationsManifest(String(request.params.manifestId), actorId, input);
    return response.json({ success: true, message: "Manifest sealed. Excel and PDF exports are now available." });
  }
  catch (error) { return sendError(response, error); }
}

export async function dispatchManifest(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    const input = parsedBody(response, z.object({
      method: z.enum(["BUTTON", "BARCODE_SCAN"]).optional().default("BUTTON"),
      scannedBarcode: z.string().trim().max(80).optional()
    }).superRefine((data, context) => {
      if (data.method === "BARCODE_SCAN" && !data.scannedBarcode) {
        context.addIssue({ code: "custom", path: ["scannedBarcode"], message: "Scan the manifest dispatch barcode." });
      }
    }), request.body ?? {});
    if (!actorId || !input) return;
    await dispatchOperationsManifest(String(request.params.manifestId), actorId, input);
    return response.json({ success: true, message: "Manifest dispatched and permanently locked." });
  }
  catch (error) { return sendError(response, error); }
}

export async function cancelManifest(request: Request, response: Response) {
  try { const actorId = userId(request); const input = parsedBody(response, reasonSchema, request.body); if (!actorId || !input) return; await cancelOperationsManifest(String(request.params.manifestId), input.reason, actorId); return response.json({ success: true, message: "Manifest cancelled." }); }
  catch (error) { return sendError(response, error); }
}

export async function deleteManifest(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    const input = parsedBody(
      response,
      z.object({ confirmationManifestNumber: z.string().trim().min(1).max(40) }),
      request.body
    );
    if (!actorId || !input) return;
    const deleted = await deleteOperationsManifest({
      manifestId: String(request.params.manifestId),
      confirmationManifestNumber: input.confirmationManifestNumber,
      userId: actorId
    });
    return response.json({
      success: true,
      message: deleted.numberWillBeReused
        ? `${deleted.manifestNumber} deleted. Its number will be used by the next new manifest.`
        : `${deleted.manifestNumber} deleted. Its number remains permanently reserved.`,
      deleted
    });
  } catch (error) { return sendError(response, error); }
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const exportFormats = {
  xlsx: { build: buildOperationsManifestExcel, contentType: XLSX_CONTENT_TYPE, filename: (number: string) => `ops-manifest-${number}.xlsx` },
  pdf: { build: buildOperationsManifestPdf, contentType: "application/pdf", filename: (number: string) => `ops-manifest-${number}.pdf` },
  edi: { build: buildOperationsManifestEdi, contentType: XLSX_CONTENT_TYPE, filename: (number: string) => `edi-${number}.xlsx` },
  uk: { build: buildOperationsManifestUkExcel, contentType: XLSX_CONTENT_TYPE, filename: ukOperationsManifestFilename }
} as const;

async function download(request: Request, response: Response, format: keyof typeof exportFormats) {
  try {
    const manifest = await OperationsManifest.findById(String(request.params.manifestId)).exec();
    if (!manifest) throw new OperationsManifestServiceError("Operations manifest was not found.", 404);
    if (!(manifest.status === "SEALED" || manifest.status === "DISPATCHED")) throw new OperationsManifestServiceError("Exports are available after the manifest is sealed.", 409);
    const spec = exportFormats[format];
    const file = await spec.build(manifest);
    response.setHeader("Content-Type", spec.contentType);
    response.setHeader("Content-Disposition", `${request.query.view === "1" ? "inline" : "attachment"}; filename=\"${spec.filename(manifest.manifestNumber)}\"`);
    return response.send(file);
  } catch (error) { return sendError(response, error); }
}

export const exportExcel = (request: Request, response: Response) => download(request, response, "xlsx");
export const exportPdf = (request: Request, response: Response) => download(request, response, "pdf");
export const exportEdi = (request: Request, response: Response) => download(request, response, "edi");
export const exportUk = (request: Request, response: Response) => download(request, response, "uk");
