import type { Request, Response } from "express";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import {
  ensureShipmentInvoiceForDraft,
  serializeShipmentInvoice,
  ShipmentInvoiceServiceError
} from "../services/shipmentInvoice.service.js";
import { createShipmentInvoicePdf } from "../services/shipmentInvoicePdf.service.js";
import { RateCardRequiredError } from "../services/shipmentPricing.service.js";
import { getTenantContext } from "../services/tenantScope.service.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { isOperatorBrandLogoStorageKey } from "../services/operatorBranding.service.js";
import { assertValidStorageKey, getObjectBuffer } from "../services/storage/storage.service.js";

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

function getRequestedRevision(request: Request) {
  const value = typeof request.query.revision === "string" ? request.query.revision : "";
  if (!value) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new ShipmentInvoiceServiceError("Invoice revision is invalid.", 400);
  }
  return Number(value);
}

export function isShipmentTaxInvoiceReady(input: {
  shipmentStatus: string;
  tenantKind?: "SWIFTLINE" | "OPERATOR";
  operatorInternalLabelAvailable: boolean;
}) {
  return input.shipmentStatus === "LABEL_RECEIVED"
    || (input.tenantKind === "OPERATOR" && input.operatorInternalLabelAvailable);
}

async function resolveInvoice(request: Request) {
  const userId = getAuthenticatedUserId(request);
  if (!userId) throw new ShipmentInvoiceServiceError("Unauthorized", 401);

  const shipmentDraftId = getDraftId(request);
  if (!shipmentDraftId) throw new ShipmentInvoiceServiceError("Shipment not found.", 404);

  const dpdShipment = await DpdShipment.findOne({ shipmentDraftId }).lean().exec();
  if (!dpdShipment) throw new ShipmentInvoiceServiceError("Invoice is available after the shipment is booked.", 409);

  let invoice = await ShipmentInvoice.findOne({ shipmentDraftId, status: "ISSUED" }).exec();
  if (!invoice) {
    if (getOperatorContext(request)?.accessMode === "PLATFORM_SUPPORT") {
      throw new ShipmentInvoiceServiceError("Invoice has not been issued yet.", 409);
    }
    // Only new issuance consumes a statutory GST number. A later carrier-label
    // failure must not hide an invoice that was already issued for this draft.
    const tenantContext = getTenantContext();
    const operatorInternalLabelAvailable = tenantContext?.kind === "OPERATOR"
      ? Boolean(await LabelDocument.exists({
        tenantId: tenantContext.tenantId,
        dpdShipmentId: dpdShipment._id,
        labelType: "INTERNAL",
        labelVersion: dpdShipment.snapshotRevision || 1,
        voidedAt: null
      }))
      : false;
    if (!isShipmentTaxInvoiceReady({
      shipmentStatus: dpdShipment.status,
      tenantKind: tenantContext?.kind,
      operatorInternalLabelAvailable
    })) {
      throw new ShipmentInvoiceServiceError(
        "Invoice is available once the shipment is booked and its labels are issued.",
        409
      );
    }

    invoice = await ensureShipmentInvoiceForDraft({
      shipmentDraftId,
      dpdShipmentId: dpdShipment._id,
      userId
    });
  }

  const selectedInvoice = serializeShipmentInvoice(invoice, getRequestedRevision(request) ?? invoice.revision);
  return { invoice, selectedInvoice, userId };
}

function sendInvoiceError(response: Response, error: unknown) {
  if (error instanceof RateCardRequiredError) {
    return response.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
  }
  if (error instanceof ShipmentInvoiceServiceError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

function supplierForRevision(invoice: InstanceType<typeof ShipmentInvoice>, revision: number) {
  if (revision === invoice.revision) return invoice.supplier;
  return invoice.revisions.find((item) => item.revision === revision)?.supplier;
}

export async function getShipmentInvoice(request: Request, response: Response): Promise<Response> {
  try {
    const { selectedInvoice } = await resolveInvoice(request);
    return response.status(200).json({ success: true, invoice: selectedInvoice });
  } catch (error) {
    return sendInvoiceError(response, error);
  }
}

export async function downloadShipmentInvoicePdf(request: Request, response: Response): Promise<Response | void> {
  try {
    const { invoice, selectedInvoice, userId } = await resolveInvoice(request);
    const persistedInvoice = await ShipmentInvoice.findById(invoice._id).exec();
    if (!persistedInvoice) return response.status(404).json({ success: false, message: "Shipment invoice not found." });

    // Recorded off the response path: the download must not wait for the
    // audit write, and an audit failure must never fail the download itself.
    void AuditLog.create({
      action: "SHIPMENT_INVOICE_DOWNLOADED",
      entityType: "SHIPMENT_INVOICE",
      entityId: persistedInvoice._id,
      performedBy: userId,
      performedAt: new Date(),
      metadata: {
        shipmentDraftId: persistedInvoice.shipmentDraftId,
        invoiceNumber: persistedInvoice.invoiceNumber,
        revision: selectedInvoice.revision
      }
    }).catch(() => { /* audit trail is best-effort here */ });

    const filename = `${persistedInvoice.invoiceNumber.replaceAll("/", "-")}-Invoice-${selectedInvoice.revision}.pdf`;
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const tenantContext = getTenantContext();
    let logoBuffer: Buffer | undefined;
    const supplier = supplierForRevision(persistedInvoice, selectedInvoice.revision);
    const logoKey = supplier && typeof supplier === "object"
      ? (supplier as Record<string, unknown>).operatorLogoStorageKey
      : null;
    if (tenantContext?.kind === "OPERATOR" && typeof logoKey === "string"
      && isOperatorBrandLogoStorageKey(String(tenantContext.tenantId), logoKey)) {
      try {
        assertValidStorageKey(logoKey);
        logoBuffer = await getObjectBuffer(logoKey);
      } catch {
        // Missing optional branding falls back to the recorded company name.
      }
    }
    const document = createShipmentInvoicePdf(selectedInvoice, {
      tenantKind: tenantContext?.kind ?? "SWIFTLINE",
      logoBuffer
    });
    document.pipe(response);
    document.end();
  } catch (error) {
    return sendInvoiceError(response, error);
  }
}
