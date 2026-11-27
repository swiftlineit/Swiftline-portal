import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { renderCashReceiptPdf } from "../services/cashReceiptPdf.service.js";

function receipt(overrides: Partial<Parameters<typeof renderCashReceiptPdf>[0]> = {}) {
  const base = {
    _id: new mongoose.Types.ObjectId(),
    tenantId: new mongoose.Types.ObjectId(),
    receiptNumber: "CR-20261126-6DB914D9",
    receiptType: "STANDALONE" as const,
    status: "FINALIZED" as const,
    customerType: "BUSINESS" as const,
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    pricingHash: "hash",
    pricingRevision: 0,
    totalReceivedMinor: 900000,
    currency: "INR" as const,
    allocations: [],
    unappliedAmountMinor: 0,
    customerNameSnapshot: "Lala company pvt ltd abc",
    gstinSnapshot: "07BBRPP9678K1Z3",
    addressSnapshot: "Solanki Chowk, Delhi, 110077, India",
    receiptDate: new Date("2026-11-26T12:00:00.000Z"),
    accountIdSnapshot: "BA-2026-100001",
    destinationSnapshot: "Delhi",
    serviceSnapshot: "COURIER",
    piecesSnapshot: 4,
    weightKgSnapshot: 240,
    customerReference: "",
    cashCustodyReference: "test",
    note: "",
    createdBy: new mongoose.Types.ObjectId(),
    createdByNameSnapshot: "Swiftline Staff",
    cashRecordedByNameSnapshot: "Swiftline Staff",
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  return { ...base, ...overrides } as Parameters<typeof renderCashReceiptPdf>[0];
}

test("cash receipt PDF renders a valid PDF with receipt details", async () => {
  const pdf = await renderCashReceiptPdf(receipt());
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 0);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});
