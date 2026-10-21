// Serves the customs ("shipment") invoice: the goods declaration for an export
// shipment, as JSON for the on-screen view and as PDF / Excel downloads.
//
// Distinct from shipmentInvoice.controller.ts, which serves the GST tax invoice.

import type { Request, Response } from "express";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import {
  buildCustomsInvoiceForDraft,
  customsInvoiceFileName,
  CustomsInvoiceError,
  renderCustomsInvoicePdf,
  renderCustomsInvoiceWorkbook
} from "../services/customsInvoice/customsInvoice.service.js";

function getUserId(request: Request) {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function getDraftId(request: Request) {
  return typeof request.params.draftId === "string" ? request.params.draftId : "";
}

function sendError(response: Response, error: unknown): Response {
  if (error instanceof CustomsInvoiceError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

export async function getCustomsInvoice(request: Request, response: Response): Promise<Response> {
  try {
    const invoice = await buildCustomsInvoiceForDraft({ shipmentDraftId: getDraftId(request) });
    return response.status(200).json({ success: true, invoice });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function downloadCustomsInvoicePdf(request: Request, response: Response): Promise<Response | void> {
  try {
    const draftId = getDraftId(request);
    const userId = getUserId(request);
    if (!userId) return response.status(401).json({ success: false, message: "Authentication required." });
    const { invoice, buffer } = await renderCustomsInvoicePdf({ shipmentDraftId: draftId });

    await AuditLog.create({
      action: "CUSTOMS_INVOICE_DOWNLOADED",
      entityType: "SHIPMENT_DRAFT",
      entityId: new mongoose.Types.ObjectId(draftId),
      performedBy: userId,
      performedAt: new Date(),
      metadata: { invoiceNumber: invoice.invoiceNumber, format: "pdf" }
    });

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    response.setHeader("Content-Disposition", `attachment; filename="${customsInvoiceFileName(invoice, "pdf")}"`);
    return response.status(200).send(buffer);
  } catch (error) {
    return sendError(response, error);
  }
}

export async function downloadCustomsInvoiceWorkbook(request: Request, response: Response): Promise<Response | void> {
  try {
    const draftId = getDraftId(request);
    const userId = getUserId(request);
    if (!userId) return response.status(401).json({ success: false, message: "Authentication required." });
    const { invoice, buffer } = await renderCustomsInvoiceWorkbook({ shipmentDraftId: draftId });

    await AuditLog.create({
      action: "CUSTOMS_INVOICE_DOWNLOADED",
      entityType: "SHIPMENT_DRAFT",
      entityId: new mongoose.Types.ObjectId(draftId),
      performedBy: userId,
      performedAt: new Date(),
      metadata: { invoiceNumber: invoice.invoiceNumber, format: "xlsx" }
    });

    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    response.setHeader("Content-Disposition", `attachment; filename="${customsInvoiceFileName(invoice, "xlsx")}"`);
    return response.status(200).send(buffer);
  } catch (error) {
    return sendError(response, error);
  }
}
