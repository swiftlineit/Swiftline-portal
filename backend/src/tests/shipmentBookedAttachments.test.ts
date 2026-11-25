import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { buildShipmentBookedAttachmentRefs } from "../services/shipmentBookedAttachments.service.js";

const shipmentDraftId = new mongoose.Types.ObjectId();
const invoice = {
  _id: new mongoose.Types.ObjectId(),
  revision: 2,
  invoiceNumber: "SWL/2026-27/000412"
};

test("booking attachments include both invoices, receipts, and distinct valid labels", () => {
  const refs = buildShipmentBookedAttachmentRefs({
    shipmentDraftId,
    trackingNumber: "SWL000123456",
    shipmentInvoice: invoice,
    cashReceipt: { _id: new mongoose.Types.ObjectId(), receiptNumber: "CR-1042" },
    labels: [
      { _id: new mongoose.Types.ObjectId(), labelType: "SWIFTLINE", parcelNumber: "SWL000123456-01", format: "PDF", storageKey: "labels/swiftline.pdf" },
      { _id: new mongoose.Types.ObjectId(), labelType: "DPD", parcelNumber: "SWL000123456-01", format: "HTML", storageKey: "labels/dpd.html" },
      { _id: new mongoose.Types.ObjectId(), labelType: "DPD", parcelNumber: "SWL000123456-02", format: "HTML", storageKey: "labels/dpd.html" },
      { _id: new mongoose.Types.ObjectId(), labelType: "DPD", parcelNumber: "SWL000123456-03", format: "PDF", storageKey: "labels/obsolete-dpd.pdf" }
    ]
  });

  assert.deepEqual(refs.map((ref) => ref.kind), [
    "SHIPMENT_INVOICE_PDF",
    "CUSTOMS_INVOICE_PDF",
    "CASH_RECEIPT_PDF",
    "LABEL_DOCUMENT",
    "LABEL_DOCUMENT"
  ]);
  assert.equal(refs[0]?.filename, "SWL-2026-27-000412-Tax-Invoice.pdf");
  assert.equal(refs[1]?.refId.toString(), shipmentDraftId.toString());
  assert.equal(refs[1]?.filename, "Shipment-SWL000123456-Invoice.pdf");
  assert.equal(refs[2]?.filename, "CASH-RECEIPT-CR-1042.pdf");
  assert.equal(refs[3]?.filename, "Swiftline-Label-SWL000123456-01.pdf");
  assert.equal(refs[4]?.filename, "DPD-Label-SWL000123456-01.html");
});

test("booking attachments omit unavailable optional documents", () => {
  const refs = buildShipmentBookedAttachmentRefs({
    shipmentDraftId,
    trackingNumber: "",
    shipmentInvoice: invoice,
    labels: []
  });

  assert.deepEqual(refs.map((ref) => ref.kind), [
    "SHIPMENT_INVOICE_PDF",
    "CUSTOMS_INVOICE_PDF"
  ]);
  assert.equal(refs[1]?.filename, `Shipment-${shipmentDraftId}-Invoice.pdf`);
});
