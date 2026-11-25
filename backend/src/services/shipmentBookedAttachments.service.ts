import mongoose from "mongoose";
import type { IEmailAttachmentRef } from "../models/emailOutbox.model.js";
import type { IShipmentInvoice } from "../models/shipmentInvoice.model.js";
import type { ICashReceipt } from "../models/cashReceipt.model.js";
import { isVisibleShipmentLabel } from "./als/alsLabelClassification.js";

type BookingLabel = {
  _id: mongoose.Types.ObjectId;
  labelType?: string;
  parcelNumber: string;
  format: string;
  storageKey: string;
};

export function buildShipmentBookedAttachmentRefs(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  trackingNumber: string;
  shipmentInvoice: Pick<IShipmentInvoice, "_id" | "revision" | "invoiceNumber">;
  labels: BookingLabel[];
  cashReceipt?: Pick<ICashReceipt, "_id" | "receiptNumber"> | null;
}): IEmailAttachmentRef[] {
  const invoiceNumber = input.shipmentInvoice.invoiceNumber.replaceAll("/", "-");
  const shipmentReference = input.trackingNumber || String(input.shipmentDraftId);
  const uniqueLabels = input.labels.filter((label, index, labels) => (
    isVisibleShipmentLabel(label)
    && labels.findIndex((candidate) => candidate.storageKey === label.storageKey) === index
  ));

  return [
    {
      kind: "SHIPMENT_INVOICE_PDF",
      refId: input.shipmentInvoice._id as mongoose.Types.ObjectId,
      revision: input.shipmentInvoice.revision,
      filename: `${invoiceNumber}-Tax-Invoice.pdf`
    },
    {
      kind: "CUSTOMS_INVOICE_PDF",
      refId: input.shipmentDraftId,
      filename: `Shipment-${shipmentReference}-Invoice.pdf`
    },
    ...(input.cashReceipt ? [{
      kind: "CASH_RECEIPT_PDF" as const,
      refId: input.cashReceipt._id,
      filename: `CASH-RECEIPT-${input.cashReceipt.receiptNumber}.pdf`
    }] : []),
    ...uniqueLabels.map((label): IEmailAttachmentRef => ({
      kind: "LABEL_DOCUMENT",
      refId: label._id,
      revision: null,
      filename: label.labelType === "DPD"
        ? `DPD-Label-${label.parcelNumber}.${label.format.toLowerCase()}`
        : label.labelType === "INTERNAL"
          ? `Internal-Label-${label.parcelNumber}.${label.format.toLowerCase()}`
          : `Swiftline-Label-${label.parcelNumber}.${label.format.toLowerCase()}`
    }))
  ];
}
