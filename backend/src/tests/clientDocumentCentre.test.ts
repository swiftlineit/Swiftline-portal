import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Claim } from "../models/claim.model.js";
import { ClaimDocument } from "../models/claimDocument.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { PodRevision } from "../models/pod.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { ShipmentSupportingDocument } from "../models/shipmentSupportingDocument.model.js";
import { listClientDocumentCentre } from "../services/clientDocumentCentre.service.js";

const databaseName = `sl_document_centre_${Date.now()}`;
const accountId = new mongoose.Types.ObjectId();
const branchId = new mongoose.Types.ObjectId();
const draftId = new mongoose.Types.ObjectId();
const bookingId = new mongoose.Types.ObjectId();
const now = new Date("2026-08-13T08:30:00.000Z");

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName);

  await Promise.all([
    ShipmentDraft.createCollection(),
    DpdShipment.createCollection(),
    LabelDocument.createCollection(),
    ShipmentManifest.createCollection(),
    PodRevision.createCollection(),
    ShipmentInvoice.createCollection(),
    ShipmentCreditNote.createCollection(),
    CreditBillingStatement.createCollection(),
    Claim.createCollection(),
    ClaimDocument.createCollection(),
    ShipmentSupportingDocument.createCollection()
  ]);

  await ShipmentDraft.collection.insertOne({
    _id: draftId,
    businessAccountId: accountId,
    branchId,
    bookingState: "BOOKED",
    deletedAt: null,
    allocatedTrackingNumber: "SLCDEL130826001",
    consigneeEnteredAddress: { townOrCity: "London", countryName: "United Kingdom" },
    createdAt: now,
    updatedAt: now
  });
  await DpdShipment.collection.insertOne({
    _id: bookingId,
    shipmentDraftId: draftId,
    swiftlineTrackingNumber: "SLCDEL130826001",
    status: "LABEL_RECEIVED",
    createdAt: now,
    updatedAt: now
  });
  await LabelDocument.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    dpdShipmentId: bookingId,
    parcelNumber: "SLCDEL130826001-01",
    labelType: "SWIFTLINE",
    providerMode: "LIVE",
    format: "PDF",
    labelSize: "A6",
    voidedAt: null,
    generatedAt: now,
    createdAt: now,
    updatedAt: now
  });
  await ShipmentManifest.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    manifestNumber: "MAN-001",
    businessAccountId: accountId,
    branchId,
    lineSnapshots: [{ consignmentNumber: "SLCDEL130826001", destination: "London" }],
    generatedAt: now,
    createdAt: now,
    updatedAt: now
  });
  await ShipmentManifest.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    manifestNumber: "SLC-001",
    manifestType: "COMBINED",
    businessAccountId: accountId,
    businessAccountIds: [accountId],
    branchId,
    lineSnapshots: [{ consignmentNumber: "SLCDEL130826002", destination: "Paris", sectionLabel: "Business Account A" }],
    generatedAt: now,
    createdAt: now,
    updatedAt: now
  });
  await ShipmentInvoice.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: "INV-001",
    shipmentDraftId: draftId,
    dpdShipmentId: bookingId,
    businessAccountId: accountId,
    branchId,
    status: "ISSUED",
    paymentStatus: "UNPAID",
    issuedAt: now,
    createdAt: now,
    updatedAt: now
  });
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_document_centre_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("client document centre", () => {
  test("combines operational records and filters them by AWB", async () => {
    const result = await listClientDocumentCentre(
      { ok: true, businessAccountId: accountId, branchIds: [branchId], canViewFinancials: false },
      { awb: "130826001", page: 1, limit: 20 }
    );

    assert.deepEqual(
      new Set(result.items.map((item) => item.documentType)),
      new Set(["SHIPPING_LABEL", "COMMERCIAL_INVOICE", "MANIFEST"])
    );
    assert.equal(result.items.some((item) => item.documentType === "BILLING_INVOICE"), false);
    assert.equal(result.pagination.total, 3);
  });

  test("adds financial documents only for a financial membership", async () => {
    const result = await listClientDocumentCentre(
      { ok: true, businessAccountId: accountId, branchIds: [branchId], canViewFinancials: true },
      { documentType: "BILLING_INVOICE", page: 1, limit: 20 }
    );

    assert.equal(result.pagination.total, 1);
    assert.equal(result.items[0]?.reference, "INV-001");
    assert.equal(result.items[0]?.downloadPath, `/api/v1/client/shipments/${draftId}/invoice/pdf`);
  });

  test("does not return documents from an unassigned branch", async () => {
    const result = await listClientDocumentCentre(
      {
        ok: true,
        businessAccountId: accountId,
        branchIds: [new mongoose.Types.ObjectId()],
        canViewFinancials: true
      },
      { page: 1, limit: 20 }
    );

    assert.equal(result.pagination.total, 0);
  });
});
