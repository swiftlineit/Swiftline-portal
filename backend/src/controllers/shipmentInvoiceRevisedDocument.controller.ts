import type { Request, Response } from "express";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceRevisedDocument } from "../models/shipmentInvoiceRevisedDocument.model.js";
import { serializeShipmentInvoice, ShipmentInvoiceServiceError } from "../services/shipmentInvoice.service.js";
import { createShipmentInvoicePdf } from "../services/shipmentInvoicePdf.service.js";

function getAuthenticatedUserId(request: Request) {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  return user?._id && mongoose.Types.ObjectId.isValid(String(user._id))
    ? new mongoose.Types.ObjectId(String(user._id))
    : null;
}

function getDraftId(request: Request) {
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  return mongoose.Types.ObjectId.isValid(draftId) ? new mongoose.Types.ObjectId(draftId) : null;
}

function getCopyId(request: Request) {
  const copyId = typeof request.params.copyId === "string" ? request.params.copyId : "";
  return mongoose.Types.ObjectId.isValid(copyId) ? new mongoose.Types.ObjectId(copyId) : null;
}

function serializeRevisedDocument(document: InstanceType<typeof ShipmentInvoiceRevisedDocument>) {
  return {
    id: String(document._id),
    shipmentDraftId: String(document.shipmentDraftId),
    invoiceNumber: document.invoiceNumber,
    basedOnRevision: document.basedOnRevision,
    document: document.document,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown) {
  const parsed = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const MAX_EDITABLE_MONEY_MINOR = 99_999_999_999;
const MAX_EDITABLE_PARCELS = 100;
const MAX_EDITABLE_LINES = 100;

function text(value: unknown, label: string, maxLength: number, required = false) {
  if (typeof value !== "string") {
    if (required) throw new ShipmentInvoiceServiceError(`${label} is required.`, 400);
    return "";
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new ShipmentInvoiceServiceError(`${label} is required.`, 400);
  if (trimmed.length > maxLength) throw new ShipmentInvoiceServiceError(`${label} is too long.`, 400);
  return trimmed;
}

function moneyMinor(value: unknown, label: string) {
  const parsed = finiteNumber(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_EDITABLE_MONEY_MINOR) {
    throw new ShipmentInvoiceServiceError(`${label} must be a whole number of paise within the supported range.`, 400);
  }
  return parsed;
}

function decimal(value: unknown, label: string): number;
function decimal(value: unknown, label: string, nullable: true): number | null;
function decimal(value: unknown, label: string, nullable = false): number | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 0 || parsed > 10_000_000) {
    throw new ShipmentInvoiceServiceError(`${label} must be a non-negative number within the supported range.`, 400);
  }
  return parsed;
}

function textRecord(value: unknown, fallback: Record<string, unknown>, label: string) {
  if (value === undefined) return { ...fallback };
  const input = asRecord(value);
  if (!Object.keys(input).length && value !== null) return { ...fallback };
  const entries = Object.entries(input);
  if (entries.length > 40) throw new ShipmentInvoiceServiceError(`${label} contains too many fields.`, 400);

  const result = { ...fallback };
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new ShipmentInvoiceServiceError(`${label} contains an invalid field.`, 400);
    }
    result[key] = text(entry, `${label} ${key}`, 2_000);
  }
  return result;
}

function cloneDocument(document: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

function normalizeParcels(value: unknown, fallback: unknown) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source) || source.length > MAX_EDITABLE_PARCELS) {
    throw new ShipmentInvoiceServiceError(`A revised copy can contain at most ${MAX_EDITABLE_PARCELS} boxes.`, 400);
  }

  const sequences = new Set<number>();
  return source.map((entry, index) => {
    const parcel = asRecord(entry);
    const sequence = decimal(parcel.sequence, `Box ${index + 1} sequence`);
    if (!Number.isInteger(sequence) || sequence < 1 || sequences.has(sequence)) {
      throw new ShipmentInvoiceServiceError("Every box must have a unique positive sequence.", 400);
    }
    sequences.add(sequence);

    const rawItems = parcel.items === undefined ? [] : parcel.items;
    if (!Array.isArray(rawItems) || rawItems.length > 100) {
      throw new ShipmentInvoiceServiceError(`Box ${sequence} contains too many items.`, 400);
    }
    const items = rawItems.map((rawItem, itemIndex) => {
      const item = asRecord(rawItem);
      return {
        description: text(item.description, `Box ${sequence} item ${itemIndex + 1} description`, 1_000),
        hsnCode: text(item.hsnCode, `Box ${sequence} item ${itemIndex + 1} HSN code`, 64),
        unitType: text(item.unitType, `Box ${sequence} item ${itemIndex + 1} unit type`, 64),
        quantity: decimal(item.quantity, `Box ${sequence} item ${itemIndex + 1} quantity`, true),
        unitRate: decimal(item.unitRate, `Box ${sequence} item ${itemIndex + 1} unit rate`, true)
      };
    });

    return {
      sequence,
      actualWeightKg: decimal(parcel.actualWeightKg, `Box ${sequence} actual weight`),
      volumetricWeightKg: decimal(parcel.volumetricWeightKg, `Box ${sequence} volumetric weight`),
      chargeableWeightKg: decimal(parcel.chargeableWeightKg, `Box ${sequence} chargeable weight`),
      chargesPerKg: decimal(parcel.chargesPerKg, `Box ${sequence} rate per kg`, true),
      baseAmount: decimal(parcel.baseAmount, `Box ${sequence} amount`),
      lengthCm: decimal(parcel.lengthCm, `Box ${sequence} length`, true),
      widthCm: decimal(parcel.widthCm, `Box ${sequence} width`, true),
      heightCm: decimal(parcel.heightCm, `Box ${sequence} height`, true),
      contentsDescription: text(parcel.contentsDescription, `Box ${sequence} description`, 2_000),
      items
    };
  });
}

function normalizePricingSnapshot(value: unknown, fallback: unknown) {
  const base = asRecord(fallback);
  const baseLines = Array.isArray(base.lines) ? base.lines : [];
  // FREIGHT and GST are system rows. They are rendered in the invoice totals,
  // not as editable charge rows, and GST legitimately has kind TAX. Preserve
  // the real invoice's copies and ignore the hidden rows echoed by the editor.
  const lockedLines = baseLines.filter((candidate) => {
    const line = asRecord(candidate);
    return line.code === "FREIGHT" || line.code === "GST";
  });
  if (value === undefined) return { ...base };
  const input = asRecord(value);
  const rawLines = input.lines;
  if (rawLines === undefined) return { ...base };
  if (!Array.isArray(rawLines) || rawLines.length > MAX_EDITABLE_LINES) {
    throw new ShipmentInvoiceServiceError(`A revised copy can contain at most ${MAX_EDITABLE_LINES} charge rows.`, 400);
  }

  const editableLines = rawLines.filter((rawLine) => {
    const line = asRecord(rawLine);
    return line.code !== "FREIGHT" && line.code !== "GST";
  });

  return {
    ...base,
    lines: [...lockedLines, ...editableLines.map((rawLine, index) => {
      const line = asRecord(rawLine);
      const sourceCode = text(line.code, `Charge row ${index + 1} code`, 64);
      const kind = line.kind === "DEDUCTION" ? "DEDUCTION" : line.kind === "CHARGE" ? "CHARGE" : null;
      if (!kind) throw new ShipmentInvoiceServiceError(`Charge row ${index + 1} type must be a charge or deduction.`, 400);
      const amountMinor = moneyMinor(line.amountMinor, `Charge row ${index + 1} amount`);
      return {
        code: sourceCode === "FREIGHT" || sourceCode === "GST" ? sourceCode : `REVISED_LINE_${index + 1}`,
        label: text(line.label, `Charge row ${index + 1} label`, 500, true),
        kind,
        amount: amountMinor / 100,
        amountMinor,
        basis: "Edited on the revised document copy"
      };
    })]
  };
}

function deriveTaxAmounts(taxableValueMinor: number, gstRatePercent: number, taxType: "CGST_SGST" | "IGST") {
  const totalTaxAmountMinor = Math.round((taxableValueMinor * gstRatePercent) / 100);
  if (taxType === "CGST_SGST") {
    const cgstAmountMinor = Math.floor(totalTaxAmountMinor / 2);
    return {
      cgstAmountMinor,
      sgstAmountMinor: totalTaxAmountMinor - cgstAmountMinor,
      igstAmountMinor: 0,
      totalTaxAmountMinor,
      totalAmountMinor: taxableValueMinor + totalTaxAmountMinor
    };
  }
  return {
    cgstAmountMinor: 0,
    sgstAmountMinor: 0,
    igstAmountMinor: totalTaxAmountMinor,
    totalTaxAmountMinor,
    totalAmountMinor: taxableValueMinor + totalTaxAmountMinor
  };
}

/**
 * Validates an edited invoice document and locks the fields that must always
 * match the real invoice. The tracking reference is forced back to the real
 * value even if the editor payload carries something else, so a revised copy
 * can never point at a different shipment.
 */
function buildStoredDocument(input: unknown, realInvoice: InstanceType<typeof ShipmentInvoice>) {
  const document = asRecord(input);
  if (!Object.keys(document).length) throw new ShipmentInvoiceServiceError("The revised document is empty.", 400);

  const base = serializeShipmentInvoice(realInvoice);
  const invoiceNumber = text(document.invoiceNumber, "Invoice number", 32, true);
  const taxableValueMinor = moneyMinor(document.taxableValueMinor, "Taxable value");
  const gstRatePercent = decimal(document.gstRatePercent, "GST rate");
  if (gstRatePercent < 0 || gstRatePercent > 100) {
    throw new ShipmentInvoiceServiceError("GST rate must be between zero and 100 percent.", 400);
  }
  if (document.taxType !== "CGST_SGST" && document.taxType !== "IGST") {
    throw new ShipmentInvoiceServiceError("Tax type must be CGST_SGST or IGST.", 400);
  }

  const baseShipment = asRecord(base.shipment);
  const inputShipment = asRecord(document.shipment);
  const { parcels: inputParcels, parcelCount: _ignoredParcelCount, shipmentReference: _ignoredReference, ...shipmentFields } = inputShipment;
  const parcels = normalizeParcels(inputParcels, baseShipment.parcels);
  const pricingSnapshot = normalizePricingSnapshot(document.pricingSnapshot, base.pricingSnapshot);
  const lines = Array.isArray(pricingSnapshot.lines) ? pricingSnapshot.lines : [];
  const rowTotalMinor = parcels.reduce((sum, parcel) => sum + Math.round(parcel.baseAmount * 100), 0)
    + lines.reduce((sum, line) => {
      if (line.code === "FREIGHT" || line.code === "GST") return sum;
      return sum + (line.kind === "DEDUCTION" ? -line.amountMinor : line.amountMinor);
    }, 0);
  if (taxableValueMinor !== rowTotalMinor) {
    throw new ShipmentInvoiceServiceError("Taxable value must match the boxes and charge rows. Use Recalculate taxable from rows before saving.", 400);
  }

  const issuedAt = document.issuedAt === undefined ? new Date(base.issuedAt) : new Date(String(document.issuedAt));
  if (Number.isNaN(issuedAt.getTime())) throw new ShipmentInvoiceServiceError("Invoice date is invalid.", 400);
  const taxType = document.taxType;
  const calculated = deriveTaxAmounts(taxableValueMinor, gstRatePercent, taxType);
  const currency = text(document.currency, "Currency", 3, true).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ShipmentInvoiceServiceError("Currency must be a three-letter ISO code.", 400);

  return {
    ...base,
    invoiceNumber,
    currency,
    supplier: textRecord(document.supplier, asRecord(base.supplier), "Supplier"),
    customer: textRecord(document.customer, asRecord(base.customer), "Customer"),
    shipment: {
      ...baseShipment,
      ...textRecord(shipmentFields, {}, "Shipment"),
      shipmentReference: baseShipment.shipmentReference ?? "",
      parcels,
      parcelCount: parcels.length
    },
    sacCode: text(document.sacCode, "SAC code", 64),
    description: text(document.description, "Description", 2_000),
    taxableValueMinor,
    gstRatePercent,
    taxTreatment: gstRatePercent === 0 ? "NO_GST" : "GST_APPLICABLE",
    taxType,
    ...calculated,
    pricingSnapshot,
    issuedAt: issuedAt.toISOString(),
    // Financial, identity and workflow state is always copied from the real
    // invoice; a revised document may never impersonate another shipment or
    // alter billing, payment, approval or validation state.
    status: base.status,
    validationWarnings: base.validationWarnings,
    paymentStatus: base.paymentStatus,
    reverseCharge: base.reverseCharge,
    advanceAppliedMinor: base.advanceAppliedMinor,
    creditOutstandingMinor: base.creditOutstandingMinor,
    financialYear: base.financialYear,
    shipmentDraftId: base.shipmentDraftId,
    dpdShipmentId: base.dpdShipmentId,
    businessAccountId: base.businessAccountId,
    branchId: base.branchId,
    revision: base.revision,
    revisedAt: base.revisedAt,
    isLatest: base.isLatest,
    versions: base.versions
  };
}

function changeReason(value: unknown) {
  return text(value, "Change reason", 500, true).replace(/\s+/g, " ");
}

async function requireRealInvoice(shipmentDraftId: mongoose.Types.ObjectId) {
  const invoice = await ShipmentInvoice.findOne({ shipmentDraftId }).exec();
  if (!invoice) {
    throw new ShipmentInvoiceServiceError("A revised copy needs the real tax invoice, which is issued after the shipment is booked.", 409);
  }
  return invoice;
}

function sendRevisedError(response: Response, error: unknown) {
  if (error instanceof ShipmentInvoiceServiceError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

function audit(action: "SHIPMENT_INVOICE_REVISED_SAVED" | "SHIPMENT_INVOICE_REVISED_DELETED" | "SHIPMENT_INVOICE_REVISED_DOWNLOADED", copyId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, metadata: Record<string, unknown>) {
  // Best-effort like the invoice download audit: never fail the request itself.
  void AuditLog.create({
    action,
    entityType: "SHIPMENT_INVOICE",
    entityId: copyId,
    performedBy: userId,
    performedAt: new Date(),
    metadata
  }).catch(() => { /* audit trail is best-effort here */ });
}

export async function listShipmentInvoiceRevisedDocuments(request: Request, response: Response): Promise<Response> {
  try {
    const userId = getAuthenticatedUserId(request);
    if (!userId) throw new ShipmentInvoiceServiceError("Unauthorized", 401);
    const shipmentDraftId = getDraftId(request);
    if (!shipmentDraftId) throw new ShipmentInvoiceServiceError("Shipment not found.", 404);

    const copies = await ShipmentInvoiceRevisedDocument.find({ shipmentDraftId, deletedAt: null }).sort({ updatedAt: -1 }).exec();
    return response.status(200).json({ success: true, copies: copies.map(serializeRevisedDocument) });
  } catch (error) {
    return sendRevisedError(response, error);
  }
}

export async function getShipmentInvoiceRevisedDocument(request: Request, response: Response): Promise<Response> {
  try {
    const userId = getAuthenticatedUserId(request);
    if (!userId) throw new ShipmentInvoiceServiceError("Unauthorized", 401);
    const shipmentDraftId = getDraftId(request);
    const copyId = getCopyId(request);
    if (!shipmentDraftId || !copyId) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);

    const copy = await ShipmentInvoiceRevisedDocument.findOne({ _id: copyId, shipmentDraftId, deletedAt: null }).exec();
    if (!copy) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);
    return response.status(200).json({ success: true, copy: serializeRevisedDocument(copy) });
  } catch (error) {
    return sendRevisedError(response, error);
  }
}

export async function createShipmentInvoiceRevisedDocument(request: Request, response: Response): Promise<Response> {
  try {
    const userId = getAuthenticatedUserId(request);
    if (!userId) throw new ShipmentInvoiceServiceError("Unauthorized", 401);
    const shipmentDraftId = getDraftId(request);
    if (!shipmentDraftId) throw new ShipmentInvoiceServiceError("Shipment not found.", 404);

    const realInvoice = await requireRealInvoice(shipmentDraftId);
    const basedOnRevision = Number(request.body?.basedOnRevision);
    if (!Number.isInteger(basedOnRevision) || basedOnRevision < 1 || basedOnRevision > realInvoice.revision) {
      throw new ShipmentInvoiceServiceError("The invoice revision this copy is based on is invalid.", 400);
    }

    const reason = changeReason(request.body?.changeReason);
    const copy = await ShipmentInvoiceRevisedDocument.create({
      shipmentDraftId,
      invoiceNumber: realInvoice.invoiceNumber,
      basedOnRevision,
      document: buildStoredDocument(request.body?.document, realInvoice),
      changeReason: reason,
      history: [],
      createdBy: userId,
      updatedBy: userId
    });
    audit("SHIPMENT_INVOICE_REVISED_SAVED", copy._id, userId, {
      shipmentDraftId,
      invoiceNumber: copy.invoiceNumber,
      basedOnRevision,
      reason
    });
    return response.status(201).json({ success: true, copy: serializeRevisedDocument(copy) });
  } catch (error) {
    return sendRevisedError(response, error);
  }
}

export async function updateShipmentInvoiceRevisedDocument(request: Request, response: Response): Promise<Response> {
  try {
    const userId = getAuthenticatedUserId(request);
    if (!userId) throw new ShipmentInvoiceServiceError("Unauthorized", 401);
    const shipmentDraftId = getDraftId(request);
    const copyId = getCopyId(request);
    if (!shipmentDraftId || !copyId) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);

    const realInvoice = await requireRealInvoice(shipmentDraftId);
    const copy = await ShipmentInvoiceRevisedDocument.findOne({ _id: copyId, shipmentDraftId, deletedAt: null }).exec();
    if (!copy) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);

    const basedOnRevision = request.body?.basedOnRevision === undefined
      ? copy.basedOnRevision
      : Number(request.body.basedOnRevision);
    if (!Number.isInteger(basedOnRevision) || basedOnRevision < 1 || basedOnRevision > realInvoice.revision) {
      throw new ShipmentInvoiceServiceError("The invoice revision this copy is based on is invalid.", 400);
    }

    const nextDocument = buildStoredDocument(request.body?.document ?? copy.document, realInvoice);
    const nextReason = changeReason(request.body?.changeReason);
    if (!Array.isArray(copy.history)) copy.history = [];
    copy.history.push({
      document: cloneDocument(copy.document),
      changeReason: copy.changeReason || "Original revised copy",
      updatedBy: copy.updatedBy ?? copy.createdBy,
      updatedAt: copy.updatedAt
    });
    copy.document = nextDocument;
    copy.changeReason = nextReason;
    copy.basedOnRevision = basedOnRevision;
    copy.updatedBy = userId;
    await copy.save();
    audit("SHIPMENT_INVOICE_REVISED_SAVED", copy._id, userId, {
      shipmentDraftId,
      invoiceNumber: copy.invoiceNumber,
      basedOnRevision,
      reason: nextReason
    });
    return response.status(200).json({ success: true, copy: serializeRevisedDocument(copy) });
  } catch (error) {
    return sendRevisedError(response, error);
  }
}

export async function deleteShipmentInvoiceRevisedDocument(request: Request, response: Response): Promise<Response> {
  try {
    const userId = getAuthenticatedUserId(request);
    if (!userId) throw new ShipmentInvoiceServiceError("Unauthorized", 401);
    const shipmentDraftId = getDraftId(request);
    const copyId = getCopyId(request);
    if (!shipmentDraftId || !copyId) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);

    const copy = await ShipmentInvoiceRevisedDocument.findOne({ _id: copyId, shipmentDraftId, deletedAt: null }).exec();
    if (!copy) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);
    // Copies made before the reason field existed remain recoverable and can
    // still be soft-deleted after this hardening release.
    if (!copy.changeReason) copy.changeReason = "Original revised copy";
    copy.deletedAt = new Date();
    copy.deletedBy = userId;
    await copy.save();
    audit("SHIPMENT_INVOICE_REVISED_DELETED", copy._id, userId, { shipmentDraftId });
    return response.status(200).json({ success: true, message: "Revised copy deleted. The real invoice is unchanged." });
  } catch (error) {
    return sendRevisedError(response, error);
  }
}

export async function downloadShipmentInvoiceRevisedDocumentPdf(request: Request, response: Response): Promise<Response | void> {
  try {
    const userId = getAuthenticatedUserId(request);
    if (!userId) throw new ShipmentInvoiceServiceError("Unauthorized", 401);
    const shipmentDraftId = getDraftId(request);
    const copyId = getCopyId(request);
    if (!shipmentDraftId || !copyId) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);

    const copy = await ShipmentInvoiceRevisedDocument.findOne({ _id: copyId, shipmentDraftId, deletedAt: null }).lean().exec();
    if (!copy) throw new ShipmentInvoiceServiceError("Revised copy not found.", 404);

    // The stored document carries ISO date strings; the PDF renderer formats
    // real Date objects, so revive them without touching the stored row.
    const stored = asRecord(copy.document);
    const printable = {
      ...stored,
      issuedAt: stored.issuedAt ? new Date(String(stored.issuedAt)) : new Date(),
      revisedAt: stored.revisedAt ? new Date(String(stored.revisedAt)) : null
    };
    audit("SHIPMENT_INVOICE_REVISED_DOWNLOADED", copy._id, userId, {
      shipmentDraftId,
      invoiceNumber: copy.invoiceNumber
    });

    const filename = `${String(copy.invoiceNumber).replaceAll("/", "-")}-Revised.pdf`;
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const document = createShipmentInvoicePdf(
      printable as unknown as Parameters<typeof createShipmentInvoicePdf>[0],
      { revisedCopy: true }
    );
    document.pipe(response);
    document.end();
  } catch (error) {
    return sendRevisedError(response, error);
  }
}
