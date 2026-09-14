import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentDraft, shipmentKycDocumentTypeValues, type ShipmentKycDocumentType } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { discardStoredObject, kycDocumentLabels, serializeKycDocuments, storeKycDocument } from "./shipmentKyc.controller.js";
import { isSupportedDocument } from "../services/storage/fileSignature.js";
import { streamObjectToResponse } from "../services/storage/storage.service.js";
import { createShipmentInvoicePdf } from "../services/shipmentInvoicePdf.service.js";
import { serializeShipmentInvoice } from "../services/shipmentInvoice.service.js";
import {
  confirmPublicPayment,
  createPublicBookingSession,
  createPublicPaymentOrder,
  getPublicBookingFromRequest,
  PublicShipmentBookingError,
  quotePublicShipment,
  savePublicShipmentDraft,
  serializePublicBooking,
} from "../services/publicShipmentBooking.service.js";
import { publicShipmentDraftPayloadSchema, publicShipmentQuoteAcceptanceSchema } from "../services/publicShipmentBooking.validation.js";
import { getPublicShipmentPolicySummary } from "../services/publicShipmentPolicies.service.js";
import { verifyRecaptcha } from "../services/recaptcha.service.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";

const paymentConfirmationSchema = z.object({
  razorpayOrderId: z.string().trim().min(1).max(100),
  razorpayPaymentId: z.string().trim().min(1).max(100),
  razorpaySignature: z.string().trim().min(1).max(256),
});
const documentTypeSchema = z.enum(shipmentKycDocumentTypeValues);

function sendError(response: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    return response.status(400).json({
      success: false,
      message: "Check the highlighted information and try again.",
      fieldErrors: error.flatten().fieldErrors,
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  if (error instanceof PublicShipmentBookingError) {
    return response.status(error.statusCode).json({ success: false, code: error.code, message: error.message, ...error.details });
  }
  throw error;
}

export async function startPublicShipmentBooking(_request: Request, response: Response) {
  try {
    const { booking } = await createPublicBookingSession(response);
    return response.status(201).json({ success: true, booking: serializePublicBooking(booking) });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function getPublicShipmentBookingStatus(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request, { allowStatusToken: true });
    const draft = booking.shipmentDraftId ? await ShipmentDraft.findById(booking.shipmentDraftId).exec() : null;
    return response.status(200).json({ success: true, booking: serializePublicBooking(booking, draft) });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function savePublicShipmentBookingDraft(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request);
    const data = publicShipmentDraftPayloadSchema.parse(request.body);
    const saved = await savePublicShipmentDraft(booking._id as mongoose.Types.ObjectId, data);
    return response.status(200).json({
      success: true,
      booking: serializePublicBooking(saved.booking, saved.draft),
      validationIssues: saved.draft.validationIssues,
      kycDocuments: serializeKycDocuments(saved.draft.kycDocuments),
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export function getPublicShipmentPolicies(_request: Request, response: Response) {
  return response.status(200).json({ success: true, ...getPublicShipmentPolicySummary() });
}

export async function createPublicShipmentQuote(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request);
    const acceptance = publicShipmentQuoteAcceptanceSchema.parse(request.body);
    // Payment-adjacent public traffic fails closed in production. Login keeps
    // its existing fail-open availability policy through the default option.
    const captchaOk = await verifyRecaptcha(acceptance.recaptchaToken, request.ip, { failOpen: false });
    if (!captchaOk) throw new PublicShipmentBookingError("We could not verify this request. Refresh the page and try again.", 400, "CAPTCHA_FAILED");
    const result = await quotePublicShipment({ bookingId: booking._id as mongoose.Types.ObjectId, request });
    return response.status(200).json({
      success: true,
      booking: serializePublicBooking(result.booking),
      quote: {
        amountMinor: result.booking.quoteAmountMinor,
        currency: "INR",
        expiresAt: result.booking.quoteExpiresAt,
        pricingHash: result.booking.pricingHash,
        parcels: result.pricing.parcels,
        lines: result.pricing.lines,
        totalWeightKg: result.pricing.parcels.reduce((sum, parcel) => sum + parcel.actualWeightKg, 0),
        totalVolumetricWeightKg: result.pricing.parcels.reduce((sum, parcel) => sum + parcel.volumetricWeightKg, 0),
        totalChargeableWeightKg: result.pricing.parcels.reduce((sum, parcel) => sum + parcel.chargeableWeightKg, 0),
      },
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function createPublicShipmentPaymentOrder(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request);
    const result = await createPublicPaymentOrder(booking._id as mongoose.Types.ObjectId);
    return response.status(201).json({
      success: true,
      order: {
        id: result.payment.razorpayOrderId,
        amountMinor: result.payment.amountMinor,
        currency: result.payment.currency,
        keyId: result.keyId,
        bookingReference: result.booking.publicReference,
      },
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function confirmPublicShipmentPayment(request: Request, response: Response) {
  try {
    const { booking, rawToken } = await getPublicBookingFromRequest(request);
    const data = paymentConfirmationSchema.parse(request.body);
    const completed = await confirmPublicPayment({ bookingId: booking._id as mongoose.Types.ObjectId, ...data, rawStatusToken: rawToken });
    if (!completed) throw new PublicShipmentBookingError("Booking could not be loaded after payment.", 500);
    return response.status(200).json({ success: true, booking: serializePublicBooking(completed) });
  } catch (error) {
    return sendError(response, error);
  }
}

function publicDocumentTarget(request: Request) {
  const type = documentTypeSchema.parse(request.params.type);
  const sequenceRaw = typeof request.params.sequence === "string" ? Number(request.params.sequence) : null;
  const sequence = sequenceRaw && Number.isInteger(sequenceRaw) && sequenceRaw > 0 ? sequenceRaw : null;
  return { type, sequence };
}

export async function uploadPublicShipmentKycDocument(request: Request, response: Response) {
  let storedKey = "";
  try {
    const { booking } = await getPublicBookingFromRequest(request);
    if (!["DRAFT", "QUOTED"].includes(booking.state)) throw new PublicShipmentBookingError("Documents cannot be changed after payment begins.", 409);
    if (!booking.shipmentDraftId) throw new PublicShipmentBookingError("Save shipment details before uploading documents.", 409);
    if (!request.file) throw new PublicShipmentBookingError("Select a document to upload.", 400);
    if (!isSupportedDocument(request.file.buffer)) throw new PublicShipmentBookingError("The document is not a valid PDF, JPG, or PNG file.", 400);
    const { type, sequence } = publicDocumentTarget(request);
    const documentLabel = type === "other"
      ? z.string().trim().min(2).max(80).parse(request.body?.documentLabel)
      : kycDocumentLabels[type];
    const draft = await ShipmentDraft.findById(booking.shipmentDraftId).exec();
    if (!draft) throw new PublicShipmentBookingError("Shipment details were not found.", 404);
    const target = sequence ? draft.parcelList[sequence - 1]?.kycDocuments : draft.kycDocuments;
    if (sequence && !target) throw new PublicShipmentBookingError("Save that parcel before uploading its document.", 409);
    const previous = target?.[type];
    const stored = await storeKycDocument({ file: request.file, draftId: String(draft._id), type, documentLabel, userId: new mongoose.Types.ObjectId("000000000000000000000000") });
    storedKey = stored.storageKey;
    if (sequence) draft.set(`parcelList.${sequence - 1}.kycDocuments.${type}`, stored);
    else draft.set(`kycDocuments.${type}`, stored);
    draft.validationIssues = validateShipmentDraftFields(draft);
    draft.status = draft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
    await draft.save();
    storedKey = "";
    await discardStoredObject(previous?.storageKey);
    booking.revision += 1;
    booking.state = "DRAFT";
    booking.quotedRevision = null;
    booking.pricingHash = "";
    booking.quoteAmountMinor = null;
    booking.quoteExpiresAt = null;
    await booking.save();
    return response.status(200).json({ success: true, kycDocuments: serializeKycDocuments(sequence ? draft.parcelList[sequence - 1]?.kycDocuments : draft.kycDocuments), validationIssues: draft.validationIssues });
  } catch (error) {
    await discardStoredObject(storedKey);
    return sendError(response, error);
  }
}

export async function deletePublicShipmentKycDocument(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request);
    if (!["DRAFT", "QUOTED"].includes(booking.state)) throw new PublicShipmentBookingError("Documents cannot be changed after payment begins.", 409);
    if (!booking.shipmentDraftId) throw new PublicShipmentBookingError("Shipment details were not found.", 404);
    const { type, sequence } = publicDocumentTarget(request);
    const draft = await ShipmentDraft.findById(booking.shipmentDraftId).exec();
    if (!draft) throw new PublicShipmentBookingError("Shipment details were not found.", 404);
    const existing = sequence ? draft.parcelList[sequence - 1]?.kycDocuments?.[type] : draft.kycDocuments?.[type];
    if (!existing?.storageKey) throw new PublicShipmentBookingError("Document not found.", 404);
    if (sequence) draft.set(`parcelList.${sequence - 1}.kycDocuments.${type}`, undefined);
    else draft.set(`kycDocuments.${type}`, undefined);
    draft.validationIssues = validateShipmentDraftFields(draft);
    draft.status = draft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
    await draft.save();
    await discardStoredObject(existing.storageKey);
    booking.revision += 1;
    booking.state = "DRAFT";
    booking.quotedRevision = null;
    booking.pricingHash = "";
    booking.quoteAmountMinor = null;
    booking.quoteExpiresAt = null;
    await booking.save();
    return response.status(200).json({ success: true, validationIssues: draft.validationIssues });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function downloadPublicShipmentInvoice(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request, { allowStatusToken: true });
    if (booking.state !== "BOOKED" || !booking.shipmentInvoiceId) throw new PublicShipmentBookingError("Invoice is not available yet.", 409);
    const invoice = await ShipmentInvoice.findById(booking.shipmentInvoiceId).exec();
    if (!invoice) throw new PublicShipmentBookingError("Invoice was not found.", 404);
    const serialized = serializeShipmentInvoice(invoice, invoice.revision);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${invoice.invoiceNumber.replaceAll("/", "-")}-Invoice.pdf"`);
    const document = createShipmentInvoicePdf(serialized);
    document.pipe(response);
    document.end();
    return;
  } catch (error) {
    return sendError(response, error);
  }
}

export async function listPublicShipmentLabels(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request, { allowStatusToken: true });
    if (booking.state !== "BOOKED" || !booking.dpdShipmentId) throw new PublicShipmentBookingError("Labels are not available yet.", 409);
    const token = typeof request.query.token === "string" ? request.query.token : "";
    const labels = await LabelDocument.find({ dpdShipmentId: booking.dpdShipmentId, labelType: "SWIFTLINE", voidedAt: null }).sort({ parcelNumber: 1 }).lean().exec();
    const printableLabels = labels.filter((label, index) => (
      labels.findIndex((candidate) => candidate.storageKey === label.storageKey) === index
    ));
    return response.status(200).json({
      success: true,
      labels: printableLabels.map((label) => ({
        id: String(label._id),
        parcelNumber: label.parcelNumber,
        parcelCount: labels.filter((candidate) => candidate.storageKey === label.storageKey).length,
        format: label.format,
        downloadUrl: `/api/v1/public/shipment-bookings/status/labels/${label._id}${token ? `?token=${encodeURIComponent(token)}` : ""}`
      }))
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function downloadPublicShipmentLabel(request: Request, response: Response) {
  try {
    const { booking } = await getPublicBookingFromRequest(request, { allowStatusToken: true });
    if (booking.state !== "BOOKED" || !booking.dpdShipmentId) throw new PublicShipmentBookingError("Label is not available yet.", 409);
    const labelId = typeof request.params.labelId === "string" ? request.params.labelId : "";
    if (!mongoose.Types.ObjectId.isValid(labelId)) throw new PublicShipmentBookingError("Label not found.", 404);
    const label = await LabelDocument.findOne({ _id: labelId, dpdShipmentId: booking.dpdShipmentId, labelType: "SWIFTLINE", voidedAt: null }).exec();
    if (!label) throw new PublicShipmentBookingError("Label not found.", 404);
    await AuditLog.create({ action: "LABEL_DOWNLOADED", entityType: "LABEL_DOCUMENT", entityId: label._id, performedBy: new mongoose.Types.ObjectId("000000000000000000000000"), performedAt: new Date(), metadata: { publicBookingReference: booking.publicReference } }).catch(() => undefined);
    await LabelDocument.updateOne({ _id: label._id }, { $inc: { downloadCount: 1 }, $set: { lastDownloadedAt: new Date() } }).exec();
    return streamObjectToResponse({
      response,
      key: label.storageKey,
      contentType: "application/pdf",
      filename: `Swiftline-Labels-${booking.swiftlineTrackingNumber}.pdf`,
      disposition: "attachment"
    });
  } catch (error) {
    return sendError(response, error);
  }
}
