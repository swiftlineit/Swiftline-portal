import assert from "node:assert/strict";
import test from "node:test";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { resolveInlineEmailImages } from "../services/email/inlineImages.js";
import { renderEmail } from "../services/email/layout.js";
import { getEmailTemplate, hasEmailTemplate } from "../services/email/templates/index.js";

const shipmentPayload = {
  trackingNumber: "SWL000123456",
  customerReference: "REF-8891",
  serviceType: "Courier",
  destination: "Manchester, United Kingdom",
  parcelCount: 3,
  totalWeightKg: 12.5,
  bookedAt: new Date("2026-07-30T09:15:00.000Z"),
  invoiceNumber: "SWL/2026-27/000412",
  currency: "INR",
  taxableValueMinor: 4500000,
  totalTaxAmountMinor: 810000,
  invoiceTotalMinor: 5310000,
  businessAccountName: "Northline Exports",
  branchName: "Delhi",
  bookedByName: "Priya Raman",
  href: "/client/shipments/665f0b2c1a",
  staffHref: "/dashboard/dpd-labels/665f0b2c1a"
};

function render(templateKey: string, payload: Record<string, unknown>, recipientName = "Priya Raman") {
  const content = getEmailTemplate(templateKey)({
    recipientName,
    payload,
    appUrl: "https://portal.swiftline.example"
  });
  return { content, ...renderEmail(content, "Footer note.") };
}

test("shipment booked client template renders the invoice and shipment facts", () => {
  const { content, html, text } = render("SHIPMENT_BOOKED_CLIENT", { ...shipmentPayload, labelsAttached: true });

  assert.match(content.subject, /SWL000123456/);
  assert.match(html, /SWL000123456/);
  assert.match(html, /SWL\/2026-27\/000412/);
  // Money must be rendered from minor units, never printed raw.
  assert.match(html, /53,100\.00/);
  assert.doesNotMatch(html, /5310000/);
  assert.match(html, /https:\/\/portal\.swiftline\.example\/client\/shipments\/665f0b2c1a/);
  assert.match(text, /SWL000123456/);
  assert.ok(text.length > 0, "a plaintext alternative is always produced");
});

test("shipment booked no-GST email calls the attachment an invoice and shows GST as a dash", () => {
  const noGstPayload = {
    ...shipmentPayload,
    taxTreatment: "NO_GST",
    totalTaxAmountMinor: 0,
    invoiceTotalMinor: shipmentPayload.taxableValueMinor,
    labelsAttached: true
  };
  const client = render("SHIPMENT_BOOKED_CLIENT", noGstPayload);
  const staff = render("SHIPMENT_BOOKED_STAFF", noGstPayload);
  assert.match(client.html, /your invoice is attached/i);
  assert.doesNotMatch(client.html, /your tax invoice is attached/i);
  assert.match(staff.html, /GST[\s\S]*?-/);
});

test("shipment booked client template does not claim labels are attached when they are not", () => {
  const attached = render("SHIPMENT_BOOKED_CLIENT", { ...shipmentPayload, labelsAttached: true });
  const dropped = render("SHIPMENT_BOOKED_CLIENT", { ...shipmentPayload, labelsAttached: false });

  assert.match(attached.html, /Swiftline shipping labels are attached/);
  assert.doesNotMatch(dropped.html, /Swiftline shipping labels are attached/);
  assert.match(dropped.html, /download from the portal/);
});

test("shipment booked client template names no carrier but Swiftline", () => {
  const { html } = render("SHIPMENT_BOOKED_CLIENT", { ...shipmentPayload, labelsAttached: true });

  assert.doesNotMatch(html, /DPD/i);
  // The old carrier flow attached a simulated label that had to be marked
  // unusable; there is no such label now, so no such warning either.
  assert.doesNotMatch(html, /not valid for carriage/);
  assert.match(html, /Swiftline/);
});

test("shipment booked staff template names the account and the booker", () => {
  const { content, html } = render("SHIPMENT_BOOKED_STAFF", shipmentPayload);

  assert.match(content.subject, /Northline Exports/);
  assert.match(html, /Priya Raman/);
  assert.match(html, /Delhi/);
  assert.match(html, /\/dashboard\/dpd-labels\/665f0b2c1a/);
});

test("generic template covers any notification type without a bespoke file", () => {
  assert.equal(hasEmailTemplate("SUPPORT_TICKET_REPLY"), false);

  const { content, html, text } = render("SUPPORT_TICKET_REPLY", {
    title: "New reply on ticket TKT-204",
    message: "Operations replied to your ticket about a delayed pickup.",
    href: "/client/tickets/abc#ticket-conversation"
  });

  assert.equal(content.subject, "New reply on ticket TKT-204");
  assert.match(html, /Operations replied to your ticket/);
  assert.match(html, /https:\/\/portal\.swiftline\.example\/client\/tickets\/abc#ticket-conversation/);
  assert.match(text, /Operations replied to your ticket/);
});

const pickupPayload = {
  requestNumber: "SLPDEL151026001",
  companyName: "Northline Exports",
  branchName: "Delhi",
  requesterName: "Priya Raman",
  requesterEmail: "priya@example.test",
  transportCompany: "FedEx",
  dispatchAt: "2026-10-16T04:00:00.000Z",
  arrivalDate: "2026-10-17T00:00:00.000Z",
  arrivalWindow: "MORNING",
  collectionAddress: "1 Market Road, New Delhi, 110001, IN",
  contactName: "Courier Desk",
  contactPhone: "+919876543210",
  totalBoxes: 2,
  totalWeightKg: 6.8,
  shipmentCount: 1,
  documentCount: 1,
  documentNames: ["collection-note.pdf"],
  handlingRemarks: "Use loading bay 2",
  receivedAt: "2026-10-17T06:00:00.000Z",
  receivedParcelCount: 1,
  missingParcelCount: 1,
  shipments: [{ trackingNumber: "SLCDEL0001", parcels: [
    { parcelNumber: "SLCDEL0001-1", hubReceiptOutcome: "RECEIVED" },
    { parcelNumber: "SLCDEL0001-2", hubReceiptOutcome: "NOT_RECEIVED" }
  ] }]
};

test("pickup request and start emails show full operational details for both audiences", () => {
  for (const key of ["PICKUP_REQUESTED_CLIENT", "PICKUP_REQUESTED_STAFF", "PICKUP_STARTED_CLIENT", "PICKUP_STARTED_STAFF"]) {
    const { html, text } = render(key, pickupPayload);
    assert.match(html, /cid:pickup-parcel@swiftline/);
    assert.match(html, /Northline Exports/);
    assert.match(html, /FedEx/);
    assert.match(text, /priya@example\.test/);
    assert.match(text, /Courier collection contact/);
    assert.match(html, /Morning/);
    assert.match(html, /SLCDEL0001/);
    assert.match(html, /Use loading bay 2/);
    assert.match(html, /collection-note\.pdf/);
    assert.match(text, /1 Market Road/);
    assert.match(html, key.endsWith("STAFF") ? /dashboard\/pickups/ : /client\/pickups/);
  }
});

test("pickup request email says whether supporting files were attached", () => {
  const attached = render("PICKUP_REQUESTED_CLIENT", { ...pickupPayload, pickupDocumentsAttached: 1 });
  assert.match(attached.text, /All 1 supporting document is attached/);
  const oversized = render("PICKUP_REQUESTED_STAFF", { ...pickupPayload, pickupDocumentsAttached: 0, attachmentsDropped: true });
  assert.match(oversized.text, /0 of 1 supporting documents attached/);
  assert.match(oversized.text, /portal to view every document securely/);
});

test("pickup illustration is embedded as an inline MIME image", async () => {
  const { content, html, text } = render("PICKUP_REQUESTED_CLIENT", pickupPayload);
  const attachments = await resolveInlineEmailImages(content);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.cid, "pickup-parcel@swiftline");
  assert.equal(attachments[0]?.contentDisposition, "inline");
  assert.equal(attachments[0]?.content.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const raw = await new Promise<Buffer>((resolve, reject) => {
    new MailComposer({ from: "test@swiftline.example", to: "client@example.test", subject: content.subject, html, text, attachments })
      .compile().build((error, message) => error ? reject(error) : resolve(message));
  });
  assert.match(raw.toString(), /Content-ID: <pickup-parcel@swiftline>/i);
  assert.match(raw.toString(), /Content-Disposition: inline/i);
  assert.match(raw.toString(), /cid:pickup-parcel@swiftline/);
});

test("pickup completion emails list every parcel not received at the hub", () => {
  for (const key of ["PICKUP_COMPLETED_CLIENT", "PICKUP_COMPLETED_STAFF"]) {
    const { content, html, text } = render(key, pickupPayload);
    assert.match(content.subject, /1 parcel not received/);
    assert.match(html, /1 of 2/);
    assert.match(html, /SLCDEL0001-2/);
    assert.match(text, /SLCDEL0001-2/);
    assert.match(html, /will remain short of full origin receipt|will show full origin receipt only after/);
  }
  const allReceived = render("PICKUP_COMPLETED_CLIENT", {
    ...pickupPayload,
    receivedParcelCount: 2,
    missingParcelCount: 0,
    shipments: [{ trackingNumber: "SLCDEL0001", parcels: pickupPayload.shipments[0]!.parcels.map((parcel) => ({ ...parcel, hubReceiptOutcome: "RECEIVED" })) }]
  });
  assert.match(allReceived.content.subject, /received at Delhi hub/);
  assert.match(allReceived.html, /2 of 2/);
  assert.doesNotMatch(allReceived.html, /listed as not received/);
});

test("pickup completion without linked shipments does not claim parcel receipt", () => {
  const { html } = render("PICKUP_COMPLETED_CLIENT", {
    ...pickupPayload, shipmentCount: 0, receivedParcelCount: 0, missingParcelCount: 0, shipments: []
  });
  assert.match(html, /No booked shipments were linked/);
  assert.doesNotMatch(html, /0 parcels recorded/);
});

test("payload values are HTML escaped", () => {
  const { html } = render("SUPPORT_TICKET_REPLY", {
    title: "Reply <script>alert(1)</script>",
    message: "Contains \"quotes\" & ampersands",
    href: "/client/tickets/abc"
  });

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("missing optional payload values degrade instead of printing undefined", () => {
  const { html, text } = render("SHIPMENT_BOOKED_CLIENT", {
    invoiceNumber: "SWL/2026-27/000001",
    currency: "INR",
    invoiceTotalMinor: 100000
  });

  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(html, /NaN/);
});

test("invitation and reset templates surface their action link and expiry", () => {
  const invitation = render("CLIENT_INVITATION", {
    companyName: "Northline Exports",
    activationUrl: "https://portal.swiftline.example/activate?token=abc123",
    expiresAt: new Date("2026-08-03T10:00:00.000Z")
  });
  assert.match(invitation.html, /activate\?token=abc123/);
  assert.match(invitation.html, /expires/i);

  const reset = render("PASSWORD_RESET", {
    resetUrl: "https://portal.swiftline.example/reset?token=xyz789",
    expiresAt: new Date("2026-08-01T11:00:00.000Z")
  });
  assert.match(reset.content.subject, /Reset your Swiftline Portal password/);
  assert.match(reset.html, /reset\?token=xyz789/);
});

test("login OTP template shows the code in the body, the subject line and the preview text", () => {
  const { content, html, text } = render("LOGIN_OTP", {
    code: "418302",
    expiresAt: new Date("2026-08-03T10:10:00.000Z"),
    expiresInMinutes: 10
  });

  assert.match(html, /418302/);
  assert.match(text, /418302/);
  // The preheader is what most people read the code from, straight out of the
  // inbox list, without ever opening the message.
  assert.match(content.preheader ?? "", /418302/);
  assert.match(html, /expires in 10 minutes/);
  // The code is the credential; it must never travel in the subject, which is
  // logged and previewed far more widely than the body.
  assert.doesNotMatch(content.subject, /418302/);
});

test("login OTP template keeps a leading-zero code intact", () => {
  const { html, text } = render("LOGIN_OTP", {
    code: "007431",
    expiresAt: new Date("2026-08-03T10:10:00.000Z"),
    expiresInMinutes: 10
  });

  assert.match(html, /007431/);
  assert.match(text, /007431/);
});
