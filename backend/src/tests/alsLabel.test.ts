import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { env } from "../config/env.js";
import {
  AlsRequestError,
  AlsUncertainError,
  createAlsDocket,
  parseAlsCreateDocketResponse,
  readCarrierErrors,
  resetAlsAuthCache
} from "../services/als/alsClient.service.js";
import {
  AlsPayloadError,
  buildAlsCreateDocketPayload,
  isDpdLabelDestination
} from "../services/als/alsPayload.service.js";

/**
 * Every case here runs against a stubbed `fetch`. ALS has no sandbox, so a real
 * call is a real chargeable booking - the payload shape, the error mapping and
 * the retry rule are all provable without spending one.
 */

const originalFetch = globalThis.fetch;

// The whole ALS configuration is pinned rather than read from the developer's
// .env, so the suite proves the same thing on every machine. Reading it for real
// made these tests fail the moment someone commented out a credential after a
// live test - a false alarm that says nothing about the code. The one case that
// needs the integration switched off toggles it itself.
//
// These are deliberately not real credentials: every request is stubbed, and a
// value that worked would make an accidental live call possible.
before(() => {
  Object.assign(env, {
    ALS_ENABLED: true,
    ALS_API_BASE_URL: "https://als.test.invalid",
    ALS_COMPANY_ID: 1,
    ALS_API_EMAIL: "test@swiftline.invalid",
    ALS_API_PASSWORD: "stubbed-not-a-real-password",
    ALS_SERVICE_CODE: "DPD UK NEXTDAY",
    ALS_INR_PER_GBP: 105,
    ALS_REQUEST_TIMEOUT_MS: 30000
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAlsAuthCache();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const tokenBody = { success: true, data: { token: "tok-1", customer_id: 4242 } };

function draftFixture() {
  return {
    consignorAddress: {
      companyName: "Northline Exports",
      contactName: "Priya Raman",
      email: "priya@northline.example",
      mobileCountryCode: "+91",
      mobileNumber: "9876543210",
      aadhaarNumber: "234567890124",
      addressLine1: "12 Connaught Place",
      townOrCity: "New Delhi",
      county: "Delhi",
      postcode: "110001",
      countryCode: "IN"
    },
    consigneeEnteredAddress: {
      companyName: "Acme Trading Ltd",
      contactName: "Jane Doe",
      email: "ops@acme.co.uk",
      mobileCountryCode: "+44",
      mobileNumber: "7700900123",
      countryCode: "GB",
      countryName: "United Kingdom",
      postcode: "NW1 8QP",
      addressLine1: "14 High Street",
      townOrCity: "London",
      county: "Greater London",
      deliveryInstructions: "Call on arrival"
    },
    consigneeValidatedAddress: null,
    serviceType: "COURIER",
    parcelList: [
      {
        sequence: 1,
        weightKg: 6,
        lengthCm: 30,
        widthCm: 25,
        heightCm: 20,
        shipmentContentType: "PARCEL",
        contentsDescription: "Clothing",
        items: [
          { description: "Cotton shirts", hsnCode: "62034200", unitType: "Pcs", quantity: 4, unitRate: 500 }
        ]
      }
    ]
  } as never;
}

const payloadInput = {
  serviceCode: "DPD UK NEXTDAY",
  inrPerGbp: 105,
  customerId: 4242,
  trackingNumber: "SLCDEL170826001",
  bookedAt: new Date("2026-08-17T09:30:00.000Z")
};

describe("DPD label destination", () => {
  test("asks for a label only on United Kingdom shipments", () => {
    for (const code of ["GB", "gb", " uk ", "UK"]) {
      assert.equal(isDpdLabelDestination(code), true, `${code} should qualify`);
    }
    // Rate cards also cover these; they must never reach the carrier.
    for (const code of ["US", "CA", "IN", "IM", "JE", "", undefined, null]) {
      assert.equal(isDpdLabelDestination(code), false, `${String(code)} should not qualify`);
    }
  });
});

describe("ALS create_docket payload", () => {
  test("carries the fields a live booking proved are required", () => {
    const payload = buildAlsCreateDocketPayload({ draft: draftFixture(), ...payloadInput });

    // Each of these contradicts the published spec and was confirmed against a
    // booking ALS accepted.
    assert.equal(payload.api_service_code, "DPD UK NEXTDAY");
    assert.equal(payload.new_docket_free_form_invoice, "1");
    assert.equal(payload.free_form_invoice_type_id, "1");
    assert.equal(payload.terms_of_trade, "CFR");
    assert.ok(payload.free_form_line_items.length > 0, "the customs invoice must not be empty");

    assert.equal(payload.tracking_no, "SLCDEL170826001");
    assert.equal(payload.destination_code, "GB");
    assert.equal(payload.origin_code, "IN");
    assert.equal(payload.pcs, "1");
    assert.equal(payload.actual_weight, "6.00");
  });

  test("declares goods in GBP, not the portal's INR", () => {
    const payload = buildAlsCreateDocketPayload({ draft: draftFixture(), ...payloadInput });

    // 4 shirts x 500 INR = 2000 INR at 105 INR/GBP.
    assert.equal(payload.shipment_value_currency, "GBP");
    assert.equal(payload.shipment_value, "19.05");
    assert.equal(payload.free_form_line_items[0]?.rate, "4.76");
    assert.equal(payload.free_form_line_items[0]?.total, "19.05");

    // ALS rejects any unit it does not recognise as a missing one, so the
    // portal's own vocabulary (here "Pcs") must not reach the customs line.
    for (const item of payload.free_form_line_items) {
      assert.equal(item.unit_of_measurement, "Pc");
    }
  });

  test("refuses to build without an exchange rate rather than declaring INR as GBP", () => {
    assert.throws(
      () => buildAlsCreateDocketPayload({ draft: draftFixture(), ...payloadInput, inrPerGbp: 0 }),
      AlsPayloadError
    );
  });

  test("rejects a CSB-V parcel with no HS code before anything is sent", () => {
    const draft = draftFixture() as unknown as {
      csbType: string;
      parcelList: Array<{ items: Array<{ hsnCode: string }> }>;
    };
    draft.csbType = "CSB_V";
    draft.parcelList[0]!.items[0]!.hsnCode = "";

    assert.throws(
      () => buildAlsCreateDocketPayload({ draft: draft as never, ...payloadInput }),
      /HS code/
    );
  });

  test("sends a CSB-IV line with no HS code as an empty one rather than refusing", () => {
    // CSB-IV senders are not asked for a code, so the declaration carries what
    // they declared. Nothing is substituted on their behalf.
    const draft = draftFixture() as unknown as { parcelList: Array<{ items: Array<{ hsnCode: string }> }> };
    draft.parcelList[0]!.items[0]!.hsnCode = "";

    const payload = buildAlsCreateDocketPayload({ draft: draft as never, ...payloadInput });
    assert.equal(payload.free_form_line_items.length, 1);
    assert.equal(payload.free_form_line_items[0]!.hscode, "");
    assert.equal(payload.free_form_line_items[0]!.description, "Cotton shirts");
  });

  test("keeps contact details out of the stored request snapshot", async () => {
    const { sanitizeAlsRequestSnapshot } = await import("../services/als/alsPayload.service.js");
    const snapshot = sanitizeAlsRequestSnapshot(
      buildAlsCreateDocketPayload({ draft: draftFixture(), ...payloadInput })
    );

    assert.equal(snapshot.consignee_email, "[redacted-email]");
    assert.equal(snapshot.shipper_contact_no, "[redacted-phone]");
    // Empty rather than redacted: Swiftline sends no tax identity at all now
    // that the shipper is fixed, so there is nothing left to hide.
    assert.equal(snapshot.shipper_gstin_no, "");
  });

  test("sends Swiftline as the shipper, never the customer consigning the goods", () => {
    const payload = buildAlsCreateDocketPayload({ draft: draftFixture(), ...payloadInput });

    // ALS overwrites the account consignor with whatever a booking sends, so
    // these are pinned: changing them changes what the carrier holds on file.
    assert.equal(payload.shipper_company_name, "Swiftline Cargo & Express Logistics Pvt Ltd");
    assert.equal(payload.shipper_name, "Ravi Yadav");
    assert.equal(payload.shipper_contact_no, "7027116600");
    assert.equal(payload.shipper_email, "info@swiftlincargo.co.uk");
    assert.equal(payload.shipper_address_line_1, "Second Floor, Krishna Complex");
    assert.equal(payload.shipper_address_line_2, "Sector-10, Near 33 KVS Station");
    assert.equal(payload.shipper_address_line_3, "Uttam Nagar, Rewari, Haryana 123401");
    assert.equal(payload.shipper_city, "Rewari");
    assert.equal(payload.shipper_state, "Haryana");
    assert.equal(payload.shipper_zip_code, "123401");
    assert.equal(payload.shipper_country, "IN");
    assert.equal(payload.shipper_gstin_type, "");
    assert.equal(payload.shipper_gstin_no, "");

    // The stronger claim: nothing identifying the real consignor reaches ALS at
    // all. The fixture consignor is Northline Exports / Priya Raman, whose
    // Aadhaar and email used to be sent as the shipper tax id and contact.
    const serialized = JSON.stringify(payload);
    for (const leaked of ["Northline", "Priya", "priya@northline.example", "234567890124", "110001", "Connaught"]) {
      assert.ok(!serialized.includes(leaked), `consignor detail leaked to ALS: ${leaked}`);
    }
  });
});

describe("ALS response handling", () => {
  test("keeps a multi-parcel booking as the single document it arrives as", () => {
    const rawLabel = '<div data-secret="must-not-be-persisted">page one</div><div style="page-break-after: always"></div><div>page two</div>';
    const result = parseAlsCreateDocketResponse(
      {
        success: true,
        data: { docket_id: "D-1", awb_no: "1017351262", forwording_no: "F-9", entry_number: "E-3" },
        parcels: [{ parcel_no: "P1" }, { parcel_no: "P2" }, { parcel_no: "P3" }],
        labels: [{
          label: rawLabel,
          file_type: "html",
          filename: "labels.html"
        }]
      },
      {}
    );

    assert.equal(result.awbNumber, "1017351262");
    assert.deepEqual(result.parcelNumbers, ["P1", "P2", "P3"]);
    // Three parcels, one document: splitting it would break the page sequence
    // the carrier prints from.
    assert.equal(result.labels.length, 1);
    assert.equal(result.labels[0]?.format, "HTML");

    const html = result.labels[0]!.content.toString("utf8");
    assert.match(html, /<!doctype html>/i, "the fragment is wrapped so it prints standalone");
    assert.match(html, /page-break-after/);

    assert.deepEqual(result.responseSnapshot, {
      provider: "ALS",
      outcome: "ACCEPTED",
      docketId: "D-1",
      awbNumber: "1017351262",
      forwardingNumber: "F-9",
      entryNumber: "E-3",
      parcelNumbers: ["P1", "P2", "P3"],
      labelCount: 1,
      labelFormats: ["HTML"]
    });
    assert.ok(
      !JSON.stringify(result.responseSnapshot).includes("must-not-be-persisted"),
      "the MongoDB receipt must not duplicate carrier label content"
    );
  });

  test("treats an accepted booking with no label as a failure", () => {
    assert.throws(
      () => parseAlsCreateDocketResponse(
        { success: true, data: { awb_no: "1017351262" }, labels: [] },
        {}
      ),
      /returned no label/
    );
  });

  test("reads the carrier's own wording out of either shape it uses", () => {
    assert.deepEqual(readCarrierErrors({ errors: ["Customer credit limit is reached"] }), [
      "Customer credit limit is reached"
    ]);
    assert.deepEqual(readCarrierErrors({ data: { errors: "SHIPMENT INVOICE are mandatory" } }), [
      "SHIPMENT INVOICE are mandatory"
    ]);
  });
});

describe("ALS failure semantics", () => {
  test("a switched-off integration refuses loudly and sends nothing", async () => {
    // The dangerous outcome this guards: a United Kingdom parcel booked with no
    // carrier label because a flag was off or a restart was missed, with nobody
    // told. Off must surface as a refusal the booker has to answer.
    const previous = env.ALS_ENABLED;
    (env as { ALS_ENABLED: boolean }).ALS_ENABLED = false;

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse(tokenBody);
    }) as typeof fetch;

    try {
      const error = await createAlsDocket({
        draft: draftFixture(),
        trackingNumber: "SLCDEL170826001",
        bookedAt: payloadInput.bookedAt
      }).then(() => null, (caught: unknown) => caught);

      assert.ok(error instanceof AlsRequestError, "off is a refusal, not an outage");
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /switched off/i);
      assert.equal(called, false, "no request is made when the integration is off");
    } finally {
      (env as { ALS_ENABLED: boolean }).ALS_ENABLED = previous;
    }
  });

  test("a refusal sent as HTTP 500 is a decision, not an outage", async () => {
    // ALS answers a business refusal with a 500 and a JSON body. Passing that
    // status through would report a Swiftline server error and send everyone
    // looking in the wrong place.
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("get_token")) return jsonResponse(tokenBody);
      return jsonResponse({ success: false, errors: ["Customer credit limit is reached"] }, 500);
    }) as typeof fetch;

    const error = await createAlsDocket({
      draft: draftFixture(),
      trackingNumber: "SLCDEL170826001",
      bookedAt: payloadInput.bookedAt
    }).then(() => null, (caught: unknown) => caught);

    assert.ok(error instanceof AlsRequestError, "a parsed refusal is an AlsRequestError");
    assert.equal(error.statusCode, 409, "not 500 - the shipment was understood and declined");
    assert.deepEqual(error.carrierErrors, ["Customer credit limit is reached"]);
  });

  test("an unreadable reply is uncertain, never a refusal", async () => {
    // A booking may exist at the carrier, so this must never be offered as a
    // retry the way a clean refusal is.
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("get_token")) return jsonResponse(tokenBody);
      return new Response("<html>gateway timeout</html>", { status: 504 });
    }) as typeof fetch;

    await assert.rejects(
      createAlsDocket({
        draft: draftFixture(),
        trackingNumber: "SLCDEL170826001",
        bookedAt: payloadInput.bookedAt
      }),
      AlsUncertainError
    );
  });

  test("a dropped connection is uncertain and is not retried", async () => {
    let docketCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("get_token")) return jsonResponse(tokenBody);
      docketCalls += 1;
      throw new Error("socket hang up");
    }) as typeof fetch;

    await assert.rejects(
      createAlsDocket({
        draft: draftFixture(),
        trackingNumber: "SLCDEL170826001",
        bookedAt: payloadInput.bookedAt
      }),
      AlsUncertainError
    );
    assert.equal(docketCalls, 1, "a request of unknown outcome must not be repeated");
  });

  test("refreshes the token once, and only on an explicit expiry", async () => {
    let tokenCalls = 0;
    let docketCalls = 0;

    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("get_token")) {
        tokenCalls += 1;
        return jsonResponse(tokenBody);
      }
      docketCalls += 1;
      if (docketCalls === 1) {
        return jsonResponse({ success: false, errors: ["Auth token expired"] }, 401);
      }
      return jsonResponse({
        success: true,
        data: { docket_id: "D-1", awb_no: "1017351262" },
        parcels: [{ parcel_no: "P1" }],
        labels: [{ label: "<div>label</div>", file_type: "html", filename: "label.html" }]
      });
    }) as typeof fetch;

    const result = await createAlsDocket({
      draft: draftFixture(),
      trackingNumber: "SLCDEL170826001",
      bookedAt: payloadInput.bookedAt
    });

    assert.equal(result.awbNumber, "1017351262");
    assert.equal(docketCalls, 2, "retried exactly once");
    assert.equal(tokenCalls, 2, "with a freshly issued token");
  });
});
