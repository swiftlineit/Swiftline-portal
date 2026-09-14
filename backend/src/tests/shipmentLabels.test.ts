import assert from "node:assert/strict";
import zlib from "node:zlib";
import { describe, test } from "node:test";
import {
  formatSwiftlineParcelNumber,
  formatSwiftlineTrackingNumber,
  resolveStationCode
} from "../services/swiftlineTracking.service.js";
import {
  renderSwiftlineLabelPdf,
  renderSwiftlineLabelSetPdf,
  type ShipmentLabelData
} from "../services/shipmentLabelPdf.service.js";
import {
  bookingSnapshotToLabelData,
  buildRevisedShipmentSnapshot,
  buildShipmentBookingSnapshot,
  snapshotDeclaredGoodsValueMinor,
  serializeShipmentBookingConfirmation
} from "../services/shipmentBookingSnapshot.service.js";

function labelData(parcelNumber: string): ShipmentLabelData {
  return {
    parcelNumber,
    parcelIndex: 0,
    parcelCount: 1,
    weightKg: 12.5,
    generatedAt: new Date("2026-07-20T06:30:00.000Z"),
    origin: { stationCode: "DEL", city: "New Delhi" },
    destination: { city: "London", countryCode: "GB", countryName: "United Kingdom" },
    consignee: {
      name: "Prime Minister & First Lord Of The Treasury",
      contactName: "Aman Negi J",
      addressLines: ["10 Downing Street", "London", "Greater London"],
      postcode: "SW1A 2AA",
      countryCode: "GB",
      countryName: "United Kingdom",
      email: "consignee@example.co.uk"
    }
  };
}

describe("shipment label numbering", () => {
  test("formats the approved Swiftline tracking number in India time", () => {
    const trackingNumber = formatSwiftlineTrackingNumber({
      stationCode: "DEL",
      date: new Date("2026-07-20T06:30:00.000Z"),
      sequence: 1
    });

    assert.equal(trackingNumber, "SLCDEL200726001");
    assert.equal(resolveStationCode(undefined, "DEL-001"), "DEL");
    assert.equal(formatSwiftlineTrackingNumber({
      stationCode: "DEL",
      date: new Date("2026-07-20T06:30:00.000Z"),
      sequence: 1000
    }), "SLCDEL2007261000");
  });

  test("uses stable piece suffixes for one or multiple parcels", () => {
    const trackingNumber = "SLCDEL200726001";
    assert.equal(formatSwiftlineParcelNumber(trackingNumber, 0), `${trackingNumber}-01`);
    assert.equal(formatSwiftlineParcelNumber(trackingNumber, 1), `${trackingNumber}-02`);
  });
});

// A PDF declares its page size in the MediaBox, which is the only part of the
// file readable without decompressing the content stream.
function readPageSize(pdf: Buffer): number[] {
  const mediaBox = /MediaBox\s*\[([^\]]+)\]/.exec(pdf.toString("latin1"));

  assert.ok(mediaBox?.[1], "label PDF should declare a page size");

  return mediaBox[1].trim().split(/\s+/).map(Number);
}

function readPageCount(pdf: Buffer) {
  return pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

/**
 * Every string pdfkit actually drew, one entry per text run.
 *
 * Asserting on the rendered output rather than the inputs is what catches a
 * label that silently clips or drops a field: the value can be present in the
 * label data and still never reach the page.
 */
function drawnRuns(pdf: Buffer): Array<{ text: string; font: string }> {
  const runs: Array<{ text: string; font: string }> = [];

  for (let index = 0; (index = pdf.indexOf("stream", index)) !== -1; ) {
    let start = index + 6;
    if (pdf[start] === 0x0d) start += 1;
    if (pdf[start] === 0x0a) start += 1;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) break;

    try {
      const content = zlib.inflateSync(pdf.subarray(start, end)).toString("latin1");
      let font = "";
      for (const line of content.split(/\r?\n/)) {
        const selected = /^\/(F\d+) [\d.]+ Tf$/.exec(line);
        if (selected) font = selected[1] ?? "";
        if (!/TJ$/.test(line)) continue;
        // pdfkit emits each run as a TJ array of hex-encoded strings interleaved
        // with kerning offsets; the offsets are dropped and the pieces rejoined.
        const text = [...line.matchAll(/<([0-9a-fA-F]+)>/g)]
          .map((part) => Buffer.from(part[1] ?? "", "hex").toString("latin1"))
          .join("");
        if (text.trim()) runs.push({ text: text.trim(), font });
      }
    } catch {
      // Image streams are not deflate-encoded text; skip them.
    }

    index = end + 9;
  }

  return runs;
}

function drawnText(pdf: Buffer): string[] {
  return drawnRuns(pdf).map((run) => run.text);
}

describe("shipment label PDFs", () => {
  test("renders one Swiftline label on square printer-safe stock", async () => {
    const pdf = await renderSwiftlineLabelPdf(labelData("SLCDEL200726001-01"));
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.length > 2_000);

    const [, , pageWidth, pageHeight] = readPageSize(pdf);
    assert.equal(Math.round(pageWidth ?? 0), 283);
    assert.equal(Math.round(pageHeight ?? 0), 283);
    assert.equal(readPageCount(pdf), 1);
  });

  test("keeps the footprint fixed however long the parcel number is", async () => {
    const long = await renderSwiftlineLabelPdf(labelData("SLCGURGAON01082600199-1234"));
    const short = await renderSwiftlineLabelPdf(labelData("SLC-01"));

    for (const pdf of [long, short]) {
      const [, , pageWidth, pageHeight] = readPageSize(pdf);
      assert.equal(Math.round(pageWidth ?? 0), 283);
      assert.equal(Math.round(pageHeight ?? 0), 283);
    }
  });

  test("lays out two complete centred parcel labels per A4 page", async () => {
    const labels = Array.from({ length: 5 }, (_, index) => ({
      ...labelData(`SLCDEL200726001-${String(index + 1).padStart(2, "0")}`),
      parcelIndex: index,
      parcelCount: 5,
      weightKg: index + 1
    }));
    const firstSheet = await renderSwiftlineLabelSetPdf(labels.slice(0, 2));
    const secondSheet = await renderSwiftlineLabelSetPdf(labels);

    for (const pdf of [firstSheet, secondSheet]) {
      const [, , pageWidth, pageHeight] = readPageSize(pdf);
      assert.equal(Math.round(pageWidth ?? 0), 595);
      assert.equal(Math.round(pageHeight ?? 0), 842);
    }
    assert.equal(readPageCount(firstSheet), 1);
    assert.equal(readPageCount(secondSheet), 3);

    const drawn = drawnText(secondSheet);
    for (const label of labels) {
      assert.ok(drawn.includes(label.parcelNumber), `${label.parcelNumber} should be printed in the combined PDF`);
    }
    assert.deepEqual(
      labels.map((label) => `${label.parcelIndex + 1} OF ${label.parcelCount}`).filter((piece) => !drawn.includes(piece)),
      []
    );
  });

  test("prints the routing grid, the hardcoded service and the consignee block", async () => {
    const pdf = await renderSwiftlineLabelPdf(labelData("SLCDEL200726001-01"));
    const drawn = drawnText(pdf);
    const shown = drawn.join(" | ");

    // Matched loosely: the exact trading name is a wording choice, but the label
    // must always carry it beside the mark.
    assert.ok(drawn.some((line) => /^SWIFTLINE\b/.test(line)), `company name missing from ${shown}`);
    assert.ok(drawn.includes("SLCDEL200726001-01"), "the barcode value should be printed under it");
    // Origin and destination are separate captioned cells, not one route string.
    assert.ok(drawn.includes("DEL"), `origin missing from ${shown}`);
    assert.ok(drawn.includes("LONDON, GB"), `destination missing from ${shown}`);
    assert.ok(drawn.includes("EXPRESS"), "service should be hardcoded on every label");
    assert.ok(drawn.includes("WORLDWIDE"), "service should be hardcoded on every label");
    assert.ok(drawn.includes("1 OF 1"), "piece count missing");
    assert.ok(drawn.includes("12.50 KG"), "weight missing");
    assert.ok(drawn.includes("SW1A 2AA  GB"), "postcode missing");
    // The label carries no carrier identity of its own.
    assert.ok(!drawn.some((line) => /DPD/i.test(line)), `carrier wording leaked: ${shown}`);
  });

  test("writes the address as plain lines and sets the postcode in bold", async () => {
    const runs = drawnRuns(await renderSwiftlineLabelPdf(labelData("SLCDEL200726001-01")));
    const find = (value: string) => runs.find((run) => run.text === value);

    // One component per line- never slash- or comma-joined into a single run.
    for (const line of ["10 Downing Street", "London", "Greater London"]) {
      assert.ok(find(line), `address line "${line}" should be drawn on its own`);
    }
    assert.ok(!runs.some((run) => run.text.includes("/")), "the address must not use slash separators");

    // The postcode is what the delivery depot sorts on, so it shares the bold
    // face used by the consignee name rather than the address's regular one.
    const postcode = find("SW1A 2AA  GB");
    const name = runs.find((run) => run.text.startsWith("Prime Minister & First Lord"));
    const street = find("10 Downing Street");
    assert.ok(postcode && name && street);
    assert.equal(postcode.font, name.font, "postcode should use the bold face");
    assert.notEqual(postcode.font, street.font, "postcode should not use the address face");
  });

  test("never prints the consignee email, even when the booking carries one", async () => {
    // The label stops at the postcode row on purpose. The email stays on the
    // booking snapshot for the portal to use; printing a customer's address on
    // the outside of a parcel is not one of those uses.
    const data = labelData("SLCDEL200726001-01");
    assert.ok(data.consignee.email, "the fixture must carry an email for this to prove anything");

    const drawn = drawnText(await renderSwiftlineLabelPdf(data));

    assert.ok(drawn.includes("SW1A 2AA  GB"), "the postcode row should still print");
    assert.ok(!drawn.some((line) => line.includes("@")), "no email should reach the label");
  });
});

describe("immutable multi-parcel booking snapshot", () => {
  test("keeps charges, references, weights and one label identity per parcel aligned", () => {
    const draft = {
      serviceType: "COURIER",
      consigneeEnteredAddress: {
        companyName: "Example Retail Ltd",
        contactName: "Asha Patel",
        countryCode: "GB",
        countryName: "United Kingdom",
        postcode: "SW1A 2AA",
        addressLine1: "10 Downing Street",
        townOrCity: "London",
        county: "Greater London"
      },
      consigneeValidatedAddress: null,
      parcelList: [
        { sequence: 1, weightKg: 7, lengthCm: 30, widthCm: 20, heightCm: 10, shipmentContentType: "PARCEL", items: [{ description: "Clothing", hsnCode: "62034200", unitType: "Pkt", quantity: 2, unitRate: 150 }], contentsDescription: "Clothing", shipmentReference1: "BOX-A" },
        { sequence: 2, weightKg: 11, lengthCm: 40, widthCm: 30, heightCm: 20, shipmentContentType: "PARCEL", items: [{ description: "Shoes", hsnCode: "64039900", unitType: "Pair", quantity: 3, unitRate: 200 }], contentsDescription: "Shoes", shipmentReference1: "BOX-B" }
      ]
    };
    const snapshot = buildShipmentBookingSnapshot({
      draft: draft as never,
      account: { _id: "account", accountId: "BA-1001", contact: {}, company: {} } as never,
      branch: {
        _id: "branch",
        name: "Swiftline Delhi",
        code: "DEL-001",
        gstin: "09BIQPK8904E1ZW",
        baseCurrency: "INR",
        address: { address: "New Delhi", city: "Delhi", countryName: "India" },
        contact: { phone: "+91 9999999999" }
      } as never,
      pricing: {
        parcels: [
          { sequence: 1, actualWeightKg: 7, volumetricWeightKg: 1.2, chargeableWeightKg: 7, rateCardId: "rate-1", rateFromKg: 5.01, rateToKg: 10, chargesPerKg: 200, maxBoxKg: 25, baseAmount: 1400, exceedsMaxBoxKg: false },
          { sequence: 2, actualWeightKg: 11, volumetricWeightKg: 4.8, chargeableWeightKg: 11, rateCardId: "rate-2", rateFromKg: 10.01, rateToKg: 20, chargesPerKg: 180, maxBoxKg: 25, baseAmount: 1980, exceedsMaxBoxKg: false }
        ],
        freightAmount: 3380,
        fuelSurchargeAmount: 0,
        remoteAreaAmount: 0,
        remoteAreaApplied: false,
        csbType: "CSB_IV" as const,
        csbClearanceAmount: 0,
        handlingAmount: 0,
        insuranceAmount: 0,
        insuranceApplied: false,
        declaredGoodsValue: 0,
        discountAmount: 0,
        baseAmount: 3380,
        gstAmount: 608.4,
        totalAmount: 3988.4,
        missingRate: false,
        exceedsMaxBoxKg: false,
        gstRate: 0.18,
        lines: [],
        pricingBasis: { rateCardIds: [], routeChargesUpdatedAt: null }
      },
      serviceCode: "DPD_CLASSIC",
      bookedAt: new Date("2026-07-20T06:30:00.000Z"),
       swiftlineTrackingNumber: "SLCDEL200726001",
       carrierShipmentId: "TEST-SLCDEL200726001",
       carrierTransactionId: "SIM-SLCDEL200726001",
      carrierParcelNumbers: [],
      advanceAmountMinor: 100000,
      creditAmountMinor: 298840
    });

    const mutableFirstParcel = draft.parcelList[0];
    assert.ok(mutableFirstParcel);
    mutableFirstParcel.weightKg = 99;
    assert.equal(snapshot.parcels[0]?.actualWeightKg, 7);
    assert.deepEqual(snapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber), [
      "SLCDEL200726001-01",
      "SLCDEL200726001-02"
    ]);
    assert.deepEqual(snapshot.parcels.map((parcel) => parcel.items?.[0]?.unitType), ["Pkt", "Pair"]);
    assert.deepEqual(snapshot.parcels.map((parcel) => parcel.declaredGoodsValueMinor), [30_000, 60_000]);
    assert.equal(snapshotDeclaredGoodsValueMinor(snapshot), 90_000);

    const firstLabel = bookingSnapshotToLabelData(snapshot, 0);
    const secondLabel = bookingSnapshotToLabelData(snapshot, 1);
    assert.equal(firstLabel.parcelNumber, "SLCDEL200726001-01");
    assert.equal(firstLabel.consignee.contactName, "Asha Patel");
    assert.equal(firstLabel.weightKg, 7);
    // The station the AWB was allocated against is what the label routes on.
    assert.equal(firstLabel.origin.stationCode, "DEL");
    assert.equal(firstLabel.destination.city, "London");
    assert.equal(secondLabel.parcelNumber, "SLCDEL200726001-02");
    assert.equal(secondLabel.weightKg, 11);

    assert.deepEqual(serializeShipmentBookingConfirmation(snapshot), {
      swiftlineTrackingNumber: "SLCDEL200726001",
      carrierShipmentId: "TEST-SLCDEL200726001",
      shipmentReference: "BOX-A",
      customerReference: "BOX-A",
      serviceType: "COURIER",
      serviceCode: "DPD_CLASSIC",
      parcelCount: 2,
      totalActualWeightKg: 18,
      baseAmountMinor: 338000,
      gstAmountMinor: 60840,
      totalAmountMinor: 398840,
      advanceAmountMinor: 100000,
      creditAmountMinor: 298840
    });

    const revisedSnapshot = buildRevisedShipmentSnapshot({
      previousSnapshot: snapshot,
      draft: {
        ...draft,
        serviceType: "CARGO",
        parcelList: [
          { ...draft.parcelList[0], weightKg: 8, shipmentReference1: "BOX-A-UPDATED" },
          { ...draft.parcelList[1], weightKg: 12 }
        ]
      } as never,
      pricing: {
        ...snapshot.pricing,
        baseAmount: 3600,
        gstAmount: 648,
        totalAmount: 4248
      },
      advanceAmountMinor: 120000,
      creditAmountMinor: 304800
    });

    assert.equal(snapshot.service.type, "COURIER");
    assert.equal(snapshot.parcels[0]?.actualWeightKg, 7);
    assert.equal(revisedSnapshot.service.type, "CARGO");
    assert.equal(revisedSnapshot.parcels[0]?.actualWeightKg, 8);
    assert.equal(revisedSnapshot.parcels[0]?.reference, "BOX-A-UPDATED");
    // No carrier books these shipments, so no parcel carries a carrier number.
    assert.equal(revisedSnapshot.parcels[0]?.carrierParcelNumber, "");
    assert.equal(revisedSnapshot.parcels[0]?.declaredGoodsValueMinor, 30_000);
    assert.equal(revisedSnapshot.payment.totalAmountMinor, 424800);
    assert.equal(revisedSnapshot.payment.advanceAmountMinor, 120000);
    assert.equal(revisedSnapshot.payment.creditAmountMinor, 304800);
  });
});
