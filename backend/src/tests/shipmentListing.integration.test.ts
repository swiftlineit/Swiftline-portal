import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { listDpdShipments as listDpdShipmentsController } from "../controllers/dpdShipment.controller.js";
import {
  allShipmentStatuses,
  listBookedShipments
} from "../services/shipmentListing.service.js";

const databaseName = `sl_ship_list_${Date.now()}`;
const userId = new mongoose.Types.ObjectId();

let branchId: mongoose.Types.ObjectId;
let accountOneId: mongoose.Types.ObjectId;
let accountTwoId: mongoose.Types.ObjectId;

async function createBranch() {
  const branch = await Branch.create({
    name: "Listing Test Branch",
    code: `LT${Math.floor(1000 + Math.random() * 8999)}`,
    status: "ACTIVE",
    address: { addressLine1: "1 Listing Road", city: "Delhi", state: "Delhi", postalCode: "110001", country: "India" },
    contact: { email: "listing@swiftline.test", countryCode: "+91", phone: "9000000000" },
    createdBy: userId
  });
  return branch._id as mongoose.Types.ObjectId;
}

async function createAccount(suffix: string) {
  const account = await BusinessAccount.create({
    accountId: `BA-LIST-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    status: "approved",
    contact: {
      firstName: "Listing", lastName: suffix, email: `listing-${suffix}-${Date.now()}@example.com`,
      mobileType: "mobile", countryCode: "+91",
      mobileNumber: String(9100000000 + Math.floor(Math.random() * 800000))
    },
    company: { registrationCountry: "India", companyName: `Listing ${suffix} Ltd`, operatingCountries: ["India"] },
    assignedBranch: branchId,
    createdBy: userId
  });
  return account._id as mongoose.Types.ObjectId;
}

async function createBookedDraft(
  accountId: mongoose.Types.ObjectId,
  reference: string,
  creationSource: "MANUAL" | "PUBLIC_ONLINE" = "MANUAL"
) {
  const draft = await ShipmentDraft.create({
    creationSource,
    businessAccountId: accountId,
    branchId,
    consigneeEnteredAddress: {
      companyName: `Consignee ${reference}`,
      contactName: "Test Consignee",
      countryCode: "GB",
      countryName: "United Kingdom",
      postcode: "SW1A 1AA",
      addressLine1: "1 Test Street",
      townOrCity: "London"
    },
    parcelList: [{ sequence: 1, weightKg: 2, shipmentContentType: "PARCEL", contentsDescription: "Test goods", shipmentReference1: reference }],
    serviceType: "COURIER",
    serviceCode: "TEST",
    status: "NEEDS_REVIEW",
    allocatedTrackingNumber: `SL${Date.now()}${Math.floor(Math.random() * 1000)}`,
    createdBy: userId
  });
  const booking = await DpdShipment.create({
    shipmentDraftId: draft._id,
    idempotencyKey: `list-${Date.now()}-${Math.random()}`,
    serviceCode: "TEST",
    status: "LABEL_RECEIVED",
    swiftlineTrackingNumber: `SL-LIST-${reference}`
  });
  return { draft, booking };
}

async function addEvent(draftId: mongoose.Types.ObjectId, bookingId: mongoose.Types.ObjectId, status: "PARCEL_COLLECTED" | "ON_HOLD" | "DELIVERED", eventAt: Date) {
  await ShipmentEvent.create({
    shipmentDraftId: draftId,
    dpdShipmentId: bookingId,
    status,
    holdReason: status === "ON_HOLD" ? "missing_documents" : null,
    customerVisible: true,
    createdBy: userId,
    eventAt
  });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName, "Listing tests must use an isolated database.");
  await Promise.all([
    Branch.init(),
    BusinessAccount.init(),
    ShipmentDraft.init(),
    DpdShipment.init(),
    LabelDocument.init(),
    ShipmentEvent.init()
  ]);
  branchId = await createBranch();
  [accountOneId, accountTwoId] = await Promise.all([createAccount("One"), createAccount("Two")]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_ship_list_"), "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("shipment listing read path", () => {
  test("keeps account scope, latest status, attention and page clamping unchanged", async () => {
    const first = await createBookedDraft(accountOneId, "ACCOUNT-ONE");
    const other = await createBookedDraft(accountTwoId, "ACCOUNT-TWO");
    const now = Date.now();

    await addEvent(first.draft._id, first.booking._id, "PARCEL_COLLECTED", new Date(now - 10_000));
    await addEvent(first.draft._id, first.booking._id, "ON_HOLD", new Date(now));
    await addEvent(other.draft._id, other.booking._id, "DELIVERED", new Date(now));

    const base = {
      page: 1,
      limit: 20,
      actorRole: "admin" as const,
      status: "",
      search: "",
      sort: "",
      bookingStatuses: allShipmentStatuses,
      businessAccountIds: [accountOneId]
    };
    const scoped = await listBookedShipments(base);
    assert.equal(scoped.pagination.total, 1);
    assert.deepEqual(scoped.shipments.map((shipment) => shipment.id), [String(first.draft._id)]);

    const attention = await listBookedShipments({ ...base, attention: true });
    assert.equal(attention.pagination.total, 1);
    assert.equal(attention.shipments[0]?.status, "ON_HOLD");

    const inTransit = await listBookedShipments({ ...base, status: "IN_TRANSIT" });
    assert.equal(inTransit.pagination.total, 0, "the newest hold must not be hidden by an older in-transit event");

    const clamped = await listBookedShipments({ ...base, page: 99, limit: 1 });
    assert.equal(clamped.pagination.page, 1);
    assert.equal(clamped.pagination.total, 1);
  });

  test("reports route-aware DPD label status to staff without exposing it to clients", async () => {
    const available = await createBookedDraft(accountOneId, "DPD-AVAILABLE");
    const missing = await createBookedDraft(accountOneId, "DPD-MISSING");
    const notApplicable = await createBookedDraft(accountOneId, "DPD-NA");

    await Promise.all([
      LabelDocument.create({
        dpdShipmentId: available.booking._id,
        parcelNumber: "DPD-AVAILABLE",
        labelType: "DPD",
        format: "PDF",
        labelSize: "A4",
        storageKey: "tests/dpd-available.pdf",
        fileChecksum: "dpd-available-checksum"
      }),
      ShipmentDraft.updateOne(
        { _id: notApplicable.draft._id },
        {
          $set: {
            "consigneeEnteredAddress.countryCode": "US",
            "consigneeEnteredAddress.countryName": "United States"
          }
        }
      ).exec()
    ]);

    const base = {
      page: 1,
      limit: 50,
      actorRole: "admin" as const,
      status: "",
      search: "",
      sort: "",
      bookingStatuses: allShipmentStatuses,
      businessAccountIds: [accountOneId]
    };
    const staffResult = await listBookedShipments(base);
    const staffById = new Map(staffResult.shipments.map((shipment) => [shipment.id, shipment]));

    assert.equal(staffById.get(String(available.draft._id))?.dpdLabelStatus, "AVAILABLE");
    assert.equal(staffById.get(String(missing.draft._id))?.dpdLabelStatus, "NOT_AVAILABLE");
    assert.equal(staffById.get(String(notApplicable.draft._id))?.dpdLabelStatus, "NOT_APPLICABLE");

    await LabelDocument.updateOne(
      { dpdShipmentId: available.booking._id, labelType: "DPD" },
      { $set: { voidedAt: new Date() } }
    ).exec();
    const afterVoid = await listBookedShipments(base);
    assert.equal(
      afterVoid.shipments.find((shipment) => shipment.id === String(available.draft._id))?.dpdLabelStatus,
      "NOT_AVAILABLE"
    );

    const clientResult = await listBookedShipments({ ...base, actorRole: "client" });
    assert.ok(clientResult.shipments.length > 0);
    assert.ok(clientResult.shipments.every((shipment) => !("dpdLabelStatus" in shipment)));
  });

  test("filters staff shipments by public online creation source", async () => {
    const publicBooking = await createBookedDraft(accountOneId, "PUBLIC-SOURCE", "PUBLIC_ONLINE");
    await createBookedDraft(accountOneId, "MANUAL-SOURCE");

    const result = await listBookedShipments({
      page: 1,
      limit: 50,
      actorRole: "admin",
      status: "",
      search: "",
      sort: "",
      bookingStatuses: allShipmentStatuses,
      businessAccountIds: [accountOneId],
      creationSource: "PUBLIC_ONLINE"
    });

    assert.ok(result.shipments.length > 0);
    assert.ok(result.shipments.every((shipment) => shipment.creationSource === "PUBLIC_ONLINE"));
    assert.ok(result.shipments.some((shipment) => shipment.id === String(publicBooking.draft._id)));
  });

  test("dashboard summary mode preserves the visible shipment fields without loading detail collections", async () => {
    const created = await createBookedDraft(accountOneId, "SUMMARY");
    await addEvent(created.draft._id, created.booking._id, "DELIVERED", new Date());
    await DpdShipment.updateOne({ _id: created.booking._id }, {
      $set: {
        bookingSnapshot: { consignee: { companyName: "SNAPSHOT CONSIGNEE", townOrCity: "Snapshot City", postcode: "SW2 2AA" } },
        currentShipmentSnapshot: {},
        snapshotRevision: 1
      }
    }).exec();
    await ShipmentInvoice.collection.insertOne({
      shipmentDraftId: created.draft._id,
      invoiceNumber: `SL-LIST-${Date.now()}`,
      currency: "INR",
      totalAmountMinor: 100,
      status: "ISSUED",
      revision: 1
    });

    let statusCode = 0;
    type SummaryBody = { success: boolean; shipments: Array<{
      dpdShipment: { swiftlineTrackingNumber: string };
      shipmentDraft: { consigneeName: string } | null;
      currentEvent: { status: string } | null;
      labels: unknown[];
      events: unknown[];
      parcelActivities: unknown[];
    }> };
    let body: SummaryBody | undefined;
    const response = {
      status(code: number) {
        statusCode = code;
        return response;
      },
      json(payload: SummaryBody) {
        body = payload;
        return response;
      }
    };

    await listDpdShipmentsController(
      { query: { limit: "10", summary: "1" } } as never,
      response as never
    );

    assert.equal(statusCode, 200);
    const received = body as SummaryBody;
    assert.equal(received.success, true);
    const summary = received.shipments.find((item) => item.dpdShipment.swiftlineTrackingNumber === "SL-LIST-SUMMARY");
    assert.ok(summary);
    assert.equal(summary.shipmentDraft?.consigneeName, "SNAPSHOT CONSIGNEE");
    assert.equal(summary.currentEvent?.status, "DELIVERED");
    assert.deepEqual(summary.labels, []);
    assert.deepEqual(summary.events, []);
    assert.deepEqual(summary.parcelActivities, []);
  });
});
