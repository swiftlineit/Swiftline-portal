import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import {
  ShipmentDraft,
  shipmentKycDocumentTypeValues,
  type ShipmentKycDocument,
  type ShipmentKycDocumentType
} from "../models/shipmentDraft.model.js";
import {
  assertShipmentDraftMutationAllowed,
  ShipmentDraftPolicyError
} from "../services/shipmentDraftPolicy.service.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";
import { isAadhaarOcrFeatureEnabled } from "../services/aadhaarOcrFeature.service.js";
import { AadhaarPdfInputError, prepareCompleteAadhaarPdf } from "../services/aadhaarPdf.service.js";
import { isSupportedDocument, isSupportedImage, matchesDeclaredType } from "../services/storage/fileSignature.js";
import {
  scanAadhaarWithSurepass,
  getSurepassAadhaarOcrProviderName,
  SurepassAadhaarOcrError,
} from "../services/surepassAadhaarOcr.service.js";
import {
  StorageObjectNotFoundError,
  deleteObject,
  putObject,
  shipmentKycKey,
  streamObjectToResponse
} from "../services/storage/storage.service.js";

const documentTypeSchema = z.enum(shipmentKycDocumentTypeValues);
const documentLabelSchema = z.string().trim().min(2).max(80);

export const kycDocumentLabels: Record<ShipmentKycDocumentType, string> = {
  aadhaar: "Aadhaar Card",
  aadhaarBack: "Aadhaar Back Side",
  pan: "PAN Card",
  iec: "IEC",
  gst: "GST",
  salePurchaseAdCode: "Sale / Purchase / AD Code",
  lut: "LUT",
  declarationOfGoods: "Declaration of Goods",
  otherCertificates: "Other Certificates",
  hsnCode: "HSN Code",
  other: "Other Document"
};

function isSupportedImageMimeType(mimeType: string | undefined) {
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

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

function sendDraftPolicyError(response: Response, error: unknown) {
  return error instanceof ShipmentDraftPolicyError
    ? response.status(error.statusCode).json({ success: false, message: error.message })
    : null;
}

/** Best effort: an orphaned object costs storage, a failed request costs work. */
export async function discardStoredObject(storageKey: string | undefined) {
  if (!storageKey) return;
  await deleteObject(storageKey).catch(() => undefined);
}

/**
 * Stores an uploaded KYC document and returns the subdocument to persist.
 *
 * Grouped under the draft so that a shipment's KYC, labels, and invoice all sit
 * beneath one prefix- which is what lets account deletion and retention work on
 * a prefix rather than an enumerated file list.
 */
export async function storeKycDocument(input: {
  file: Express.Multer.File;
  draftId: string;
  type: ShipmentKycDocumentType;
  documentLabel: string;
  userId: mongoose.Types.ObjectId;
}): Promise<ShipmentKycDocument & { uploadedBy: mongoose.Types.ObjectId }> {
  const storageKey = shipmentKycKey(input.draftId, input.file.originalname);
  await putObject({
    key: storageKey,
    body: input.file.buffer,
    contentType: input.file.mimetype,
    originalName: input.file.originalname
  });

  return {
    type: input.type,
    documentLabel: input.documentLabel,
    originalName: input.file.originalname,
    storageKey,
    mimeType: input.file.mimetype,
    size: input.file.size,
    uploadedAt: new Date(),
    uploadedBy: input.userId
  };
}

/**
 * Streams a KYC document to an already-authorised response.
 *
 * Streamed rather than handed out as a signed URL: these carry Aadhaar, PAN, and
 * IEC numbers, and a signed URL stays readable by whoever holds it for its whole
 * lifetime, wherever it is forwarded.
 */
async function streamKycDocument(response: Response, document: ShipmentKycDocument) {
  try {
    return await streamObjectToResponse({
      response,
      key: document.storageKey,
      contentType: document.mimeType,
      filename: document.originalName,
      disposition: "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "Document file is no longer available" });
    }
    throw error;
  }
}

/** Public shape of a stored document: metadata only, never the storage key. */
export function serializeKycDocument(document: ShipmentKycDocument | undefined | null) {
  if (!document?.storageKey) return null;

  return {
    type: document.type,
    documentLabel: document.documentLabel || kycDocumentLabels[document.type],
    originalName: document.originalName,
    mimeType: document.mimeType,
    size: document.size,
    uploadedAt: document.uploadedAt
  };
}

export function serializeKycDocuments(
  documents: Partial<Record<ShipmentKycDocumentType, ShipmentKycDocument>> | undefined
) {
  const source = documents ?? {};

  return {
    aadhaar: serializeKycDocument(source.aadhaar),
    aadhaarBack: serializeKycDocument(source.aadhaarBack),
    pan: serializeKycDocument(source.pan),
    iec: serializeKycDocument(source.iec),
    gst: serializeKycDocument(source.gst),
    salePurchaseAdCode: serializeKycDocument(source.salePurchaseAdCode),
    lut: serializeKycDocument(source.lut),
    declarationOfGoods: serializeKycDocument(source.declarationOfGoods),
    otherCertificates: serializeKycDocument(source.otherCertificates),
    hsnCode: serializeKycDocument(source.hsnCode),
    other: serializeKycDocument(source.other)
  };
}

/** Reads Aadhaar sides for an explicit, consented consignor prefill request. */
export async function ocrShipmentDraftAadhaar(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (request.body?.consent !== "true") {
    return response.status(400).json({ success: false, message: "Confirm the Aadhaar holder's consent before scanning." });
  }
  const kycScope = request.body?.kycScope;
  if (kycScope !== "shared" && kycScope !== "parcel") {
    return response.status(400).json({ success: false, message: "Choose whether this Aadhaar applies to all parcels or one parcel." });
  }
  const rawParcelSequence = typeof request.body?.parcelSequence === "string"
    ? Number(request.body.parcelSequence)
    : NaN;
  const parcelSequence = Number.isInteger(rawParcelSequence) && rawParcelSequence >= 1
    ? rawParcelSequence
    : null;
  if (kycScope === "parcel" && parcelSequence === null) {
    return response.status(400).json({ success: false, message: "Choose a saved parcel for this Aadhaar document." });
  }

  const files = request.files as Record<string, Express.Multer.File[] | undefined> | undefined;
  const front = files?.front?.[0];
  const back = files?.back?.[0];
  const completePdf = files?.pdf?.[0];
  if (completePdf ? Boolean(front || back) : !front || !back) {
    return response.status(400).json({ success: false, message: "Upload a complete one- or two-page PDF, or both Aadhaar sides." });
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  try {
    await assertShipmentDraftMutationAllowed({
      draft: shipmentDraft,
      userId,
      portalRole: getAuthenticatedPortalRole(request),
    });
  } catch (error) {
    const policyResponse = sendDraftPolicyError(response, error);
    if (policyResponse) return policyResponse;
    throw error;
  }
  if ((kycScope === "shared") !== (shipmentDraft.kycUseForAllParcels !== false)) {
    return response.status(409).json({ success: false, message: "The KYC sharing setting changed. Refresh the form and scan again." });
  }
  const initialParcelIndex = kycScope === "parcel"
    ? shipmentDraft.parcelList.findIndex((parcel) => parcel.sequence === parcelSequence)
    : -1;
  if (kycScope === "parcel" && initialParcelIndex < 0) {
    return response.status(409).json({ success: false, message: "Save the selected parcel before uploading its Aadhaar document." });
  }

  const isPdf = completePdf ? true : front!.mimetype === "application/pdf";
  const backIsPdf = back?.mimetype === "application/pdf";
  if (!completePdf && isPdf !== backIsPdf) {
    return response.status(400).json({ success: false, message: "Upload both sides as PDFs or both sides as images." });
  }
  for (const file of completePdf ? [completePdf] : [front!, back!]) {
    if (!isSupportedDocument(file.buffer) || !matchesDeclaredType(file.buffer, file.mimetype)) {
      return response.status(400).json({ success: false, message: "The Aadhaar file does not match its file type." });
    }
  }

  try {
    if (!await isAadhaarOcrFeatureEnabled()) {
      return response.status(403).json({ success: false, message: "Aadhaar OCR is currently disabled." });
    }
    const splitPdf = completePdf ? await prepareCompleteAadhaarPdf(completePdf.buffer) : null;
    const prefill = await scanAadhaarWithSurepass({
      front: splitPdf?.front ?? front!,
      back: splitPdf?.back ?? back!,
      arePdfs: isPdf,
    });
    const currentDraft = await ShipmentDraft.findById(draftId).exec();
    if (!currentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

    try {
      await assertShipmentDraftMutationAllowed({
        draft: currentDraft,
        userId,
        portalRole: getAuthenticatedPortalRole(request),
      });
    } catch (error) {
      const policyResponse = sendDraftPolicyError(response, error);
      if (policyResponse) return policyResponse;
      throw error;
    }
    if ((kycScope === "shared") !== (currentDraft.kycUseForAllParcels !== false)) {
      return response.status(409).json({ success: false, message: "The KYC sharing setting changed while Aadhaar was being scanned. Scan again." });
    }
    const parcelIndex = kycScope === "parcel"
      ? currentDraft.parcelList.findIndex((parcel) => parcel.sequence === parcelSequence)
      : -1;
    if (kycScope === "parcel" && parcelIndex < 0) {
      return response.status(409).json({ success: false, message: "Save the selected parcel before uploading its Aadhaar document." });
    }

    const targetPath = kycScope === "shared" ? "kycDocuments" : `parcelList.${parcelIndex}.kycDocuments`;
    const previousKycDocuments = kycScope === "shared"
      ? currentDraft.kycDocuments
      : currentDraft.parcelList[parcelIndex]?.kycDocuments;
    const previousFront = previousKycDocuments?.aadhaar;
    const previousBack = previousKycDocuments?.aadhaarBack;
    const storedDocuments: Array<ShipmentKycDocument & { uploadedBy: mongoose.Types.ObjectId }> = [];

    try {
      const storedFront = await storeKycDocument({
        file: completePdf ?? front!,
        draftId,
        type: "aadhaar",
        documentLabel: kycDocumentLabels.aadhaar,
        userId,
      });
      storedDocuments.push(storedFront);
      currentDraft.set(`${targetPath}.aadhaar`, storedFront);
      if (completePdf) {
        currentDraft.set(`${targetPath}.aadhaarBack`, undefined);
      } else {
        const storedBack = await storeKycDocument({
          file: back!,
          draftId,
          type: "aadhaarBack",
          documentLabel: kycDocumentLabels.aadhaarBack,
          userId,
        });
        storedDocuments.push(storedBack);
        currentDraft.set(`${targetPath}.aadhaarBack`, storedBack);
      }
      currentDraft.validationIssues = validateShipmentDraftFields(currentDraft);
      currentDraft.status = currentDraft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
      await currentDraft.save();
    } catch (error) {
      await Promise.all(storedDocuments.map((document) => discardStoredObject(document.storageKey)));
      throw error;
    }

    await Promise.all([
      discardStoredObject(previousFront?.storageKey),
      discardStoredObject(previousBack?.storageKey),
    ]);

    const savedKycDocuments = kycScope === "shared"
      ? currentDraft.kycDocuments
      : currentDraft.parcelList[parcelIndex]?.kycDocuments;
    await AuditLog.create({
      action: "SHIPMENT_AADHAAR_OCR_PROCESSED",
      entityType: "SHIPMENT_DRAFT",
      entityId: currentDraft._id,
      performedBy: userId,
      performedAt: new Date(),
      metadata: {
        provider: getSurepassAadhaarOcrProviderName(),
        portalRole: getAuthenticatedPortalRole(request),
        consentConfirmed: true,
        inputMode: completePdf ? "complete_pdf" : "front_back",
        fileTypes: completePdf ? [completePdf.mimetype] : [front!.mimetype, back!.mimetype],
        kycScope,
        parcelSequence: kycScope === "parcel" ? parcelSequence : undefined,
        storedDocumentTypes: completePdf ? ["aadhaar"] : ["aadhaar", "aadhaarBack"],
      },
    });
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({
      success: true,
      prefill,
      kycDocuments: serializeKycDocuments(savedKycDocuments),
      parcelSequence: kycScope === "parcel" ? parcelSequence : undefined,
    });
  } catch (error) {
    if (error instanceof AadhaarPdfInputError) {
      return response.status(400).json({ success: false, message: error.message });
    }
    if (error instanceof SurepassAadhaarOcrError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

function parseParcelSequence(request: Request): number | null {
  const raw = typeof request.params.sequence === "string" ? Number(request.params.sequence) : NaN;
  return Number.isInteger(raw) && raw >= 1 ? raw : null;
}

export async function uploadShipmentParcelKycDocument(request: Request, response: Response): Promise<Response> {
  // Uploads are buffered in memory and written to storage only once every check
  // below has passed, so each rejection simply returns.
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsedType = documentTypeSchema.safeParse(request.params.type);
  const sequence = parseParcelSequence(request);
  if (!parsedType.success || sequence === null) {
    return response.status(400).json({ success: false, message: "Unknown parcel KYC document." });
  }

  if (!request.file) {
    return response.status(400).json({ success: false, message: "Select a document to upload." });
  }

  if (parsedType.data === "aadhaarBack" && !isSupportedImageMimeType(request.file.mimetype)) {
    return response.status(400).json({ success: false, message: "The Aadhaar back side must be uploaded as a JPG or PNG image." });
  }

  if (!isSupportedDocument(request.file.buffer)) {
    return response.status(400).json({ success: false, message: "The document is not a valid PDF, JPG, or PNG file." });
  }

  if (parsedType.data === "aadhaarBack" && !isSupportedImage(request.file.buffer)) {
    return response.status(400).json({ success: false, message: "The Aadhaar back side must be a valid JPG or PNG image." });
  }

  let documentLabel = kycDocumentLabels[parsedType.data];
  if (parsedType.data === "other") {
    const parsedLabel = documentLabelSchema.safeParse(request.body?.documentLabel);
    if (!parsedLabel.success) {
      return response.status(400).json({ success: false, message: "Type what the other document is before uploading it." });
    }
    documentLabel = parsedLabel.data;
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const parcelIndex = sequence - 1;
  if (parcelIndex >= shipmentDraft.parcelList.length) {
    return response.status(409).json({ success: false, message: "Save the shipment parcels before uploading their KYC." });
  }

  try {
    await assertShipmentDraftMutationAllowed({ draft: shipmentDraft, userId, portalRole: getAuthenticatedPortalRole(request) });
  } catch (error) {
    const policyResponse = sendDraftPolicyError(response, error);
    if (policyResponse) return policyResponse;
    throw error;
  }

  if (parsedType.data === "aadhaarBack") {
    const front = shipmentDraft.parcelList[parcelIndex]?.kycDocuments?.aadhaar;
    if (shipmentDraft.csbType !== "CSB_IV" || !isSupportedImageMimeType(front?.mimeType)) {
      return response.status(400).json({ success: false, message: "Upload an Aadhaar front-side image before adding the back side. This option is available for CSB-IV only." });
    }
  }

  const previousDocument = shipmentDraft.parcelList[parcelIndex]?.kycDocuments?.[parsedType.data];
  const previousAadhaarBack = parsedType.data === "aadhaar"
    ? shipmentDraft.parcelList[parcelIndex]?.kycDocuments?.aadhaarBack
    : undefined;

  const stored = await storeKycDocument({
    file: request.file,
    draftId,
    type: parsedType.data,
    documentLabel,
    userId
  });

  shipmentDraft.set(`parcelList.${parcelIndex}.kycDocuments.${parsedType.data}`, stored);
  if (parsedType.data === "aadhaar") {
    // A newly selected front must be paired with a back image from the same card.
    shipmentDraft.set(`parcelList.${parcelIndex}.kycDocuments.aadhaarBack`, undefined);
  }
  shipmentDraft.validationIssues = validateShipmentDraftFields(shipmentDraft);
  shipmentDraft.status = shipmentDraft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
  try {
    await shipmentDraft.save();
  } catch (error) {
    // The save failed, so the object just written is unreferenced. Remove it and
    // leave whatever was there before untouched.
    await discardStoredObject(stored.storageKey);
    throw error;
  }
  // Only drop the replaced object once the new one is committed.
  await discardStoredObject(previousDocument?.storageKey);
  await discardStoredObject(previousAadhaarBack?.storageKey);

  await AuditLog.create({
    action: "SHIPMENT_KYC_DOCUMENT_UPLOADED",
    entityType: "SHIPMENT_DRAFT",
    entityId: shipmentDraft._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      parcelSequence: sequence,
      documentType: parsedType.data,
      documentLabel,
      originalName: request.file.originalname,
      size: request.file.size,
      removedPairedAadhaarBack: Boolean(previousAadhaarBack?.storageKey)
    }
  });

  return response.status(200).json({
    success: true,
    parcelSequence: sequence,
    kycDocuments: serializeKycDocuments(shipmentDraft.parcelList[parcelIndex]?.kycDocuments),
    validationIssues: shipmentDraft.validationIssues
  });
}

export async function deleteShipmentParcelKycDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsedType = documentTypeSchema.safeParse(request.params.type);
  const sequence = parseParcelSequence(request);
  if (!parsedType.success || sequence === null) {
    return response.status(400).json({ success: false, message: "Unknown parcel KYC document." });
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const parcelIndex = sequence - 1;
  const existing = shipmentDraft.parcelList[parcelIndex]?.kycDocuments?.[parsedType.data];
  if (!existing?.storageKey) return response.status(404).json({ success: false, message: "Document not found" });
  const pairedAadhaarBack = parsedType.data === "aadhaar"
    ? shipmentDraft.parcelList[parcelIndex]?.kycDocuments?.aadhaarBack
    : undefined;

  try {
    await assertShipmentDraftMutationAllowed({ draft: shipmentDraft, userId, portalRole: getAuthenticatedPortalRole(request) });
  } catch (error) {
    const policyResponse = sendDraftPolicyError(response, error);
    if (policyResponse) return policyResponse;
    throw error;
  }

  shipmentDraft.set(`parcelList.${parcelIndex}.kycDocuments.${parsedType.data}`, undefined);
  if (parsedType.data === "aadhaar") {
    shipmentDraft.set(`parcelList.${parcelIndex}.kycDocuments.aadhaarBack`, undefined);
  }
  shipmentDraft.validationIssues = validateShipmentDraftFields(shipmentDraft);
  shipmentDraft.status = shipmentDraft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
  await shipmentDraft.save();
  await discardStoredObject(existing.storageKey);
  await discardStoredObject(pairedAadhaarBack?.storageKey);

  await AuditLog.create({
    action: "SHIPMENT_KYC_DOCUMENT_REMOVED",
    entityType: "SHIPMENT_DRAFT",
    entityId: shipmentDraft._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      parcelSequence: sequence,
      documentType: parsedType.data,
      originalName: existing.originalName,
      removedPairedAadhaarBack: Boolean(pairedAadhaarBack?.storageKey)
    }
  });

  return response.status(200).json({
    success: true,
    parcelSequence: sequence,
    kycDocuments: serializeKycDocuments(shipmentDraft.parcelList[parcelIndex]?.kycDocuments),
    validationIssues: shipmentDraft.validationIssues
  });
}

export async function downloadShipmentParcelKycDocument(request: Request, response: Response): Promise<Response | void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsedType = documentTypeSchema.safeParse(request.params.type);
  const sequence = parseParcelSequence(request);
  if (!parsedType.success || sequence === null) {
    return response.status(400).json({ success: false, message: "Unknown parcel KYC document." });
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).lean().exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const document = shipmentDraft.parcelList[sequence - 1]?.kycDocuments?.[parsedType.data];
  if (!document?.storageKey) return response.status(404).json({ success: false, message: "Document not found" });

  return streamKycDocument(response, document);
}

export async function uploadShipmentKycDocument(request: Request, response: Response): Promise<Response> {
  // As above: nothing is stored until every check has passed.
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsedType = documentTypeSchema.safeParse(request.params.type);
  if (!parsedType.success) {
    return response.status(400).json({ success: false, message: "Unknown KYC document type." });
  }

  if (!request.file) {
    return response.status(400).json({ success: false, message: "Select a document to upload." });
  }

  if (parsedType.data === "aadhaarBack" && !isSupportedImageMimeType(request.file.mimetype)) {
    return response.status(400).json({ success: false, message: "The Aadhaar back side must be uploaded as a JPG or PNG image." });
  }

  if (!isSupportedDocument(request.file.buffer)) {
    return response.status(400).json({ success: false, message: "The document is not a valid PDF, JPG, or PNG file." });
  }

  if (parsedType.data === "aadhaarBack" && !isSupportedImage(request.file.buffer)) {
    return response.status(400).json({ success: false, message: "The Aadhaar back side must be a valid JPG or PNG image." });
  }

  // "Other" documents are meaningless to a reviewer without a name, so the
  // label is captured with the file rather than after the fact.
  let documentLabel = kycDocumentLabels[parsedType.data];
  if (parsedType.data === "other") {
    const parsedLabel = documentLabelSchema.safeParse(request.body?.documentLabel);
    if (!parsedLabel.success) {
      return response.status(400).json({
        success: false,
        message: "Type what the other document is before uploading it."
      });
    }
    documentLabel = parsedLabel.data;
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
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

  if (parsedType.data === "aadhaarBack") {
    const front = shipmentDraft.kycDocuments?.aadhaar;
    if (shipmentDraft.csbType !== "CSB_IV" || !isSupportedImageMimeType(front?.mimeType)) {
      return response.status(400).json({ success: false, message: "Upload an Aadhaar front-side image before adding the back side. This option is available for CSB-IV only." });
    }
  }

  const previousDocument = shipmentDraft.kycDocuments?.[parsedType.data];
  const previousAadhaarBack = parsedType.data === "aadhaar"
    ? shipmentDraft.kycDocuments?.aadhaarBack
    : undefined;

  const stored = await storeKycDocument({
    file: request.file,
    draftId,
    type: parsedType.data,
    documentLabel,
    userId
  });

  shipmentDraft.set(`kycDocuments.${parsedType.data}`, stored);
  if (parsedType.data === "aadhaar") {
    // A newly selected front must be paired with a back image from the same card.
    shipmentDraft.set("kycDocuments.aadhaarBack", undefined);
  }
  shipmentDraft.validationIssues = validateShipmentDraftFields(shipmentDraft);
  shipmentDraft.status = shipmentDraft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
  try {
    await shipmentDraft.save();
  } catch (error) {
    await discardStoredObject(stored.storageKey);
    throw error;
  }

  // Only drop the replaced object once the new one is committed.
  await discardStoredObject(previousDocument?.storageKey);
  await discardStoredObject(previousAadhaarBack?.storageKey);

  await AuditLog.create({
    action: "SHIPMENT_KYC_DOCUMENT_UPLOADED",
    entityType: "SHIPMENT_DRAFT",
    entityId: shipmentDraft._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      documentType: parsedType.data,
      documentLabel,
      originalName: request.file.originalname,
      size: request.file.size,
      replacedExisting: Boolean(previousDocument?.storageKey),
      removedPairedAadhaarBack: Boolean(previousAadhaarBack?.storageKey)
    }
  });

  return response.status(200).json({
    success: true,
    kycDocuments: serializeKycDocuments(shipmentDraft.kycDocuments),
    validationIssues: shipmentDraft.validationIssues
  });
}

export async function deleteShipmentKycDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsedType = documentTypeSchema.safeParse(request.params.type);
  if (!parsedType.success) {
    return response.status(400).json({ success: false, message: "Unknown KYC document type." });
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
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

  const existing = shipmentDraft.kycDocuments?.[parsedType.data];
  if (!existing?.storageKey) {
    return response.status(404).json({ success: false, message: "Document not found" });
  }
  const pairedAadhaarBack = parsedType.data === "aadhaar"
    ? shipmentDraft.kycDocuments?.aadhaarBack
    : undefined;

  shipmentDraft.set(`kycDocuments.${parsedType.data}`, undefined);
  if (parsedType.data === "aadhaar") {
    shipmentDraft.set("kycDocuments.aadhaarBack", undefined);
  }
  shipmentDraft.validationIssues = validateShipmentDraftFields(shipmentDraft);
  shipmentDraft.status = shipmentDraft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
  await shipmentDraft.save();
  await discardStoredObject(existing.storageKey);
  await discardStoredObject(pairedAadhaarBack?.storageKey);

  await AuditLog.create({
    action: "SHIPMENT_KYC_DOCUMENT_REMOVED",
    entityType: "SHIPMENT_DRAFT",
    entityId: shipmentDraft._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {
      documentType: parsedType.data,
      originalName: existing.originalName,
      removedPairedAadhaarBack: Boolean(pairedAadhaarBack?.storageKey)
    }
  });

  return response.status(200).json({
    success: true,
    kycDocuments: serializeKycDocuments(shipmentDraft.kycDocuments),
    validationIssues: shipmentDraft.validationIssues
  });
}

export async function downloadShipmentKycDocument(request: Request, response: Response): Promise<Response | void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsedType = documentTypeSchema.safeParse(request.params.type);
  if (!parsedType.success) {
    return response.status(400).json({ success: false, message: "Unknown KYC document type." });
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  const shipmentDraft = await ShipmentDraft.findById(draftId).lean().exec();
  if (!shipmentDraft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  const document = shipmentDraft.kycDocuments?.[parsedType.data];
  if (!document?.storageKey) return response.status(404).json({ success: false, message: "Document not found" });

  return streamKycDocument(response, document);
}
