import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditAgreement } from "../models/creditAgreement.model.js";
import { buildCreditAgreementSnapshot, serializeCreditAgreement } from "../services/creditAgreement.service.js";
import { renderCreditAgreementPdf } from "../services/creditAgreementPdf.service.js";
import { saveCreditAgreementPdf } from "../services/creditAgreementStorage.service.js";
import { deleteObject, getObjectBuffer } from "../services/storage/storage.service.js";

function fixture() {
  const actorId = new mongoose.Types.ObjectId();
  const business = new BusinessAccount({
    accountId: "BA-CREDIT-AGREEMENT-1",
    status: "approved",
    contact: {
      title: "mr.", firstName: "Honey", lastName: "Yadav", email: "honey@example.test",
      mobileType: "mobile", countryCode: "+91", mobileNumber: "9000000000",
      jobTitle: "Owner", department: "Finance", shipmentTypes: ["international_courier"]
    },
    company: {
      registrationCountry: "India", registrationId: "ABCDE1234D", gstin: "07ABCDE1234D1Z5",
      companyType: "pvt_ltd", companyName: "Swiftline Test Customer", registeredAddress: "Test Address",
      city: "Delhi", stateOrProvince: "Delhi", postalCode: "110001", addressCountry: "India",
      operatingCountries: ["India"], industry: "E-commerce", monthlyShipmentVolume: "1-10",
      requestedCreditLimit: { currency: "INR", amount: 50_000 }
    },
    createdBy: actorId
  });
  const credit = new BusinessCreditAccount({
    businessAccountId: business._id,
    status: "APPROVED",
    approvedCreditLimitMinor: 5_000_000,
    paymentTermsDays: 30,
    billingCycle: "MONTHLY",
    validFrom: new Date("2026-07-16T00:00:00.000Z"),
    validUntil: new Date("2027-07-16T00:00:00.000Z"),
    gracePeriodDays: 5,
    maxOverdueDays: 30,
    creditWarningThresholdPercent: 75,
    securityDepositRequiredMinor: 500_000,
    riskCategory: "HIGH",
    internalRemarks: "Must never appear in the customer agreement"
  });
  const snapshot = buildCreditAgreementSnapshot(business, credit);
  return { actorId, business, credit, snapshot };
}

describe("credit agreement snapshot", () => {
  test("captures approved customer and credit terms without internal Finance notes", () => {
    const { snapshot } = fixture();
    assert.equal(snapshot.business.companyName, "Swiftline Test Customer");
    assert.equal(snapshot.business.contactName, "Honey Yadav");
    assert.equal(snapshot.business.gstin, "07ABCDE1234D1Z5");
    assert.equal(snapshot.credit.approvedCreditLimitMinor, 5_000_000);
    assert.equal(snapshot.credit.securityDepositRequiredMinor, 500_000);
    assert.equal("riskCategory" in snapshot.credit, false);
    assert.equal("internalRemarks" in snapshot.credit, false);
  });

  test("validates minor-unit amounts and supported agreement statuses", async () => {
    const { actorId, business, credit, snapshot } = fixture();
    const valid = new CreditAgreement({
      agreementNumber: "CA-BA-CREDIT-AGREEMENT-1-V001",
      businessAccountId: business._id,
      creditAccountId: credit._id,
      version: 1,
      termsVersion: "2026-07-v1",
      snapshot,
      createdBy: actorId
    });
    await valid.validate();
    assert.equal(valid.status, "DRAFT");

    const invalid = new CreditAgreement({
      ...valid.toObject(),
      _id: new mongoose.Types.ObjectId(),
      status: "UNKNOWN",
      snapshot: { ...snapshot, credit: { ...snapshot.credit, approvedCreditLimitMinor: 100.5 } }
    });
    const validation = await invalid.validate().then(
      () => null,
      (error: unknown) => error as mongoose.Error.ValidationError
    );
    assert.ok(validation?.errors.status);
    assert.ok(validation?.errors["snapshot.credit.approvedCreditLimitMinor"]);
  });

  test("marks identity and snapshot fields immutable", () => {
    for (const path of ["agreementNumber", "businessAccountId", "creditAccountId", "version", "termsVersion", "snapshot", "createdBy"]) {
      assert.equal(Boolean(CreditAgreement.schema.path(path)?.options.immutable), true, `${path} must be immutable`);
    }
  });

  test("defines one open agreement per tenant business and unique version history", () => {
    const indexes = CreditAgreement.schema.indexes() as Array<[Record<string, number>, { unique?: boolean; name?: string; partialFilterExpression?: unknown }]>;
    assert.ok(indexes.some(([fields, options]) =>
      fields.tenantId === 1 && fields.businessAccountId === 1 && fields.version === 1 && options.unique
    ));
    const openIndex = indexes.find(([, options]) => options.name === "one_open_credit_agreement_per_tenant_business");
    assert.deepEqual(openIndex?.[0], { tenantId: 1, businessAccountId: 1 });
    assert.equal(openIndex?.[1].unique, true);
    assert.deepEqual(openIndex?.[1].partialFilterExpression, { status: { $in: ["DRAFT", "GENERATED", "SENT", "VIEWED"] } });
  });

  test("does not expose storage paths or signing audit data to clients", () => {
    const { actorId, business, credit, snapshot } = fixture();
    const agreement = new CreditAgreement({
      agreementNumber: "CA-BA-CREDIT-AGREEMENT-1-V001",
      businessAccountId: business._id,
      creditAccountId: credit._id,
      version: 1,
      termsVersion: "2026-07-v1",
      snapshot,
      generatedDocument: {
        storageKey: "private/agreements/agreement.pdf", originalName: "agreement.pdf",
        mimeType: "application/pdf", size: 100, checksumSha256: "a".repeat(64), storedAt: new Date()
      },
      signer: {
        userId: actorId, name: "Honey Yadav", email: "honey@example.test", jobTitle: "Owner",
        ipAddress: "127.0.0.1", userAgent: "integration-test"
      },
      createdBy: actorId
    });
    const client = serializeCreditAgreement(agreement) as Record<string, unknown>;
    assert.equal("storageKey" in (client.generatedDocument as Record<string, unknown>), false);
    assert.equal("ipAddress" in (client.signer as Record<string, unknown>), false);
    assert.equal("createdBy" in client, false);

    const admin = serializeCreditAgreement(agreement, { includeAuditDetails: true }) as Record<string, unknown>;
    assert.equal((admin.signer as Record<string, unknown>).ipAddress, "127.0.0.1");
    assert.equal(admin.createdBy, String(actorId));
  });

  test("renders a non-empty two-page PDF from the immutable agreement snapshot", async () => {
    const { actorId, business, credit, snapshot } = fixture();
    const agreement = new CreditAgreement({
      agreementNumber: "CA-BA-CREDIT-AGREEMENT-1-V001",
      businessAccountId: business._id,
      creditAccountId: credit._id,
      version: 1,
      termsVersion: "2026-07-v1",
      snapshot,
      createdBy: actorId
    });
    const pdf = await renderCreditAgreementPdf(agreement, new Date("2026-07-16T10:00:00.000Z"));
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.length > 5_000);
    assert.ok((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length >= 2);
  });

  test("stores PDFs privately with a checksum and rejects path traversal", async () => {
    const buffer = Buffer.from("%PDF-1.4\ncredit agreement test");
    const agreementId = new mongoose.Types.ObjectId().toString();
    const stored = await saveCreditAgreementPdf({
      agreementId,
      agreementNumber: "CA-TEST-V001",
      buffer,
      storedAt: new Date("2026-07-16T10:00:00.000Z")
    });

    try {
      assert.equal(stored.mimeType, "application/pdf");
      assert.equal(stored.size, buffer.length);
      assert.match(stored.checksumSha256, /^[a-f0-9]{64}$/);
      // The key is namespaced by the agreement and its filename is a generated
      // UUID- never the agreement number, and never a client-supplied name.
      assert.match(stored.storageKey, new RegExp(`^credit-agreements/${agreementId}/[0-9a-f-]{36}\\.pdf$`));
      assert.deepEqual(await getObjectBuffer(stored.storageKey), buffer);
    } finally {
      await deleteObject(stored.storageKey).catch(() => undefined);
    }
  });

  test("refuses a key that would escape the storage root", async () => {
    await assert.rejects(() => getObjectBuffer("../outside.pdf"), /key is invalid/i);
  });
});
