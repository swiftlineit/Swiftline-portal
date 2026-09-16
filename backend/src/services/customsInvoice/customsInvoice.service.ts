// Loads a shipment and renders its customs (shipment) invoice on demand.

import mongoose from "mongoose";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import { readShipmentBookingSnapshot } from "../shipmentBookingSnapshot.service.js";
import { publicShipmentSourceIdentity } from "../shipmentSourceIdentity.service.js";
import { buildCustomsInvoiceModel, type CustomsInvoiceModel } from "./customsInvoiceModel.service.js";
import { renderCustomsInvoicePdfBuffer } from "./customsInvoicePdf.service.js";
import { buildCustomsInvoiceWorkbook } from "./customsInvoiceWorkbook.service.js";

export class CustomsInvoiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "CustomsInvoiceError";
  }
}

export function resolveCustomsInvoiceNumber(input: {
  invoiceNumber?: string | null;
  shipmentReference?: string | null;
  swiftlineTrackingNumber?: string | null;
  draftId: string;
}): string {
  return input.invoiceNumber?.trim()
    || input.shipmentReference?.trim()
    || input.swiftlineTrackingNumber?.trim()
    || `SLS-${input.draftId.slice(-8).toUpperCase()}`;
}

export async function buildCustomsInvoiceForDraft(input: {
  shipmentDraftId: string;
  businessAccountId?: mongoose.Types.ObjectId | null;
}): Promise<CustomsInvoiceModel> {
  if (!mongoose.Types.ObjectId.isValid(input.shipmentDraftId)) {
    throw new CustomsInvoiceError("Shipment not found.", 404);
  }

  const draft = await ShipmentDraft.findById(input.shipmentDraftId).exec();
  if (!draft) throw new CustomsInvoiceError("Shipment not found.", 404);

  if (input.businessAccountId && String(draft.businessAccountId) !== String(input.businessAccountId)) {
    throw new CustomsInvoiceError("Shipment not found.", 404);
  }

  const booking = await DpdShipment.findOne({ shipmentDraftId: draft._id })
    .select("swiftlineTrackingNumber parcelNumbers currentShipmentSnapshot bookingSnapshot")
    .lean()
    .exec();
  const sourceIdentity = publicShipmentSourceIdentity(draft);
  const invoiceNumber = resolveCustomsInvoiceNumber({
    invoiceNumber: sourceIdentity.invoiceNumber,
    shipmentReference: sourceIdentity.shipmentReference,
    swiftlineTrackingNumber: booking?.swiftlineTrackingNumber,
    draftId: String(draft._id)
  });

  // House airway bills in parcel order. The booking snapshot is authoritative:
  // some bookings were stored with an empty parcelNumbers array, so the flat
  // array is only a fallback.
  const snapshot = booking
    ? readShipmentBookingSnapshot(booking.currentShipmentSnapshot)
      ?? readShipmentBookingSnapshot(booking.bookingSnapshot)
    : null;
  const snapshotNumbers = (snapshot?.parcels ?? [])
    .map((parcel) => String(parcel.swiftlineParcelNumber ?? "").trim());
  const parcelNumbers = snapshotNumbers.some(Boolean)
    ? snapshotNumbers
    : Array.isArray(booking?.parcelNumbers)
      ? booking.parcelNumbers.map((value) => String(value ?? "").trim())
      : [];

  return buildCustomsInvoiceModel({
    draft: draft as never,
    invoiceNumber,
    invoiceDate: draft.createdAt ?? new Date(),
    parcelNumbers
  });
}

export async function renderCustomsInvoicePdf(input: {
  shipmentDraftId: string;
  businessAccountId?: mongoose.Types.ObjectId | null;
}) {
  const invoice = await buildCustomsInvoiceForDraft(input);
  return { invoice, buffer: await renderCustomsInvoicePdfBuffer(invoice) };
}

export async function renderCustomsInvoiceWorkbook(input: {
  shipmentDraftId: string;
  businessAccountId?: mongoose.Types.ObjectId | null;
}) {
  const invoice = await buildCustomsInvoiceForDraft(input);
  return { invoice, buffer: await buildCustomsInvoiceWorkbook(invoice) };
}

export function customsInvoiceFileName(invoice: CustomsInvoiceModel, extension: "pdf" | "xlsx") {
  const safe = invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe}-shipment-invoice.${extension}`;
}
