import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import {
  createShipmentInvoiceRevisedDocument,
  deleteShipmentInvoiceRevisedDocument,
  updateShipmentInvoiceRevisedDocument,
  listShipmentInvoiceRevisedDocuments
} from "../controllers/shipmentInvoiceRevisedDocument.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceRevisedDocument } from "../models/shipmentInvoiceRevisedDocument.model.js";

function requestFor(draftId: mongoose.Types.ObjectId, body: unknown = {}, copyId?: mongoose.Types.ObjectId): Request {
  return {
    params: { draftId: String(draftId), ...(copyId ? { copyId: String(copyId) } : {}) },
    query: {},
    body,
    user: { _id: new mongoose.Types.ObjectId() }
  } as unknown as Request;
}

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    }
  } as unknown as Response;
  return { response, read: () => ({ statusCode, body }) };
}

function realInvoice(shipmentDraftId: mongoose.Types.ObjectId) {
  return {
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: "SL/26-27/00001",
    financialYear: "2026-27",
    shipmentDraftId,
    dpdShipmentId: new mongoose.Types.ObjectId(),
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    revision: 2,
    currency: "INR",
    supplier: { legalName: "Swiftline", address: "Delhi" },
    customer: { companyName: "Original Customer", billingAddress: "London" },
    sacCode: "996812",
    description: "International courier service",
    taxableValueMinor: 10000,
    gstRatePercent: 18,
    taxTreatment: "GST_APPLICABLE",
    taxType: "IGST",
    cgstAmountMinor: 0,
    sgstAmountMinor: 0,
    igstAmountMinor: 1800,
    totalTaxAmountMinor: 1800,
    totalAmountMinor: 11800,
    advanceAppliedMinor: 0,
    creditOutstandingMinor: 11800,
    pricingSnapshot: { lines: [] },
    reverseCharge: false,
    status: "ISSUED",
    paymentStatus: "UNPAID",
    validationWarnings: [],
    issuedAt: new Date("2026-09-01T00:00:00.000Z"),
    revisedAt: new Date("2026-09-02T00:00:00.000Z"),
    revisions: [],
    shipment: {
      shipmentReference: "SLCTRACK000001",
      origin: "DELHI",
      destination: "LONDON",
      parcels: [{
        sequence: 1,
        actualWeightKg: 1,
        volumetricWeightKg: 1,
        chargeableWeightKg: 1,
        chargesPerKg: 100,
        baseAmount: 100,
        lengthCm: null,
        widthCm: null,
        heightCm: null,
        contentsDescription: "Documents",
        items: [{ description: "Documents" }]
      }]
    }
  };
}

function editedDocument() {
  return {
    invoiceNumber: "SL/26-27/00001",
    currency: "INR",
    supplier: { legalName: "Swiftline" },
    customer: { companyName: "Edited Customer" },
    shipment: {
      shipmentReference: "TAMPERED",
      parcels: [{
        sequence: 1,
        actualWeightKg: 1,
        volumetricWeightKg: 1,
        chargeableWeightKg: 1,
        chargesPerKg: 100,
        baseAmount: 100,
        lengthCm: null,
        widthCm: null,
        heightCm: null,
        contentsDescription: "Edited documents",
        items: [{ description: "Edited documents" }]
      }]
    },
    sacCode: "996812",
    description: "Edited courier service",
    taxableValueMinor: 10000,
    gstRatePercent: 18,
    taxType: "IGST",
    cgstAmountMinor: 999999,
    sgstAmountMinor: 999999,
    igstAmountMinor: 1,
    totalTaxAmountMinor: 1,
    totalAmountMinor: 1,
    pricingSnapshot: { lines: [] },
    issuedAt: "2026-09-03T00:00:00.000Z"
  };
}

describe("shipment invoice revised documents", () => {
  test("stores the edited document while leaving the real invoice untouched", async () => {
    const draftId = new mongoose.Types.ObjectId();
    const invoice = realInvoice(draftId);
    // ObjectIds never survive a JSON round trip as objects, so normalise
    // before comparing: the point is the controller must not mutate the row.
    const snapshot = JSON.stringify({ ...invoice, _id: String(invoice._id) });
    const audits: Array<{ action: string }> = [];
    let storedInput: Record<string, unknown> = {};

    try {
      mock.method(ShipmentInvoice, "findOne", () => ({ exec: async () => invoice }) as never);
      mock.method(ShipmentInvoiceRevisedDocument, "create", (input: unknown) => {
        storedInput = input as Record<string, unknown>;
        return {
          _id: new mongoose.Types.ObjectId(),
          ...(input as Record<string, unknown>),
          createdAt: new Date(),
          updatedAt: new Date()
        } as never;
      });
      mock.method(AuditLog, "create", async (entry: unknown) => {
        audits.push(entry as { action: string });
        return {} as never;
      });

      const recorder = responseRecorder();
      await createShipmentInvoiceRevisedDocument(
        requestFor(draftId, { document: editedDocument(), basedOnRevision: 2, changeReason: "Corrected customer charge" }),
        recorder.response
      );

      const result = recorder.read();
      assert.equal(result.statusCode, 201);
      assert.equal((result.body as { success: boolean }).success, true);
      // The tracking reference is forced back to the real invoice value even
      // though the payload tried to change it.
      assert.equal(
        ((storedInput.document as Record<string, unknown>).shipment as Record<string, unknown>).shipmentReference,
        "SLCTRACK000001"
      );
      // Client-supplied totals are ignored. The server derives them from the
      // taxable value, GST rate and tax type before persisting the copy.
      assert.equal((storedInput.document as Record<string, unknown>).igstAmountMinor, 1800);
      assert.equal((storedInput.document as Record<string, unknown>).totalTaxAmountMinor, 1800);
      assert.equal((storedInput.document as Record<string, unknown>).totalAmountMinor, 11800);
      assert.equal(storedInput.changeReason, "Corrected customer charge");
      assert.deepEqual(JSON.stringify({ ...invoice, _id: String(invoice._id) }), snapshot);
      assert.equal(audits.at(-1)?.action, "SHIPMENT_INVOICE_REVISED_SAVED");
    } finally {
      mock.restoreAll();
    }
  });

  test("ignores hidden freight and tax rows echoed by the editor", async () => {
    const draftId = new mongoose.Types.ObjectId();
    const systemLines = [
      { code: "FREIGHT", label: "Freight", kind: "CHARGE", amount: 100, amountMinor: 10000, basis: "Server pricing" },
      { code: "GST", label: "GST", kind: "TAX", amount: 18, amountMinor: 1800, basis: "Server pricing" }
    ];
    const invoice = { ...realInvoice(draftId), pricingSnapshot: { lines: systemLines } };
    const document = { ...editedDocument(), pricingSnapshot: { lines: systemLines } };
    let storedInput: Record<string, unknown> = {};

    try {
      mock.method(ShipmentInvoice, "findOne", () => ({ exec: async () => invoice }) as never);
      mock.method(ShipmentInvoiceRevisedDocument, "create", (input: unknown) => {
        storedInput = input as Record<string, unknown>;
        return {
          _id: new mongoose.Types.ObjectId(),
          ...(input as Record<string, unknown>),
          createdAt: new Date(),
          updatedAt: new Date()
        } as never;
      });
      mock.method(AuditLog, "create", async () => ({} as never));

      const recorder = responseRecorder();
      await createShipmentInvoiceRevisedDocument(
        requestFor(draftId, { document, basedOnRevision: 2, changeReason: "Corrected customer charge" }),
        recorder.response
      );

      assert.equal(recorder.read().statusCode, 201);
      assert.deepEqual(
        ((storedInput.document as Record<string, unknown>).pricingSnapshot as Record<string, unknown>).lines,
        systemLines
      );
    } finally {
      mock.restoreAll();
    }
  });

  test("rejects an empty revised document", async () => {
    const draftId = new mongoose.Types.ObjectId();

    try {
      mock.method(ShipmentInvoice, "findOne", () => ({ exec: async () => realInvoice(draftId) }) as never);

      const recorder = responseRecorder();
      await createShipmentInvoiceRevisedDocument(
        requestFor(draftId, { document: {}, basedOnRevision: 1 }),
        recorder.response
      );

      assert.equal(recorder.read().statusCode, 400);
    } finally {
      mock.restoreAll();
    }
  });

  test("requires a reason before storing a revised copy", async () => {
    const draftId = new mongoose.Types.ObjectId();

    try {
      mock.method(ShipmentInvoice, "findOne", () => ({ exec: async () => realInvoice(draftId) }) as never);

      const recorder = responseRecorder();
      await createShipmentInvoiceRevisedDocument(
        requestFor(draftId, { document: editedDocument(), basedOnRevision: 2 }),
        recorder.response
      );

      assert.equal(recorder.read().statusCode, 400);
    } finally {
      mock.restoreAll();
    }
  });

  test("refuses a copy when the real invoice does not exist yet", async () => {
    const draftId = new mongoose.Types.ObjectId();

    try {
      mock.method(ShipmentInvoice, "findOne", () => ({ exec: async () => null }) as never);

      const recorder = responseRecorder();
      await createShipmentInvoiceRevisedDocument(
        requestFor(draftId, { document: editedDocument(), basedOnRevision: 1, changeReason: "Corrected customer charge" }),
        recorder.response
      );

      assert.equal(recorder.read().statusCode, 409);
    } finally {
      mock.restoreAll();
    }
  });

  test("lists stored copies newest first", async () => {
    const draftId = new mongoose.Types.ObjectId();
    const rows = [
      { _id: new mongoose.Types.ObjectId(), shipmentDraftId: draftId, invoiceNumber: "SL/26-27/00001", basedOnRevision: 1, document: editedDocument(), createdAt: new Date(), updatedAt: new Date() },
      { _id: new mongoose.Types.ObjectId(), shipmentDraftId: draftId, invoiceNumber: "SL/26-27/00001", basedOnRevision: 2, document: editedDocument(), createdAt: new Date(), updatedAt: new Date() }
    ];

    try {
      mock.method(ShipmentInvoiceRevisedDocument, "find", () => ({
        sort: () => ({ exec: async () => rows })
      }) as never);

      const recorder = responseRecorder();
      await listShipmentInvoiceRevisedDocuments(requestFor(draftId), recorder.response);

      const result = recorder.read();
      assert.equal(result.statusCode, 200);
      assert.equal((result.body as { copies: unknown[] }).copies.length, 2);
    } finally {
      mock.restoreAll();
    }
  });

  test("keeps the replaced document in history when a copy is edited", async () => {
    const draftId = new mongoose.Types.ObjectId();
    const copyId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const copy = {
      _id: copyId,
      shipmentDraftId: draftId,
      invoiceNumber: "SL/26-27/00001",
      basedOnRevision: 2,
      document: editedDocument(),
      changeReason: "Original correction",
      history: [] as Array<Record<string, unknown>>,
      createdBy: userId,
      updatedBy: userId,
      updatedAt: new Date("2026-09-03T00:00:00.000Z"),
      save: async () => copy
    };

    try {
      mock.method(ShipmentInvoice, "findOne", () => ({ exec: async () => realInvoice(draftId) }) as never);
      mock.method(ShipmentInvoiceRevisedDocument, "findOne", () => ({ exec: async () => copy }) as never);
      mock.method(AuditLog, "create", async () => ({} as never));

      const recorder = responseRecorder();
      await updateShipmentInvoiceRevisedDocument(
        requestFor(draftId, {
          document: editedDocument(),
          basedOnRevision: 2,
          changeReason: "Corrected final clearance charge"
        }, copyId),
        recorder.response
      );

      assert.equal(recorder.read().statusCode, 200);
      assert.equal(copy.history.length, 1);
      assert.equal(copy.history[0]?.changeReason, "Original correction");
      assert.equal(copy.changeReason, "Corrected final clearance charge");
    } finally {
      mock.restoreAll();
    }
  });

  test("soft-deletes a revised copy without destroying its audit history", async () => {
    const draftId = new mongoose.Types.ObjectId();
    const copyId = new mongoose.Types.ObjectId();
    const copy = {
      _id: copyId,
      shipmentDraftId: draftId,
      history: [{ document: editedDocument(), changeReason: "Original correction" }],
      save: async () => copy
    } as {
      _id: mongoose.Types.ObjectId;
      shipmentDraftId: mongoose.Types.ObjectId;
      history: Array<Record<string, unknown>>;
      deletedAt?: Date;
      deletedBy?: mongoose.Types.ObjectId;
      save: () => Promise<unknown>;
    };

    try {
      mock.method(ShipmentInvoiceRevisedDocument, "findOne", () => ({ exec: async () => copy }) as never);
      mock.method(AuditLog, "create", async () => ({} as never));

      const recorder = responseRecorder();
      await deleteShipmentInvoiceRevisedDocument(requestFor(draftId, {}, copyId), recorder.response);

      assert.equal(recorder.read().statusCode, 200);
      assert.ok(copy.deletedAt instanceof Date);
      assert.ok(copy.deletedBy);
      assert.equal(copy.history.length, 1);
    } finally {
      mock.restoreAll();
    }
  });
});
