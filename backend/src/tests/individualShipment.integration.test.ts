import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { listBusinessAccounts } from "../controllers/businessAccount.controller.js";
import { assertSameIndividualCustomer } from "../controllers/shipmentManifest.controller.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { Branch } from "../models/branch.model.js";
import { CounterPayment } from "../models/counterPayment.model.js";
import { ShipmentCharge } from "../models/shipmentCharge.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { User } from "../models/user.model.js";
import {
  excludeSentinel,
  getOrCreateIndividualSentinel,
  recordCounterCollection
} from "../services/individualCustomer.service.js";
import { createIndividualShipmentDraft } from "../services/manualShipmentDraft.service.js";
import { recordCounterShipmentCharge } from "../services/shipmentBookingBilling.service.js";
import { resolveShipmentInvoicePaymentAllocation } from "../services/shipmentInvoice.service.js";

// Kept short: Atlas caps database names at 38 bytes.
const databaseName = `swiftline_ind_test_${Date.now()}`;

/**
 * Opens a counter draft as an unrestricted actor.
 *
 * These cases are about counter billing rather than branch access, so they all
 * book the way an admin does. The branch scope itself is covered in
 * shipmentDraftBranchScope.integration.test.ts.
 */
const createCounterDraft = (
  input: Omit<Parameters<typeof createIndividualShipmentDraft>[0], "allowedBranchIds">
) => createIndividualShipmentDraft({ ...input, allowedBranchIds: null });

function createResponseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: unknown) {
      body = payload;
      return response;
    }
  } as unknown as Response;
  return { response, statusCode: () => statusCode, body: <T>() => body as T };
}

function adminRequest(query: Record<string, unknown> = {}) {
  return { user: { _id: new mongoose.Types.ObjectId(), role: "admin" }, query, params: {}, body: {} } as unknown as Request;
}

let branchId: mongoose.Types.ObjectId;
let adminId: mongoose.Types.ObjectId;

async function createBranch() {
  const branch = await Branch.create({
    name: "Individual Test Branch",
    code: `IND${Math.floor(1000 + Math.random() * 8999)}`,
    status: "ACTIVE",
    address: { addressLine1: "1 Counter Road", city: "Delhi", state: "Delhi", postalCode: "110001", country: "India" },
    contact: { email: "counter@swiftline.test", countryCode: "+91", phone: "9000000000" },
    createdBy: adminId
  });
  return branch._id as mongoose.Types.ObjectId;
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: databaseName, family: 4, retryWrites: false });
  assert.equal(mongoose.connection.name, databaseName, "Individual shipment tests must use an isolated database.");
  await Promise.all([BusinessAccount.init(), Branch.init(), User.init(), ShipmentDraft.init(), CounterPayment.init()]);
  adminId = new mongoose.Types.ObjectId();
  branchId = await createBranch();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.ok(mongoose.connection.name.startsWith("swiftline_ind_test_"), "Refusing to clean a non-test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

describe("individual shipment sentinel", () => {
  test("is created once and reused, even under concurrent first use", async () => {
    // The race this guards is two counters booking their first walk-in at the same
    // moment: a second sentinel would split walk-in shipments across two accounts.
    const [first, second, third] = await Promise.all([
      getOrCreateIndividualSentinel(adminId),
      getOrCreateIndividualSentinel(adminId),
      getOrCreateIndividualSentinel(adminId)
    ]);

    assert.equal(String(first._id), String(second._id));
    assert.equal(String(second._id), String(third._id));
    assert.equal(await BusinessAccount.countDocuments({ accountKind: "INDIVIDUAL_SENTINEL" }), 1);
    assert.equal(first.status, "approved", "The sentinel must never enter the KYC queue.");
    assert.equal(first.assignedBranch ?? null, null, "The sentinel serves every branch.");
    assert.equal(first.rateCardBand, "BAND_D", "Individual shipments must use the dedicated Band D tariff.");
    assert.equal(first.company.noCompany, true, "The sentinel must not be validated as a real company.");
  });

  test("repairs a legacy sentinel without weakening real-account validation", async () => {
    const sentinel = await getOrCreateIndividualSentinel(adminId);
    await BusinessAccount.collection.updateOne(
      { _id: sentinel._id },
      {
        $set: { rateCardBand: "BAND_A", "company.operatingCountries": [] },
        $unset: { "company.noCompany": "" }
      }
    );

    const repaired = await getOrCreateIndividualSentinel(adminId);
    assert.equal(repaired.rateCardBand, "BAND_D");
    assert.equal(repaired.company.noCompany, true);
    assert.deepEqual(repaired.company.operatingCountries, []);
  });

  test("is hidden from the business account list while real accounts still show", async () => {
    await getOrCreateIndividualSentinel(adminId);
    await BusinessAccount.create({
      accountId: `BA-TEST-${Date.now()}`,
      status: "active",
      contact: {
        title: "mr.", firstName: "Real", lastName: "Customer", email: `real${Date.now()}@example.com`,
        mobileType: "mobile", countryCode: "+91", mobileNumber: String(9100000000 + Math.floor(Math.random() * 800000)),
        jobTitle: "Owner", department: "Ops", shipmentTypes: ["international_courier"]
      },
      company: {
        registrationCountry: "India",
        companyName: "Real Customer Pvt Ltd",
        operatingCountries: ["India"]
      },
      createdBy: adminId
    });

    const recorder = createResponseRecorder();
    await listBusinessAccounts(adminRequest(), recorder.response);
    const payload = recorder.body<{ accounts: Array<{ accountId: string }> }>();

    assert.ok(payload.accounts.length > 0, "Real accounts must still be listed.");
    assert.ok(
      !payload.accounts.some((account) => account.accountId === "BA-SYSTEM-INDIVIDUAL"),
      "The sentinel must never appear in the account list."
    );
    assert.ok(payload.accounts.some((account) => account.accountId.startsWith("BA-TEST-")));
  });

  test("excludeSentinel keeps accounts that predate the accountKind field", async () => {
    // Older documents have no accountKind at all; `$ne` matches missing fields,
    // so they must still be listed.
    const legacyId = `BA-LEGACY-${Date.now()}`;
    await BusinessAccount.collection.insertOne({
      accountId: legacyId,
      status: "active",
      contact: { email: `legacy${Date.now()}@example.com`, countryCode: "+91", mobileNumber: "9333333333" },
      company: { companyName: "Legacy Co" },
      createdBy: adminId
    });

    const found = await BusinessAccount.find(excludeSentinel({ accountId: legacyId })).lean().exec();
    assert.equal(found.length, 1, "An account with no accountKind must not be treated as the sentinel.");
  });
});

describe("individual shipment drafts", () => {
  test("books against the sentinel and stores the payer on the draft", async () => {
    const draft = await createCounterDraft({
      branchId: String(branchId),
      customer: {
        contactName: "Asha Kumari",
        mobileCountryCode: "+91",
        mobileNumber: "9876500011",
        email: "asha@example.com",
        aadhaarNumber: "1234-5678-9012",
        addressLine1: "42 Station Road",
        townOrCity: "Delhi",
        postcode: "110001"
      },
      createdBy: adminId
    });

    const sentinel = await getOrCreateIndividualSentinel(adminId);
    assert.equal(draft.customerType, "INDIVIDUAL");
    assert.equal(String(draft.businessAccountId), String(sentinel._id));
    // Every address field on the draft is stored uppercase, because that is how
    // an address has to appear on an AWB and on a customs declaration. The name
    // is keyed in mixed case at the counter and normalized on save.
    assert.equal(draft.consignorAddress.contactName, "ASHA KUMARI");
    assert.equal(draft.consignorAddress.aadhaarNumber, "123456789012", "Aadhaar is stored as digits only.");
    assert.equal(draft.creationSource, "INDIVIDUAL");
  });

  test("rejects a branch that is not active", async () => {
    const closed = await Branch.create({
      name: "Closed Branch",
      code: `CLS${Math.floor(1000 + Math.random() * 8999)}`,
      status: "INACTIVE",
      address: { addressLine1: "9 Shut Street", city: "Delhi", state: "Delhi", postalCode: "110002", country: "India" },
      contact: { email: "closed@swiftline.test", countryCode: "+91", phone: "9000000001" },
      createdBy: adminId
    });

    await assert.rejects(
      () => createCounterDraft({
        branchId: String(closed._id),
        customer: { contactName: "Test", mobileCountryCode: "+91", mobileNumber: "9876500012" },
        createdBy: adminId
      }),
      /not active/i
    );
  });

  test("requires a name", async () => {
    await assert.rejects(
      () => createCounterDraft({
        branchId: String(branchId),
        customer: { contactName: "  ", mobileCountryCode: "+91", mobileNumber: "9876500013" },
        createdBy: adminId
      }),
      /name/i
    );
  });

  test("opens on the name alone, leaving the rest for the draft form", async () => {
    // The counter only takes the name; the sender's contact details and address
    // are filled in on the form and enforced before booking.
    const draft = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Rahul Verma" },
      createdBy: adminId
    });

    assert.equal(draft.consignorAddress.contactName, "RAHUL VERMA", "Address fields are stored uppercase for the AWB.");
    assert.equal(draft.consignorAddress.mobileNumber, "");
    assert.equal(draft.consignorAddress.mobileCountryCode, "+91", "The country code falls back to the local default.");
  });

  test("two walk-ins sharing an email or phone both succeed", async () => {
    // The reason a business account per walk-in was rejected: live accounts carry
    // unique indexes on email and mobile, so repeat or anonymous customers would
    // collide. Booking against the sentinel must not reintroduce that limit.
    const customer = {
      contactName: "Shared Contact",
      mobileCountryCode: "+91",
      mobileNumber: "9876500014",
      email: "shared@example.com"
    };

    const first = await createCounterDraft({ branchId: String(branchId), customer, createdBy: adminId });
    const second = await createCounterDraft({ branchId: String(branchId), customer, createdBy: adminId });

    assert.notEqual(String(first._id), String(second._id));
    assert.equal(String(first.businessAccountId), String(second.businessAccountId));
  });
});

describe("counter payment and billing", () => {
  test("the charge is completed with no reservation, so credit transitions no-op", async () => {
    const draft = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Charge Test", mobileCountryCode: "+91", mobileNumber: "9876500015" },
      createdBy: adminId
    });

    const charge = await recordCounterShipmentCharge({
      draft,
      pricing: { totalAmount: 1250 } as never
    });

    assert.ok(charge);
    assert.equal(charge.paymentSource, "ADMIN_DIRECT");
    assert.equal(charge.customerChargeStatus, "COMPLETED");
    assert.equal(
      charge.balanceReservationId ?? null,
      null,
      "No reservation means every credit transition returns early instead of touching a credit account."
    );
    assert.equal(charge.customerChargeMinor, 125000);
  });

  test("re-recording a charge for the same draft updates rather than duplicates", async () => {
    const draft = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Retry Test", mobileCountryCode: "+91", mobileNumber: "9876500016" },
      createdBy: adminId
    });

    await recordCounterShipmentCharge({ draft, pricing: { totalAmount: 500 } as never });
    await recordCounterShipmentCharge({ draft, pricing: { totalAmount: 500 } as never });

    assert.equal(await ShipmentCharge.countDocuments({ shipmentDraftId: draft._id }), 1);
  });

  test("a retried booking does not double-count the branch's takings", async () => {
    const draft = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Collection Test", mobileCountryCode: "+91", mobileNumber: "9876500017" },
      createdBy: adminId
    });

    const args = {
      shipmentDraftId: draft._id as mongoose.Types.ObjectId,
      branchId,
      amountMinor: 90000,
      payment: { method: "CASH" as const, reference: "RCPT-1" },
      recordedBy: adminId
    };
    await recordCounterCollection(args);
    await recordCounterCollection(args);

    const collected = await CounterPayment.find({ shipmentDraftId: draft._id, direction: "COLLECTED" }).lean().exec();
    assert.equal(collected.length, 1, "A retried booking must not record the money twice.");
    assert.equal(collected[0]?.amountMinor, 90000);
  });

  test("a refund is a separate row and leaves the collection intact", async () => {
    const draft = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Refund Test", mobileCountryCode: "+91", mobileNumber: "9876500018" },
      createdBy: adminId
    });

    await recordCounterCollection({
      shipmentDraftId: draft._id as mongoose.Types.ObjectId,
      branchId,
      amountMinor: 70000,
      payment: { method: "UPI" },
      recordedBy: adminId
    });
    await CounterPayment.create({
      shipmentDraftId: draft._id,
      branchId,
      direction: "REFUNDED",
      amountMinor: 20000,
      method: "BANK_TRANSFER",
      recordedBy: adminId
    });

    const rows = await CounterPayment.find({ shipmentDraftId: draft._id }).lean().exec();
    assert.equal(rows.length, 2);
    const net = rows.reduce((sum, row) => sum + (row.direction === "COLLECTED" ? row.amountMinor : -row.amountMinor), 0);
    assert.equal(net, 50000);
  });

  test("the counter allocation issues the invoice as fully paid", async () => {
    // A counter sale is settled before booking, so nothing may be left outstanding
    // on credit- that is what makes the invoice PAID and keeps it out of the
    // billing cycle, which only ever picks up invoices with credit owed.
    const allocation = resolveShipmentInvoicePaymentAllocation({
      totalAmountMinor: 125000,
      reservationAllocation: { advanceAmountMinor: 125000, creditAmountMinor: 0 }
    });

    assert.equal(allocation.advanceAppliedMinor, 125000);
    assert.equal(allocation.creditOutstandingMinor, 0);
  });

  test("manifest grouping keeps one walk-in customer per manifest", async () => {
    // Every walk-in is booked against the same sentinel, so the "same business
    // account" rule the manifest normally relies on would let two unrelated
    // customers onto one manifest headed with whichever name came first.
    const asha = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Asha", mobileCountryCode: "+91", mobileNumber: "9876500021" },
      createdBy: adminId
    });
    const ashaAgain = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Asha", mobileCountryCode: "+91", mobileNumber: "9876500021" },
      createdBy: adminId
    });
    const ravi = await createCounterDraft({
      branchId: String(branchId),
      customer: { contactName: "Ravi", mobileCountryCode: "+91", mobileNumber: "9876500022" },
      createdBy: adminId
    });

    assert.equal(
      String(asha.businessAccountId),
      String(ravi.businessAccountId),
      "Both walk-ins share the sentinel, which is why the extra guard is needed."
    );

    assert.doesNotThrow(() => assertSameIndividualCustomer([asha, ashaAgain], asha));
    assert.throws(
      () => assertSameIndividualCustomer([asha, ravi], asha),
      /same individual customer/i
    );
  });

  test("the customer guard leaves business shipments alone", async () => {
    const business = { customerType: "BUSINESS", consignorAddress: {} } as never;
    const other = { customerType: "BUSINESS", consignorAddress: { mobileNumber: "999" } } as never;
    assert.doesNotThrow(() => assertSameIndividualCustomer([business, other], business));
  });

  test("a business shipment still bills to credit", async () => {
    // Regression guard: the change must not make ordinary shipments look prepaid.
    const allocation = resolveShipmentInvoicePaymentAllocation({
      totalAmountMinor: 125000,
      reservationAllocation: { advanceAmountMinor: 0, creditAmountMinor: 125000 }
    });

    assert.equal(allocation.advanceAppliedMinor, 0);
    assert.equal(allocation.creditOutstandingMinor, 125000);
  });
});
