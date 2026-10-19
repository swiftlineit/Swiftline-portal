import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import type { IRateCardShare } from "../models/rateCardShare.model.js";
import { renderEmail } from "../services/email/layout.js";
import { getEmailTemplate, hasEmailTemplate } from "../services/email/templates/index.js";
import {
  applyAdjustment,
  createShareToken,
  endOfShareValidityDay,
  groupShareRows,
  hashShareToken,
  isShareOpen,
  rateCardDisplayAmount,
  rateCardGstLabel,
  resolveShareRecipientLabel,
  serializeRateCardShare,
  shareDocumentBasename,
  shareTokenMatches
} from "../services/rateCardShare.service.js";
import { buildTermsLines, createRateCardSharePdf } from "../services/rateCardSharePdf.service.js";
import { buildRateCardShareWorkbook } from "../services/rateCardShareWorkbook.service.js";
import {
  buildShareLinks,
  buildWhatsAppLink,
  buildWhatsAppMessage,
  summariseShare
} from "../services/rateCardShareMessage.service.js";

const APP_URL = "https://portal.swiftline.example";

test("rate-card GST display keeps the entered amount for either treatment", () => {
  assert.equal(rateCardDisplayAmount({ chargesPerKg: 420, gstTreatment: "INCLUDED", gstRatePercent: 18 }), 420);
  assert.equal(rateCardGstLabel({ gstTreatment: "INCLUDED", gstRatePercent: 18 }), "GST included (18%)");
  assert.equal(rateCardDisplayAmount({ chargesPerKg: 400, gstTreatment: "EXCLUDED", gstRatePercent: 4 }), 400);
  assert.equal(rateCardGstLabel({ gstTreatment: "EXCLUDED", gstRatePercent: 4 }), "GST excluded");
});

function makeShare(overrides: Partial<IRateCardShare> = {}): IRateCardShare {
  const share = {
    _id: new mongoose.Types.ObjectId(),
    shareNumber: "RC/26-27/00007",
    title: "UK & UAE Courier Rate Card",
    currency: "INR",
    band: "BAND_C",
    channels: ["PORTAL", "EMAIL", "WHATSAPP"],
    rows: [
      { countryCode: "GB", countryName: "United Kingdom", service: "COURIER", fromKg: 0.5, toKg: 5, baseChargesPerKg: 500, chargesPerKg: 550, maxBoxKg: 30 },
      { countryCode: "GB", countryName: "United Kingdom", service: "COURIER", fromKg: 5.01, toKg: 10, baseChargesPerKg: 460, chargesPerKg: 506, maxBoxKg: 30 },
      { countryCode: "AE", countryName: "United Arab Emirates", service: "CARGO", fromKg: 10.01, toKg: 50, baseChargesPerKg: 300, chargesPerKg: 330, maxBoxKg: 50 }
    ],
    routeCharges: [{
      countryCode: "GB",
      service: "COURIER",
      fuelSurchargePercent: 8,
      remoteAreaCharge: 450,
      remoteAreaPostcodes: ["AB", "IV"],
      handlingCharge: 75,
      insurancePercent: 1.5,
      insuranceMinimum: 125,
      discountPercent: 4
    }],
    adjustmentMode: "PERCENT",
    adjustmentValue: 10,
    terms: {
      validFrom: new Date("2026-08-01T00:00:00.000Z"),
      validUntil: new Date("2026-10-30T00:00:00.000Z"),
      fuelSurchargePercent: 12,
      gstPercent: 18,
      minChargeableWeightKg: 0.5,
      volumetricDivisor: 5000,
      remarks: "Pickup from Delhi NCR is included at no extra charge.",
      customTerms: ["Transit time is 4-6 working days to London."]
    },
    recipientAccounts: [{ businessAccountId: new mongoose.Types.ObjectId(), companyName: "Northline Exports" }],
    recipientEmails: [],
    recipientPhones: [{ phone: "+919876543210", name: "Priya Raman" }],
    publicTokenHash: hashShareToken("token"),
    publicTokenExpiresAt: new Date("2026-10-30T00:00:00.000Z"),
    status: "ACTIVE",
    readBy: [],
    publicViewCount: 0,
    lastViewedAt: null,
    createdBy: new mongoose.Types.ObjectId(),
    createdAt: new Date("2026-08-04T06:00:00.000Z"),
    updatedAt: new Date("2026-08-04T06:00:00.000Z"),
    ...overrides
  };

  return share as unknown as IRateCardShare;
}

/** pdfkit streams rather than returning bytes. */
function bufferPdf(document: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.end();
  });
}

/* ------------------------------- Pricing ------------------------------- */

test("a percentage adjustment marks up and discounts from the same signed value", () => {
  assert.equal(applyAdjustment(500, "PERCENT", 10), 550);
  assert.equal(applyAdjustment(500, "PERCENT", -10), 450);
});

test("a flat adjustment shifts the rate by rupees per kilogram", () => {
  assert.equal(applyAdjustment(500, "FLAT", 25), 525);
  assert.equal(applyAdjustment(500, "FLAT", -25), 475);
});

test("no adjustment leaves the base rate untouched", () => {
  assert.equal(applyAdjustment(499.999, "NONE", 50), 500);
  assert.equal(applyAdjustment(500, "PERCENT", 0), 500);
});

test("an over-large discount floors at zero rather than quoting a negative rate", () => {
  assert.equal(applyAdjustment(500, "PERCENT", -150), 0);
  assert.equal(applyAdjustment(500, "FLAT", -900), 0);
});

test("adjusted rates are rounded to paise, never left as floating dust", () => {
  assert.equal(applyAdjustment(333.33, "PERCENT", 7.5), 358.33);
});

/* -------------------------------- Tokens ------------------------------- */

test("a share token verifies against its own hash and nothing else", () => {
  const { token, tokenHash } = createShareToken();

  assert.ok(shareTokenMatches(token, tokenHash));
  assert.ok(!shareTokenMatches(`${token}x`, tokenHash));
  assert.ok(!shareTokenMatches("", tokenHash));
  assert.ok(!shareTokenMatches(createShareToken().token, tokenHash));
});

test("the raw token is never recoverable from what is stored", () => {
  const { token, tokenHash } = createShareToken();

  assert.notEqual(token, tokenHash);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  // 32 random bytes, base64url encoded.
  assert.ok(token.length >= 40);
});

test("a mismatched hash length is rejected instead of throwing", () => {
  assert.doesNotThrow(() => shareTokenMatches("anything", "abcd"));
  assert.equal(shareTokenMatches("anything", "abcd"), false);
});

/* -------------------------------- Access ------------------------------- */

test("a share is open only while it is active and unexpired", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");

  assert.ok(isShareOpen(makeShare(), now));
  assert.ok(!isShareOpen(makeShare({ status: "REVOKED" }), now));
  assert.ok(!isShareOpen(makeShare({ publicTokenExpiresAt: new Date("2026-08-15T00:00:00.000Z") }), now));
});

test("the selected valid-until date stays available through the end of that day in India", () => {
  const end = endOfShareValidityDay(new Date("2026-10-30T00:00:00.000Z"));
  assert.equal(end.toISOString(), "2026-10-30T18:29:59.999Z");
});

test("a share with a single addressee is named on the sheet", () => {
  const oneAccount = makeShare({ recipientPhones: [] });
  assert.equal(resolveShareRecipientLabel(oneAccount), "Northline Exports");

  const oneContact = makeShare({
    recipientAccounts: [],
    recipientPhones: [],
    recipientEmails: [{ email: "buyer@harbourfreight.example", name: "Ravi Menon" }]
  });
  assert.equal(resolveShareRecipientLabel(oneContact), "Ravi Menon");
});

test("a share sent to more than one recipient does not name any of them on the sheet", () => {
  // One document serves every recipient, so any second addressee- another
  // account, an outside address, a WhatsApp contact- means the named customer
  // would be printed on a sheet somebody else receives.
  const twoAccounts = makeShare({
    recipientPhones: [],
    recipientAccounts: [
      { businessAccountId: new mongoose.Types.ObjectId(), companyName: "Northline Exports" },
      { businessAccountId: new mongoose.Types.ObjectId(), companyName: "Harbour Freight" }
    ]
  });
  assert.equal(resolveShareRecipientLabel(twoAccounts), "Valued Customer");

  const accountPlusOutsider = makeShare({
    recipientPhones: [],
    recipientEmails: [{ email: "buyer@example.com", name: "Buyer" }]
  });
  assert.equal(resolveShareRecipientLabel(accountPlusOutsider), "Valued Customer");

  // The default fixture: one account plus a WhatsApp contact.
  assert.equal(resolveShareRecipientLabel(makeShare()), "Valued Customer");
});

/* ------------------------------ Serialization ---------------------------- */

test("clients and public viewers never receive the pre-adjustment rate", () => {
  const share = makeShare();

  const customerView = serializeRateCardShare(share);
  assert.equal(customerView.rows[0]?.chargesPerKg, 550);
  assert.equal("baseChargesPerKg" in (customerView.rows[0] ?? {}), false);
  assert.equal("adjustmentMode" in customerView, false);
  assert.equal("adjustmentValue" in customerView, false);
  assert.equal("band" in customerView, false);
  assert.equal(customerView.routeCharges[0]?.remoteAreaCharge, 450);
  assert.equal(customerView.documentType, "EXTERNAL_PROPOSAL");

  const staffView = serializeRateCardShare(share, { includeBaseRates: true });
  assert.equal(staffView.rows[0]?.baseChargesPerKg, 500);
  assert.equal(staffView.adjustmentMode, "PERCENT");
  assert.equal(staffView.band, "BAND_C");
});

test("the read receipt is resolved per user, not per business account", () => {
  const reader = new mongoose.Types.ObjectId();
  const colleague = new mongoose.Types.ObjectId();
  const share = makeShare({ readBy: [{ userId: reader, readAt: new Date("2026-08-05T00:00:00.000Z") }] });

  assert.ok(serializeRateCardShare(share, { currentUserId: String(reader) }).readAt);
  assert.equal(serializeRateCardShare(share, { currentUserId: String(colleague) }).readAt, null);
});

test("expiry is reported against the current clock, not the stored status", () => {
  const expired = makeShare({ publicTokenExpiresAt: new Date("2020-01-01T00:00:00.000Z") });
  assert.equal(serializeRateCardShare(expired).expired, true);
  assert.equal(serializeRateCardShare(makeShare()).expired, false);
});

/* ------------------------------- Grouping ------------------------------- */

test("rows group by country and service with slabs in weight order", () => {
  const groups = groupShareRows(makeShare().rows);

  assert.equal(groups.length, 2);
  // Alphabetical by country name: United Arab Emirates before United Kingdom.
  assert.equal(groups[0]?.countryCode, "AE");
  assert.equal(groups[1]?.countryCode, "GB");
  assert.deepEqual(groups[1]?.rows.map((row) => row.fromKg), [0.5, 5.01]);
});

/* --------------------------------- Terms -------------------------------- */

test("terms that were never set are omitted rather than printed as zero", () => {
  const withTerms = buildTermsLines(makeShare()).join("\n");
  assert.match(withTerms, /fuel surcharge of 12%/i);
  assert.match(withTerms, /include GST at 18%/);
  assert.match(withTerms, /Minimum chargeable weight is 0\.5 kg/);
  assert.match(withTerms, /\/ 5000\)/);
  assert.match(withTerms, /Transit time is 4-6 working days/);
  assert.match(withTerms, /GB Courier route charges: fuel 8%, remote area INR 450\.00, handling INR 75\.00, insurance 1\.5% \(minimum INR 125\.00\), discount 4%/);
  assert.match(withTerms, /GB Courier remote postcode prefixes: AB, IV/);

  const bare = buildTermsLines(makeShare({
    terms: { ...makeShare().terms, fuelSurchargePercent: 0, gstPercent: 0, minChargeableWeightKg: 0, volumetricDivisor: 0, customTerms: [] }
  })).join("\n");
  assert.doesNotMatch(bare, /fuel surcharge/i);
  assert.doesNotMatch(bare, /GST at/);
  assert.doesNotMatch(bare, /Minimum chargeable weight/);
  // The exclusions clause is unconditional: it is what makes the sheet safe.
  assert.match(bare, /exclude duties, destination-country taxes/);
});

/* ------------------------------- Documents ------------------------------ */

test("the rate card PDF renders as a real PDF document", async () => {
  const share = makeShare();
  const pdf = await bufferPdf(createRateCardSharePdf(share, resolveShareRecipientLabel(share)));

  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.length > 2000, "a one-page rate card is not a stub");
  assert.match(pdf.subarray(-1024).toString("latin1"), /%%EOF/);
});

test("a rate card with many destinations paginates instead of overflowing", async () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({
    countryCode: "GB",
    countryName: "United Kingdom",
    service: "COURIER" as const,
    fromKg: index,
    toKg: index + 1,
    baseChargesPerKg: 400 + index,
    chargesPerKg: 440 + index,
    maxBoxKg: 30
  }));

  const share = makeShare({ rows: rows as IRateCardShare["rows"] });
  const pdf = await bufferPdf(createRateCardSharePdf(share, "Valued Customer"));

  const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  assert.ok(pageCount > 1, `expected multiple pages, produced ${pageCount}`);
});

test("the workbook carries the quoted rates on a filterable sheet plus the terms", async () => {
  const share = makeShare();
  const buffer = await buildRateCardShareWorkbook(share, resolveShareRecipientLabel(share));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.getWorksheet("Rate Card");
  const terms = workbook.getWorksheet("Terms");
  assert.ok(sheet, "the tariff sheet exists");
  assert.ok(terms, "the terms sheet exists");
  assert.ok(sheet?.autoFilter, "the tariff stays a flat, filterable table");

  const rates: number[] = [];
  sheet?.eachRow((row) => {
    const value = row.getCell(6).value;
    if (typeof value === "number") rates.push(value);
  });

  // The customer-facing rate, never the base rate it was derived from.
  assert.ok(rates.includes(550), "the adjusted rate is written");
  assert.ok(!rates.includes(500), "the base rate is not leaked into the workbook");
});

/* ------------------------------- Messaging ------------------------------ */

test("share links all point at the portal origin and carry the token", () => {
  const links = buildShareLinks(APP_URL, "665f0b2c1a", "tok en/+");

  assert.equal(links.view, `${APP_URL}/rate-card/665f0b2c1a?token=tok%20en%2F%2B`);
  assert.equal(links.pdf, `${links.view}&download=pdf`);
  assert.equal(links.excel, `${links.view}&download=excel`);
});

test("an adjusted WhatsApp share is clearly labelled as an external proposal", () => {
  const share = makeShare();
  const links = buildShareLinks(APP_URL, String(share._id), "abc123");
  const message = buildWhatsAppMessage({ share, links, recipientName: "Priya Raman", senderName: "Aman Negi" });

  assert.match(message, /\*SWIFTLINE - EXTERNAL RATE PROPOSAL\*/);
  assert.match(message, /external rate proposal/i);
  assert.match(message, /Hello Priya,/);
  assert.match(message, /2 destinations/);
  assert.ok(message.includes(links.view));
  assert.ok(message.includes(links.pdf));
  assert.ok(message.includes(links.excel));
  assert.match(message, /Aman Negi/);
  assert.match(message, /GST: 18% included as applicable/);
  assert.doesNotMatch(message, /GST: 18% extra/);
  // The teaser quotes the customer's rate, not the base rate.
  assert.match(message, /330\.00/);
  assert.doesNotMatch(message, /300\.00/);
});

test("the WhatsApp message carries the optional rate-card terms", () => {
  const base = makeShare();
  const share = makeShare({ terms: { ...base.terms, remarks: "Pickup from Delhi NCR is included." } });
  const links = buildShareLinks(APP_URL, String(share._id), "abc123");
  const message = buildWhatsAppMessage({ share, links, recipientName: "Priya Raman", senderName: "Aman Negi" });

  assert.match(message, /Terms: Pickup from Delhi NCR is included\./);
});

test("a WhatsApp link strips formatting from the number and encodes the body", () => {
  const link = buildWhatsAppLink("+91 98765-43210", "Hello & welcome");

  assert.match(link, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.ok(link.includes("Hello%20%26%20welcome"));
});

test("a recipient without a usable number still gets a shareable link", () => {
  assert.match(buildWhatsAppLink("", "Hi"), /^https:\/\/wa\.me\/\?text=Hi$/);
});

test("the share summary counts destinations rather than rows", () => {
  const summary = summariseShare(makeShare());

  assert.equal(summary.countryCount, 2);
  assert.equal(summary.slabCount, 3);
  assert.deepEqual(
    summary.bestRates.sort((first, second) => first.service.localeCompare(second.service)),
    [{ service: "CARGO", lowest: 330 }, { service: "COURIER", lowest: 506 }]
  );
});

/* --------------------------------- Email -------------------------------- */

test("the rate card email is registered and renders both HTML and plaintext", () => {
  assert.ok(hasEmailTemplate("RATE_CARD_SHARED"));

  const share = makeShare();
  const links = buildShareLinks(APP_URL, String(share._id), "abc123");
  const content = getEmailTemplate("RATE_CARD_SHARED")({
    recipientName: "Priya Raman",
    appUrl: APP_URL,
    payload: {
      shareNumber: share.shareNumber,
      title: share.title,
      currency: "INR",
      viewUrl: links.view,
      senderName: "Aman Negi",
      validFrom: share.terms.validFrom.toISOString(),
      validUntil: share.terms.validUntil.toISOString(),
      countryCount: 2,
      slabCount: 3,
      highlights: [{ service: "Courier", lowest: "INR 506.00 / kg" }],
      termsRows: [{ label: "Fuel surcharge", value: "12%" }]
    }
  });

  const { html, text } = renderEmail(content, "Footer note.");

  assert.match(content.subject, /RC\/26-27\/00007/);
  assert.match(html, /Dear Priya,/);
  assert.match(html, /INR 506\.00 \/ kg/);
  assert.match(html, /Fuel surcharge/);
  assert.ok(html.includes(links.view));
  assert.match(html, /30 Oct 2026/);
  assert.ok(text.length > 0, "a plaintext alternative is always produced");
});

test("document filenames survive the slashes in a share number", () => {
  assert.equal(shareDocumentBasename(makeShare()), "Swiftline-External-Proposal-RC-26-27-00007");
  assert.equal(
    shareDocumentBasename(makeShare({ adjustmentMode: "NONE", adjustmentValue: 0 })),
    "Swiftline-Rate-Card-RC-26-27-00007"
  );
});
