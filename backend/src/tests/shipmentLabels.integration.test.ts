import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { SwiftlineStationCounter } from "../models/swiftlineStationCounter.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import {
  DpdLabelUnavailableError,
  createLabelForShipmentDraft,
  generateDpdLabelForExistingShipment,
  hasCompleteSwiftlineLabelSet,
  regenerateShipmentLabels
} from "../services/dpdShipment.service.js";
import {
  buildRevisedShipmentSnapshot,
  readShipmentBookingSnapshot
} from "../services/shipmentBookingSnapshot.service.js";
import {
  ShipmentDraftPolicyError,
  beginShipmentDraftBooking
} from "../services/shipmentDraftPolicy.service.js";
import { allocateSwiftlineTrackingNumber } from "../services/swiftlineTracking.service.js";
import { deleteObject } from "../services/storage/storage.service.js";

const databaseName = `sl_shipment_labels_${Date.now()}`;
const generatedKeys = new Set<string>();

// A complete Indian consignor plus mandatory KYC uploads, so booking drafts pass
// the consignor validation added alongside consignor capture. "234567890124"
// carries a valid Verhoeff check digit.
const consignorFixture = {
  companyName: "Delhi Exports Pvt Ltd",
  contactName: "Ravi Sharma",
  email: "ravi@delhiexports.example",
  mobileCountryCode: "+91",
  mobileNumber: "9876543210",
  aadhaarNumber: "234567890124",
  countryCode: "IN",
  countryName: "India",
  postcode: "110001",
  addressLine1: "12 Connaught Place",
  townOrCity: "New Delhi",
  county: "Delhi"
};

function kycDocumentFixture(type: "aadhaar" | "pan" | "other", documentLabel: string) {
  return {
    type,
    documentLabel,
    originalName: `${type}.pdf`,
    storageKey: `shipments/test-draft/kyc/${type}-${Date.now()}.pdf`,
    mimeType: "application/pdf",
    size: 1024,
    uploadedAt: new Date()
  };
}

const kycDocumentsFixture = {
  aadhaar: kycDocumentFixture("aadhaar", "Aadhaar Card"),
  pan: kycDocumentFixture("pan", "PAN Card")
};

/**
 * Refuses any request to the carrier for the duration of this suite.
 *
 * Every booking here passes `skipDpdLabel: true`, because ALS has no sandbox and
 * a request would be a real, chargeable DPD consignment. That has always been a
 * promise in a comment; this makes it structural. A regression that let a
 * booking reach ALS would otherwise pass silently on a developer machine with
 * working credentials - and bill the company for it.
 */
const attemptedCarrierCalls: string[] = [];
// Bound, because it is called back through a local reference rather than as a
// method of globalThis.
const realFetch = globalThis.fetch.bind(globalThis);

function isCarrierUrl(url: string) {
  const raw = (env.ALS_API_BASE_URL ?? "").trim();
  const base = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return (base !== "" && url.startsWith(base)) || url.includes("airportlinkservices");
}

before(async () => {
  globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isCarrierUrl(url)) {
      attemptedCarrierCalls.push(url);
      throw new Error(`A test tried to reach the carrier: ${url}`);
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;

  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName);
  await SwiftlineStationCounter.init();
});

after(async () => {
  globalThis.fetch = realFetch;
  // Reported as a failure rather than only thrown at the call site, so a booking
  // that swallows carrier errors cannot hide the attempt.
  assert.deepEqual(attemptedCarrierCalls, [], "no test may call the live carrier");

  // Labels are stored through the storage service, so they are removed through
  // it too- the test does not need to know which driver is active.
  for (const key of generatedKeys) {
    await deleteObject(key).catch(() => undefined);
  }
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_shipment_labels_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("Swiftline tracking sequence", () => {
  test("counts parcel labels without treating the carrier document as another parcel", () => {
    assert.equal(hasCompleteSwiftlineLabelSet({
      parcelCount: 2,
      labels: [
        { labelType: "SWIFTLINE" },
        { labelType: "SWIFTLINE" },
        { labelType: "DPD" }
      ]
    }), true);
    assert.equal(hasCompleteSwiftlineLabelSet({
      parcelCount: 2,
      labels: [{ labelType: "SWIFTLINE" }, { labelType: "DPD" }]
    }), false);
  });

  test("allocates unique daily numbers during concurrent bookings", async () => {
    const date = new Date("2026-07-20T06:30:00.000Z");
    const numbers = await Promise.all(Array.from({ length: 12 }, () => (
      allocateSwiftlineTrackingNumber({ stationCode: "DEL", date })
    )));

    assert.equal(new Set(numbers).size, 12);
    assert.deepEqual(
      numbers.map((value) => Number(value.slice(-3))).sort((left, right) => left - right),
      Array.from({ length: 12 }, (_, index) => index + 1)
    );
  });

  test("allows only one concurrent booking lock for the same draft", async () => {
    const draft = await ShipmentDraft.create({
      creationSource: "MANUAL",
      businessAccountId: new mongoose.Types.ObjectId(),
      branchId: new mongoose.Types.ObjectId(),
      sender: {},
      consigneeEnteredAddress: {
        companyName: "Example Retail Ltd",
        contactName: "Asha Patel",
        email: "asha@example.com",
        mobileCountryCode: "+44",
        mobileNumber: "7123456789",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London"
      },
      consigneeValidatedAddress: {
        companyName: "Example Retail Ltd",
        contactName: "Asha Patel",
        email: "asha@example.com",
        mobileCountryCode: "+44",
        mobileNumber: "7123456789",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London"
      },
      addressValidationStatus: "VALIDATED",
      parcelList: [{
        sequence: 1,
        weightKg: 7,
        lengthCm: 30,
        widthCm: 20,
        heightCm: 10,
        shipmentContentType: "PARCEL",
        contentsDescription: "Clothing"
      }],
      serviceType: "COURIER",
      status: "READY_FOR_DPD",
      bookingState: "EDITABLE",
      createdBy: new mongoose.Types.ObjectId()
    });
    const [firstView, secondView] = await Promise.all([
      ShipmentDraft.findById(draft._id).orFail().exec(),
      ShipmentDraft.findById(draft._id).orFail().exec()
    ]);

    const attempts = await Promise.allSettled([
      beginShipmentDraftBooking({ draft: firstView, bookingAttemptId: "attempt-one" }),
      beginShipmentDraftBooking({ draft: secondView, bookingAttemptId: "attempt-two" })
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof ShipmentDraftPolicyError);

    const locked = await ShipmentDraft.findById(draft._id).orFail().lean().exec();
    assert.equal(locked.bookingState, "BOOKING");
    assert.ok(["attempt-one", "attempt-two"].includes(locked.bookingAttemptId));
    assert.ok(locked.lockedAt);
  });

  test("creates shipment labels for BA-2026-800823 / Drifter Co", async () => {
    const userId = new mongoose.Types.ObjectId();
    const branch = await Branch.create({
      name: "Drifter Co Branch",
      code: `DR-${Date.now()}`,
      labelCode: "DRF",
      status: "ACTIVE",
      gstin: "09BIQPK8904E1ZW",
      invoiceSacCode: "996812",
      baseCurrency: "INR",
      address: {
        countryCode: "IN",
        countryName: "India",
        city: "Delhi",
        stateOrProvince: "Delhi",
        postalCode: "110001",
        address: "Swiftline Test Branch"
      },
      contact: { email: "branch@driftercono.example", phone: "+91 9999999999" },
      operations: { supportedServices: [], shipmentCoverage: ["INTERNATIONAL"], operatingCountries: ["GB"], workingDays: [] },
      createdBy: userId
    });

    const account = await BusinessAccount.create({
      accountId: "BA-2026-800823",
      status: "active",
      rateCardBand: "BAND_A",
      contact: {
        title: "mr.",
        firstName: "Drifter",
        lastName: "Cono",
        email: "contact@driftercono.example",
        mobileType: "mobile",
        countryCode: "+91",
        mobileNumber: "9000000000",
        jobTitle: "Owner",
        department: "Operations",
        shipmentTypes: ["international_courier"]
      },
      company: {
        registrationCountry: "India",
        registrationId: `DRIFTER-${Date.now()}`,
        companyType: "pvt_ltd",
        companyName: "Drifter Co",
        registeredAddress: "Drifter Co HQ",
        city: "Delhi",
        stateOrProvince: "Delhi",
        postalCode: "110002",
        addressCountry: "India",
        gstin: "09BIQPK8904E1ZD",
        operatingCountries: ["United Kingdom"],
        industry: "Trading",
        monthlyShipmentVolume: "1-10",
        requestedCreditLimit: { currency: "INR", amount: 0 }
      },
      kycReview: { overallStatus: "verified", checks: {} },
      assignedBranch: branch._id,
      createdBy: userId
    });

    await CountryRateCard.create({
      band: "BAND_A",
      countryCode: "GB",
      countryName: "United Kingdom",
      service: "COURIER",
      fromKg: 0.01,
      toKg: 25,
      chargesPerKg: 200,
      maxBoxKg: 25,
      createdBy: userId
    });

    const draft = await ShipmentDraft.create({
      creationSource: "MANUAL",
      businessAccountId: account._id,
      branchId: branch._id,
      sender: { name: branch.name, code: branch.code },
      consignorAddress: consignorFixture,
      kycDocuments: kycDocumentsFixture,
      consigneeEnteredAddress: {
        companyName: "Drifter Co",
        contactName: "Rohit Kapoor",
        email: "rohit@driftercono.example",
        mobileCountryCode: "+91",
        mobileNumber: "9876501234",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 1AA",
        addressLine1: "1 Drifter House",
        townOrCity: "London",
        county: "Greater London"
      },
      consigneeValidatedAddress: {
        companyName: "Drifter Co",
        contactName: "Rohit Kapoor",
        email: "rohit@driftercono.example",
        mobileCountryCode: "+91",
        mobileNumber: "9876501234",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 1AA",
        addressLine1: "1 Drifter House",
        townOrCity: "London",
        county: "Greater London"
      },
      addressValidationStatus: "VALIDATED",
      addressValidationResult: { outcome: "VALID" },
      parcelList: [{
        sequence: 1,
        weightKg: 5,
        lengthCm: 30,
        widthCm: 20,
        heightCm: 10,
        shipmentContentType: "PARCEL",
        items: [{ description: "Books", hsnCode: "49019900", unitType: "Pkt", quantity: 1, unitRate: 500 }],
        contentsDescription: "Books",
        shipmentReference1: "DRIFTER-BOX-1"
      }],
      serviceType: "COURIER",
      status: "READY_FOR_DPD",
      bookingState: "EDITABLE",
      createdBy: userId
    });

    const result = await createLabelForShipmentDraft(String(draft._id), userId, {
      actor: "admin",
      paymentSource: "TEST",
      // Never call the carrier from a test: ALS has no sandbox, so a booking
      // here would be a real, chargeable DPD consignment. The carrier path is
      // covered against stubbed responses in alsLabel.test.ts.
      skipDpdLabel: true
    });

    result.labels.forEach((label) => generatedKeys.add(label.storageKey));
    // One Swiftline label per parcel and nothing else: no carrier label is
    // requested, generated or stored.
    assert.equal(result.labels.length, 1);
    assert.ok(result.labels.every((label) => label.labelType === "SWIFTLINE"));
    assert.ok(result.labels.every((label) => label.labelSize === "SQUARE"));
    assert.ok(result.dpdShipment._id);
    assert.ok(result.labels.some((label) => label.parcelNumber.startsWith("SLC")));
  });

  test("books two parcels once and keeps charge, invoice and both labels aligned", async () => {
    const userId = new mongoose.Types.ObjectId();
    const branch = await Branch.create({
      name: "Shipment Booking Test Branch",
      code: `SBT-${Date.now()}`,
      labelCode: "DL",
      status: "ACTIVE",
      gstin: "09BIQPK8904E1ZW",
      invoiceSacCode: "996812",
      baseCurrency: "INR",
      address: {
        countryCode: "IN",
        countryName: "India",
        city: "Delhi",
        stateOrProvince: "Delhi",
        postalCode: "110001",
        address: "Swiftline Test Branch"
      },
      contact: { email: "branch@example.test", phone: "+91 9999999999" },
      operations: { supportedServices: [], shipmentCoverage: ["INTERNATIONAL"], operatingCountries: ["GB"], workingDays: [] },
      createdBy: userId
    });
    const account = await BusinessAccount.create({
      accountId: `BOOKING-TEST-${Date.now()}`,
      status: "active",
      rateCardBand: "BAND_A",
      contact: {
        title: "mr.", firstName: "Booking", lastName: "Owner",
        email: `booking-${Date.now()}@example.test`, mobileType: "mobile",
        // Unique like the email above: live accounts carry a unique index on
        // (countryCode, mobileNumber), so a shared number collides with the
        // other account this suite creates.
        countryCode: "+91", mobileNumber: `9${String(Date.now()).slice(-9)}`, jobTitle: "Owner",
        department: "Operations", shipmentTypes: ["international_courier"]
      },
      company: {
        registrationCountry: "India", registrationId: "BOOKING123", companyType: "pvt_ltd",
        companyName: "Booking Test Company", registeredAddress: "Customer Address",
        city: "Delhi", stateOrProvince: "Delhi", postalCode: "110002",
        addressCountry: "India", gstin: "09BIQPK8904E1ZD", operatingCountries: ["United Kingdom"],
        industry: "Testing", monthlyShipmentVolume: "1-10",
        requestedCreditLimit: { currency: "INR", amount: 0 }
      },
      kycReview: { overallStatus: "verified", checks: {} },
      assignedBranch: branch._id,
      createdBy: userId
    });
    await CountryRateCard.create({
      band: "BAND_A",
      countryCode: "GB",
      countryName: "United Kingdom",
      service: "COURIER",
      fromKg: 0.01,
      toKg: 25,
      chargesPerKg: 200,
      maxBoxKg: 25,
      createdBy: userId
    });
    const draft = await ShipmentDraft.create({
      creationSource: "MANUAL",
      businessAccountId: account._id,
      branchId: branch._id,
      sender: { name: branch.name, code: branch.code },
      consignorAddress: consignorFixture,
      kycDocuments: kycDocumentsFixture,
      consigneeEnteredAddress: {
        companyName: "Example Retail Ltd",
        contactName: "Asha Patel",
        email: "asha@example.com",
        mobileCountryCode: "+44",
        mobileNumber: "7123456789",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London",
        county: "Greater London"
      },
      consigneeValidatedAddress: {
        companyName: "Example Retail Ltd",
        contactName: "Asha Patel",
        email: "asha@example.com",
        mobileCountryCode: "+44",
        mobileNumber: "7123456789",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London",
        county: "Greater London"
      },
      addressValidationStatus: "VALIDATED",
      addressValidationResult: { outcome: "VALID" },
      parcelList: [
        // Booking requires an HS code, quantity and unit rate per declared item,
        // since all three print on the customs (shipment) invoice.
        { sequence: 1, weightKg: 7, lengthCm: 30, widthCm: 20, heightCm: 10, shipmentContentType: "PARCEL", items: [{ description: "Clothing", hsnCode: "62034200", unitType: "Pkt", quantity: 4, unitRate: 250 }], contentsDescription: "Clothing", shipmentReference1: "BOX-A" },
        { sequence: 2, weightKg: 11, lengthCm: 40, widthCm: 30, heightCm: 20, shipmentContentType: "PARCEL", items: [{ description: "Shoes", hsnCode: "64039900", unitType: "Pkt", quantity: 2, unitRate: 900 }], contentsDescription: "Shoes", shipmentReference1: "BOX-B" }
      ],
      serviceType: "COURIER",
      status: "READY_FOR_DPD",
      bookingState: "EDITABLE",
      createdBy: userId
    });

    const first = await createLabelForShipmentDraft(String(draft._id), userId, {
      actor: "admin",
      paymentSource: "TEST",
      // Never call the carrier from a test: ALS has no sandbox, so a booking
      // here would be a real, chargeable DPD consignment. The carrier path is
      // covered against stubbed responses in alsLabel.test.ts.
      skipDpdLabel: true
    });
    first.labels.forEach((label) => generatedKeys.add(label.storageKey));
    assert.equal(first.reused, false);
    assert.equal(first.labels.length, 2);
    assert.ok(first.labels.every((label) => label.labelType === "SWIFTLINE"));
    assert.ok(first.labels.every((label) => label.labelSize === "A4"));
    assert.equal(
      new Set(first.labels.map((label) => label.storageKey)).size,
      1,
      "all parcel records should open the same combined printable PDF"
    );
    assert.equal(first.shipmentInvoice.taxableValueMinor, 305085);
    assert.equal(first.shipmentInvoice.totalTaxAmountMinor, 54915);
    assert.equal(first.shipmentInvoice.totalAmountMinor, 360000);
    const invoicePricing = first.shipmentInvoice.pricingSnapshot as { parcels: unknown[] };
    assert.equal(invoicePricing.parcels.length, 2);

    const snapshot = first.dpdShipment.bookingSnapshot as {
      parcels: Array<{ actualWeightKg: number; carrierParcelNumber: string; swiftlineParcelNumber: string }>;
      payment: { totalAmountMinor: number };
      pricing: {
        parcels: Array<Record<string, unknown>>;
        baseAmount: number;
        gstAmount: number;
        totalAmount: number;
        missingRate: boolean;
        exceedsMaxBoxKg: boolean;
        gstRate: number;
      };
    };
    assert.deepEqual(snapshot.parcels.map((parcel) => parcel.actualWeightKg), [7, 11]);
    assert.equal(snapshot.payment.totalAmountMinor, first.shipmentInvoice.totalAmountMinor);
    // One Swiftline label per parcel. No carrier label is produced, so
    // carrierParcelNumber stays blank on the snapshot and contributes nothing.
    assert.deepEqual(
      first.labels.map((label) => label.parcelNumber).sort(),
      snapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber).sort()
    );
    assert.ok(
      snapshot.parcels.every((parcel) => parcel.carrierParcelNumber === ""),
      "no carrier books these shipments, so no parcel carries a carrier number"
    );

    const second = await createLabelForShipmentDraft(String(draft._id), userId, {
      actor: "admin",
      paymentSource: "TEST",
      // Never call the carrier from a test: ALS has no sandbox, so a booking
      // here would be a real, chargeable DPD consignment. The carrier path is
      // covered against stubbed responses in alsLabel.test.ts.
      skipDpdLabel: true
    });
    assert.equal(second.reused, true);
    assert.equal(String(second.dpdShipment._id), String(first.dpdShipment._id));
    assert.equal(second.shipmentInvoice.invoiceNumber, first.shipmentInvoice.invoiceNumber);
    assert.equal(await DpdShipment.countDocuments({ shipmentDraftId: draft._id }), 1);
    assert.equal(await ShipmentInvoice.countDocuments({ shipmentDraftId: draft._id }), 1);
    // Two parcels, one Swiftline label each- re-booking reuses them rather than
    // producing a second set.
    assert.equal(await LabelDocument.countDocuments({ dpdShipmentId: first.dpdShipment._id }), 2);

    const lockedDraft = await ShipmentDraft.findById(draft._id).orFail().lean().exec();
    assert.equal(lockedDraft.bookingState, "BOOKED");

    const swiftlineDraft = await ShipmentDraft.create({
      creationSource: "MANUAL",
      businessAccountId: account._id,
      branchId: branch._id,
      sender: draft.sender,
      consignorAddress: consignorFixture,
      kycDocuments: kycDocumentsFixture,
      consigneeEnteredAddress: draft.consigneeEnteredAddress,
      consigneeValidatedAddress: draft.consigneeValidatedAddress,
      addressValidationStatus: "VALIDATED",
      addressValidationResult: { outcome: "VALID" },
      parcelList: draft.parcelList,
      serviceType: "COURIER",
      status: "READY_FOR_DPD",
      bookingState: "EDITABLE",
      createdBy: userId
    });
    const swiftlineOnly = await createLabelForShipmentDraft(String(swiftlineDraft._id), userId, {
      actor: "admin",
      paymentSource: "TEST",
      // Never call the carrier from a test: ALS has no sandbox, so a booking
      // here would be a real, chargeable DPD consignment. The carrier path is
      // covered against stubbed responses in alsLabel.test.ts.
      skipDpdLabel: true
    });
    swiftlineOnly.labels.forEach((label) => generatedKeys.add(label.storageKey));
    // No carrier is called, so the booking carries no carrier identifiers.
    assert.equal(swiftlineOnly.dpdShipment.dpdShipmentId, "");
    assert.deepEqual(swiftlineOnly.dpdShipment.parcelNumbers, []);
    assert.equal(swiftlineOnly.labels.length, 2);
    assert.ok(swiftlineOnly.labels.every((label) => label.labelType === "SWIFTLINE"));
    assert.equal(swiftlineOnly.shipmentInvoice.totalAmountMinor, first.shipmentInvoice.totalAmountMinor);

    const swiftlineReuse = await createLabelForShipmentDraft(String(swiftlineDraft._id), userId, {
      actor: "admin",
      paymentSource: "TEST",
      // Never call the carrier from a test: ALS has no sandbox, so a booking
      // here would be a real, chargeable DPD consignment. The carrier path is
      // covered against stubbed responses in alsLabel.test.ts.
      skipDpdLabel: true
    });
    assert.equal(swiftlineReuse.reused, true);
    assert.equal(swiftlineReuse.labels.length, 2);
    assert.ok(swiftlineReuse.labels.every((label) => label.labelType === "SWIFTLINE"));

    const amendedDraft = await ShipmentDraft.findById(draft._id).orFail().exec();
    amendedDraft.parcelList = amendedDraft.parcelList.map((parcel) => ({
      ...parcel,
      weightKg: parcel.weightKg + 1
    }));
    amendedDraft.bookingState = "REVIEW_REQUIRED";
    await amendedDraft.save();

    const originalSnapshot = readShipmentBookingSnapshot(first.dpdShipment.bookingSnapshot);
    assert.ok(originalSnapshot);
    const revisedPricing = {
      ...originalSnapshot.pricing,
      baseAmount: 3389.83,
      gstAmount: 610.17,
      totalAmount: 4000
    };
    const revisedSnapshot = buildRevisedShipmentSnapshot({
      previousSnapshot: originalSnapshot,
      draft: amendedDraft,
      pricing: revisedPricing,
      advanceAmountMinor: 0,
      creditAmountMinor: 400000
    });
    const amendedShipment = await DpdShipment.findById(first.dpdShipment._id).orFail().exec();
    amendedShipment.currentShipmentSnapshot = revisedSnapshot as unknown as Record<string, unknown>;
    amendedShipment.snapshotRevision = 2;
    amendedShipment.status = "DPD_CREATED";
    await amendedShipment.save();

    const revisedLabels = await regenerateShipmentLabels(
      amendedShipment._id as mongoose.Types.ObjectId,
      userId
    );
    revisedLabels.forEach((label) => generatedKeys.add(label.storageKey));
    assert.equal(revisedLabels.length, 2);
    assert.ok(revisedLabels.every((label) => label.labelVersion === 2));
    assert.equal(new Set(revisedLabels.map((label) => label.storageKey)).size, 1);
    assert.equal(await LabelDocument.countDocuments({ dpdShipmentId: amendedShipment._id }), 2);
    assert.deepEqual(
      (readShipmentBookingSnapshot(amendedShipment.bookingSnapshot)?.parcels ?? [])
        .map((parcel) => parcel.actualWeightKg),
      [7, 11]
    );
    assert.deepEqual(revisedSnapshot.parcels.map((parcel) => parcel.actualWeightKg), [8, 12]);
    assert.equal((await ShipmentDraft.findById(draft._id).orFail().lean().exec()).bookingState, "BOOKED");
  });

  test("does not duplicate an existing booking when DPD label generation is unavailable", async () => {
    const userId = new mongoose.Types.ObjectId();
    const draft = await ShipmentDraft.create({
      creationSource: "MANUAL",
      businessAccountId: new mongoose.Types.ObjectId(),
      branchId: new mongoose.Types.ObjectId(),
      consigneeEnteredAddress: {
        companyName: "Existing Booking Customer",
        contactName: "Asha Patel",
        email: "asha@example.test",
        mobileCountryCode: "+44",
        mobileNumber: "7123456789",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London"
      },
      parcelList: [{
        sequence: 1,
        weightKg: 6,
        lengthCm: 30,
        widthCm: 20,
        heightCm: 10,
        shipmentContentType: "PARCEL",
        contentsDescription: "Documents"
      }],
      status: "READY_FOR_DPD",
      bookingState: "BOOKED",
      createdBy: userId
    });
    const booking = await DpdShipment.create({
      shipmentDraftId: draft._id,
      idempotencyKey: `existing-booking-${Date.now()}`,
      serviceCode: "DPD UK NEXTDAY",
      bookingSnapshot: {},
      currentShipmentSnapshot: {},
      requestSnapshot: {},
      responseSnapshot: {},
      paymentSource: "TEST",
      swiftlineTrackingNumber: "SLCDEL020926901",
      parcelNumbers: [],
      status: "DPD_CREATED"
    });

    const previousAlsEnabled = env.ALS_ENABLED;
    (env as { ALS_ENABLED: boolean }).ALS_ENABLED = false;
    try {
      await assert.rejects(
        generateDpdLabelForExistingShipment(String(booking._id), userId),
        (error: unknown) => {
          assert.ok(error instanceof DpdLabelUnavailableError);
          assert.equal(error.statusCode, 503);
          return true;
        }
      );
    } finally {
      (env as { ALS_ENABLED: boolean }).ALS_ENABLED = previousAlsEnabled;
    }

    assert.equal(await DpdShipment.countDocuments({ shipmentDraftId: draft._id }), 1);
    assert.equal(await LabelDocument.countDocuments({ dpdShipmentId: booking._id }), 0);
    assert.equal((await DpdShipment.findById(booking._id).orFail().lean().exec()).status, "DPD_CREATED");
  });
});
