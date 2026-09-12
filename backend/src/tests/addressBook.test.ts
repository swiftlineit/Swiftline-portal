import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import {
  createAddressBookEntry,
  deleteAddressBookEntry,
  duplicateAddressBookEntry,
  getAddressBookEntry,
  revealAddressBookAadhaar,
  updateAddressBookEntry
} from "../controllers/addressBook.controller.js";
import { AddressBookEntry } from "../models/addressBookEntry.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { User } from "../models/user.model.js";

const databaseName = `sl_address_book_${Date.now()}`;
const accountId = new mongoose.Types.ObjectId();
const otherAccountId = new mongoose.Types.ObjectId();
let ownerId: mongoose.Types.ObjectId;
let outsiderId: mongoose.Types.ObjectId;

function input(overrides: Record<string, unknown> = {}) {
  return {
    businessAccountId: String(accountId),
    type: "RECIPIENT",
    label: "London Office",
    isFavourite: true,
    companyName: "Example Ltd",
    contactName: "Jane Smith",
    email: "jane@example.com",
    mobileCountryCode: "+44",
    mobileNumber: "7123456789",
    countryCode: "GB",
    countryName: "United Kingdom",
    addressLine1: "14 Marvell Avenue",
    addressLine2: "",
    townOrCity: "London",
    county: "Greater London",
    postcode: "UB4 0QR",
    instructions: "Reception",
    providerPlaceId: "",
    ...overrides
  };
}

function request(userId: mongoose.Types.ObjectId, body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  return { user: { _id: userId }, body, params, query: {} } as unknown as Request;
}

function responseRecorder() {
  let statusCode = 200;
  let body: any;
  const headers: Record<string, string> = {};
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; }
  } as unknown as Response;
  return { response, read: () => ({ statusCode, body, headers }) };
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName);
  await Promise.all([AddressBookEntry.init(), AuditLog.init(), BusinessAccountMember.init(), User.init()]);
  const [owner, outsider] = await User.create([
    { email: `address-owner-${Date.now()}@example.com`, role: "client" },
    { email: `address-outsider-${Date.now()}@example.com`, role: "client" }
  ]);
  ownerId = owner!._id as mongoose.Types.ObjectId;
  outsiderId = outsider!._id as mongoose.Types.ObjectId;
  await BusinessAccountMember.create([
    { businessAccount: accountId, user: ownerId, role: "operations", status: "active", invitedBy: ownerId },
    { businessAccount: otherAccountId, user: outsiderId, role: "operations", status: "active", invitedBy: outsiderId }
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("sl_address_book_"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("address book account isolation and lifecycle", () => {
  test("creates an account-scoped entry and writes an audit row", async () => {
    const recorder = responseRecorder();
    await createAddressBookEntry(request(ownerId, input()), recorder.response);
    const result = recorder.read();
    assert.equal(result.statusCode, 201);
    assert.equal(result.body.entry.label, "London Office");
    assert.equal(await AddressBookEntry.countDocuments({ businessAccountId: accountId, deletedAt: null }), 1);
    assert.equal(await AuditLog.countDocuments({ action: "ADDRESS_BOOK_ENTRY_CREATED" }), 1);
  });

  test("hides an entry from a different business account", async () => {
    const entry = await AddressBookEntry.findOne({ businessAccountId: accountId }).lean().exec();
    assert.ok(entry);
    const recorder = responseRecorder();
    await getAddressBookEntry(request(outsiderId, {}, { entryId: String(entry._id) }), recorder.response);
    assert.equal(recorder.read().statusCode, 404);
  });

  test("encrypts sender Aadhaar, masks normal responses, and audits authorized reveal", async () => {
    const aadhaarNumber = "234567890124";
    const senderInput = input({
      type: "SENDER",
      label: "Delhi Sender",
      mobileCountryCode: "+91",
      mobileNumber: "9876543210",
      countryCode: "IN",
      countryName: "India",
      addressLine1: "10 Market Road",
      townOrCity: "Delhi",
      county: "Delhi",
      postcode: "110001",
      aadhaarNumber
    });
    const createRecorder = responseRecorder();
    await createAddressBookEntry(request(ownerId, senderInput), createRecorder.response);
    const created = createRecorder.read();
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.entry.hasAadhaarNumber, true);
    assert.equal(created.body.entry.aadhaarNumberMasked, "XXXX XXXX 0124");
    assert.equal(JSON.stringify(created.body).includes(aadhaarNumber), false);

    const entryId = created.body.entry.id as string;
    const defaultRead = await AddressBookEntry.findById(entryId).lean().exec();
    assert.ok(defaultRead);
    assert.equal("aadhaarNumberEncrypted" in defaultRead, false);
    const protectedRead = await AddressBookEntry.findById(entryId).select("+aadhaarNumberEncrypted").lean().exec();
    assert.ok(protectedRead?.aadhaarNumberEncrypted);
    assert.notEqual(protectedRead.aadhaarNumberEncrypted, aadhaarNumber);

    const revealRecorder = responseRecorder();
    await revealAddressBookAadhaar(request(ownerId, {}, { entryId }), revealRecorder.response);
    const revealed = revealRecorder.read();
    assert.equal(revealed.statusCode, 200);
    assert.equal(revealed.body.aadhaarNumber, aadhaarNumber);
    assert.equal(revealed.headers["cache-control"], "no-store");
    assert.equal(await AuditLog.countDocuments({ action: "ADDRESS_BOOK_ENTRY_AADHAAR_REVEALED", entityId: entryId }), 1);

    const outsiderRecorder = responseRecorder();
    await revealAddressBookAadhaar(request(outsiderId, {}, { entryId }), outsiderRecorder.response);
    assert.equal(outsiderRecorder.read().statusCode, 404);

    const updateRecorder = responseRecorder();
    await updateAddressBookEntry(request(ownerId, { ...senderInput, aadhaarNumber: undefined }, { entryId }), updateRecorder.response);
    assert.equal(updateRecorder.read().statusCode, 200);
    const afterUpdate = await AddressBookEntry.findById(entryId).select("+aadhaarNumberEncrypted").lean().exec();
    assert.equal(afterUpdate?.aadhaarNumberEncrypted, protectedRead.aadhaarNumberEncrypted);

    const duplicateRecorder = responseRecorder();
    await duplicateAddressBookEntry(request(ownerId, {}, { entryId }), duplicateRecorder.response);
    assert.equal(duplicateRecorder.read().statusCode, 201);
    const duplicate = await AddressBookEntry.findById(duplicateRecorder.read().body.entry.id).select("+aadhaarNumberEncrypted").lean().exec();
    assert.equal(duplicate?.aadhaarNumberEncrypted, protectedRead.aadhaarNumberEncrypted);
    assert.equal(duplicate?.aadhaarNumberMasked, "XXXX XXXX 0124");
  });

  test("rejects Aadhaar on recipient addresses", async () => {
    const recorder = responseRecorder();
    await createAddressBookEntry(request(ownerId, input({ aadhaarNumber: "234567890124" })), recorder.response);
    assert.equal(recorder.read().statusCode, 400);
    assert.equal(recorder.read().body.errors[0].field, "aadhaarNumber");
  });

  test("resets validation when the postal address changes and soft-deletes the entry", async () => {
    const entry = await AddressBookEntry.findOne({ businessAccountId: accountId }).exec();
    assert.ok(entry);
    entry.validationStatus = "VALIDATED";
    entry.validatedAt = new Date();
    await entry.save();

    const updateRecorder = responseRecorder();
    await updateAddressBookEntry(
      request(ownerId, input({ addressLine1: "16 Marvell Avenue" }), { entryId: String(entry._id) }),
      updateRecorder.response
    );
    assert.equal(updateRecorder.read().statusCode, 200);
    assert.equal(updateRecorder.read().body.entry.validationStatus, "NOT_VALIDATED");

    const deleteRecorder = responseRecorder();
    await deleteAddressBookEntry(request(ownerId, {}, { entryId: String(entry._id) }), deleteRecorder.response);
    assert.equal(deleteRecorder.read().statusCode, 200);
    assert.ok((await AddressBookEntry.findById(entry._id).lean().exec())?.deletedAt);
  });
});
