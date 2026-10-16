import assert from "node:assert/strict";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { DriverProfile } from "../models/driverProfile.model.js";
import { PickupAttempt } from "../models/pickupAttempt.model.js";
import { PickupCourierAddress } from "../models/pickupCourierAddress.model.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { matchesDeclaredType } from "../services/storage/fileSignature.js";
import { parsePickupDateInIndia, parsePickupDateTimeInIndia, pickupAddressFingerprint, pickupArrivalWindowBounds } from "../services/pickup.service.js";

describe("pickup request invariants", () => {
  test("courier contact numbers contain digits only", async () => {
    const userId = new mongoose.Types.ObjectId();
    const profile = new PickupCourierAddress({
      branchId: new mongoose.Types.ObjectId(), companyName: "Test Courier", companyKey: "TEST COURIER",
      address: { addressLine1: "12 Cargo Road", townOrCity: "Delhi", postcode: "110001", countryCode: "IN" },
      contact: { name: "Courier Desk", phone: "91123ABC4567" }, createdBy: userId, updatedBy: userId
    });
    await assert.rejects(() => profile.validate(), /contact\.phone/);
    profile.contact.phone = "911234567890";
    await profile.validate();
  });

  test("normalizes equivalent pickup addresses to one selection fingerprint", () => {
    const first = pickupAddressFingerprint({
      countryCode: "in",
      postcode: "110001",
      addressLine1: " 12   Cargo Road ",
      townOrCity: "new delhi"
    });
    const second = pickupAddressFingerprint({
      countryCode: "IN",
      postcode: "110001",
      addressLine1: "12 CARGO ROAD",
      townOrCity: "NEW DELHI"
    });

    assert.equal(first, second);
  });

  test("accepts direct-contractor and internal driver identities", async () => {
    const userId = new mongoose.Types.ObjectId();
    await new DriverProfile({ userId, deliverySubrole: "DRIVER", engagementType: "DIRECT_CONTRACTOR", status: "INVITED", createdBy: userId }).validate();
    await new DriverProfile({ userId: new mongoose.Types.ObjectId(), deliverySubrole: "SUPERVISOR", engagementType: "INTERNAL", status: "INVITED", createdBy: userId }).validate();
  });

  test("rejects GPS evidence outside valid coordinate bounds", async () => {
    const attempt = new PickupAttempt({
      pickupRequestId: new mongoose.Types.ObjectId(),
      sequence: 1,
      status: "ARRIVED",
      scheduledWindow: { startAt: new Date("2026-08-06T08:00:00.000Z"), endAt: new Date("2026-08-06T10:00:00.000Z"), timezone: "Asia/Kolkata" },
      arrivalLocation: { latitude: 120, longitude: 77.2, accuracy: 10, capturedAt: new Date() }
    });

    await assert.rejects(() => attempt.validate(), /latitude/);
  });

  test("supports a pickup with manual volume and no linked shipment rows", async () => {
    const userId = new mongoose.Types.ObjectId();
    const pickup = new PickupRequest({
      requestNumber: "SLPTEST260101001",
      businessAccountId: new mongoose.Types.ObjectId(),
      branchId: new mongoose.Types.ObjectId(),
      requestedBy: userId,
      source: "CLIENT_PORTAL",
      status: "REQUESTED",
      addressFingerprint: "IN|110001|12 CARGO ROAD||NEW DELHI|",
      pickupAddress: { addressLine1: "12 Cargo Road", townOrCity: "New Delhi", postcode: "110001", countryCode: "IN" },
      pickupContact: { name: "Operations Contact", phone: "+919876543210" },
      requestedWindow: { startAt: new Date("2026-11-01T04:30:00.000Z"), endAt: new Date("2026-11-01T06:30:00.000Z"), timezone: "Asia/Kolkata" },
      dispatchAt: new Date("2026-11-01T04:30:00.000Z"),
      expectedDelhiArrival: { date: new Date("2026-11-01T18:30:00.000Z"), window: "MORNING", timezone: "Asia/Kolkata" },
      transportCompany: "DHL",
      shipmentCount: 0,
      totalBoxes: 4,
      parcelCount: 0,
      totalWeightKg: 18.5
    });

    await pickup.validate();
    assert.equal(pickup.status, "REQUESTED");
    assert.equal(pickup.shipmentCount, 0);
    assert.equal(pickup.totalBoxes, 4);
  });

  test("labels the terminal verified hub receipt status", async () => {
    const userId = new mongoose.Types.ObjectId();
    const pickup = new PickupRequest({
      requestNumber: "SLPTEST260101002",
      businessAccountId: new mongoose.Types.ObjectId(),
      branchId: new mongoose.Types.ObjectId(),
      requestedBy: userId,
      source: "CLIENT_PORTAL",
      status: "RECEIVED_AT_DELHI_HUB",
      addressFingerprint: "IN|110001|12 CARGO ROAD||NEW DELHI|",
      pickupAddress: { addressLine1: "12 Cargo Road", townOrCity: "New Delhi", postcode: "110001", countryCode: "IN" },
      pickupContact: { name: "Operations Contact", phone: "+919876543210" },
      requestedWindow: { startAt: new Date("2026-11-01T04:30:00.000Z"), endAt: new Date("2026-11-01T06:30:00.000Z"), timezone: "Asia/Kolkata" },
      shipmentCount: 0,
      totalBoxes: 1,
      parcelCount: 0,
      totalWeightKg: 1,
      receivedAtDelhiHubAt: new Date()
    });

    await pickup.validate();
    assert.equal(pickup.status, "RECEIVED_AT_DELHI_HUB");
  });

  test("uses India time for dispatch and arrival input and validates calendar dates", () => {
    assert.equal(parsePickupDateTimeInIndia("2026-10-13", "06:00").toISOString(), "2026-10-13T00:30:00.000Z");
    assert.equal(parsePickupDateInIndia("2026-10-13").toISOString(), "2026-10-12T18:30:00.000Z");
    assert.throws(() => parsePickupDateInIndia("2026-02-30"), /valid Delhi arrival date/);
    assert.throws(() => parsePickupDateTimeInIndia("2026-10-13", "25:00"), /valid date and time/);
  });

  test("keeps the specified Delhi arrival window ranges", () => {
    assert.deepEqual(pickupArrivalWindowBounds("MORNING"), { startMinute: 360, endMinute: 720 });
    assert.deepEqual(pickupArrivalWindowBounds("AFTERNOON"), { startMinute: 720, endMinute: 1020 });
    assert.deepEqual(pickupArrivalWindowBounds("EVENING"), { startMinute: 1020, endMinute: 1320 });
    assert.equal(pickupArrivalWindowBounds("EXACT"), null);
  });

  test("accepts only matching safe document signatures", () => {
    assert.equal(matchesDeclaredType(Buffer.from("%PDF-1.7"), "application/pdf"), true);
    assert.equal(matchesDeclaredType(Buffer.from("not a pdf"), "application/pdf"), false);
    assert.equal(matchesDeclaredType(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"), true);
  });
});
