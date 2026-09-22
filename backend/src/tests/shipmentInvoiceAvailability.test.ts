import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { getShipmentInvoice } from "../controllers/shipmentInvoice.controller.js";
import { env } from "../config/env.js";
import { AuditLog } from "../models/auditLog.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import {
  DpdLabelUnavailableError,
  generateDpdLabelForExistingShipment
} from "../services/dpdShipment.service.js";

function requestFor(draftId: mongoose.Types.ObjectId): Request {
  return {
    params: { draftId: String(draftId) },
    query: {},
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

function issuedInvoice(shipmentDraftId: mongoose.Types.ObjectId) {
  return new ShipmentInvoice({
    invoiceNumber: "SL/26-27/00999",
    financialYear: "26-27",
    shipmentDraftId,
    dpdShipmentId: new mongoose.Types.ObjectId(),
    businessAccountId: new mongoose.Types.ObjectId(),
    branchId: new mongoose.Types.ObjectId(),
    currency: "INR",
    supplier: { legalName: "Swiftline" },
    customer: { companyName: "Test Customer" },
    shipment: { shipmentReference: "SLCDEL000000999", parcels: [] },
    description: "Test courier shipment",
    taxableValueMinor: 10000,
    gstRatePercent: 0,
    taxTreatment: "NO_GST",
    taxType: "IGST",
    cgstAmountMinor: 0,
    sgstAmountMinor: 0,
    igstAmountMinor: 0,
    totalTaxAmountMinor: 0,
    totalAmountMinor: 10000,
    status: "ISSUED",
    validationWarnings: [],
    paymentStatus: "PAID",
    advanceAppliedMinor: 10000,
    creditOutstandingMinor: 0,
    pricingSnapshot: { totalAmount: 100 },
    revision: 1,
    revisions: [],
    issuedAt: new Date("2026-09-16T06:13:14.261Z"),
    createdBy: new mongoose.Types.ObjectId()
  });
}

describe("shipment invoice availability", () => {
  test("returns an existing issued invoice before applying the label-status gate", async () => {
    const draftId = new mongoose.Types.ObjectId();
    const invoice = issuedInvoice(draftId);

    try {
      mock.method(DpdShipment, "findOne", () => ({
        lean: () => ({
          exec: async () => ({ _id: new mongoose.Types.ObjectId(), status: "DPD_CREATED" })
        })
      }) as never);
      mock.method(ShipmentInvoice, "findOne", (filter: unknown) => {
        assert.deepEqual(filter, { shipmentDraftId: draftId, status: "ISSUED" });
        return { exec: async () => invoice } as never;
      });

      const recorder = responseRecorder();
      await getShipmentInvoice(requestFor(draftId), recorder.response);

      const result = recorder.read();
      assert.equal(result.statusCode, 200);
      assert.equal((result.body as { success: boolean }).success, true);
      assert.equal(
        (result.body as { invoice: { invoiceNumber: string } }).invoice.invoiceNumber,
        invoice.invoiceNumber
      );
    } finally {
      mock.restoreAll();
    }
  });

  test("does not issue a new invoice while labels are incomplete", async () => {
    const draftId = new mongoose.Types.ObjectId();

    try {
      mock.method(ShipmentInvoice, "findOne", () => ({ exec: async () => null }) as never);
      mock.method(DpdShipment, "findOne", () => ({
        lean: () => ({
          exec: async () => ({ _id: new mongoose.Types.ObjectId(), status: "DPD_CREATED" })
        })
      }) as never);

      const recorder = responseRecorder();
      await getShipmentInvoice(requestFor(draftId), recorder.response);

      const result = recorder.read();
      assert.equal(result.statusCode, 409);
      assert.match((result.body as { message: string }).message, /labels are issued/);
    } finally {
      mock.restoreAll();
    }
  });
});

describe("optional DPD label refusal", () => {
  test("restores LABEL_RECEIVED after a definite refusal", async () => {
    const previousAlsEnabled = env.ALS_ENABLED;
    const shipmentId = new mongoose.Types.ObjectId();
    const draftId = new mongoose.Types.ObjectId();
    const initialShipment = {
      _id: shipmentId,
      shipmentDraftId: draftId,
      status: "LABEL_RECEIVED" as const,
      dpdShipmentId: "",
      swiftlineTrackingNumber: "SLCDEL000000999"
    };
    const claimedShipment = {
      ...initialShipment,
      status: "DPD_CREATING" as const,
      save: async () => undefined
    };
    const auditEntries: Array<{ action: string; metadata: Record<string, unknown> }> = [];

    try {
      env.ALS_ENABLED = false;
      mock.method(DpdShipment, "findById", () => ({ exec: async () => initialShipment }) as never);
      mock.method(LabelDocument, "find", () => ({ exec: async () => [] }) as never);
      mock.method(ShipmentDraft, "findById", () => ({
        exec: async () => ({ _id: draftId, consigneeEnteredAddress: { countryCode: "GB" } })
      }) as never);
      mock.method(DpdShipment, "findOneAndUpdate", (filter: unknown) => {
        assert.equal((filter as { status: string }).status, "LABEL_RECEIVED");
        return { exec: async () => claimedShipment } as never;
      });
      mock.method(AuditLog, "create", async (entry: unknown) => {
        const audit = entry as { action: string; metadata: Record<string, unknown> };
        auditEntries.push(audit);
        return {} as never;
      });

      await assert.rejects(
        generateDpdLabelForExistingShipment(String(shipmentId), new mongoose.Types.ObjectId()),
        (error: unknown) => error instanceof DpdLabelUnavailableError
      );

      assert.equal(claimedShipment.status, "LABEL_RECEIVED");
      assert.equal(auditEntries.at(-1)?.action, "DPD_REQUEST_FAILED");
      assert.equal(auditEntries.at(-1)?.metadata.status, "LABEL_RECEIVED");
    } finally {
      env.ALS_ENABLED = previousAlsEnabled;
      mock.restoreAll();
    }
  });

  test("keeps DPD_CREATED for an incomplete booking after a definite refusal", async () => {
    const previousAlsEnabled = env.ALS_ENABLED;
    const shipmentId = new mongoose.Types.ObjectId();
    const draftId = new mongoose.Types.ObjectId();
    const initialShipment = {
      _id: shipmentId,
      shipmentDraftId: draftId,
      status: "DPD_CREATED" as const,
      dpdShipmentId: "",
      swiftlineTrackingNumber: "SLCDEL000000998"
    };
    const claimedShipment = {
      ...initialShipment,
      status: "DPD_CREATING" as const,
      save: async () => undefined
    };

    try {
      env.ALS_ENABLED = false;
      mock.method(DpdShipment, "findById", () => ({ exec: async () => initialShipment }) as never);
      mock.method(LabelDocument, "find", () => ({ exec: async () => [] }) as never);
      mock.method(ShipmentDraft, "findById", () => ({
        exec: async () => ({ _id: draftId, consigneeEnteredAddress: { countryCode: "GB" } })
      }) as never);
      mock.method(DpdShipment, "findOneAndUpdate", () => ({ exec: async () => claimedShipment }) as never);
      mock.method(AuditLog, "create", async () => ({} as never));

      await assert.rejects(
        generateDpdLabelForExistingShipment(String(shipmentId), new mongoose.Types.ObjectId()),
        DpdLabelUnavailableError
      );

      assert.equal(claimedShipment.status, "DPD_CREATED");
    } finally {
      env.ALS_ENABLED = previousAlsEnabled;
      mock.restoreAll();
    }
  });
});
