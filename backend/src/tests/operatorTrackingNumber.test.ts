import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatOperatorShipmentTrackingNumber,
  getOperatorCompanyTrackingPrefix
} from "../services/operatorTrackingNumber.service.js";
import { formatSwiftlineTrackingNumber } from "../services/swiftlineTracking.service.js";

describe("operator shipment tracking numbers", () => {
  const tenantId = "64b000000000000000000001";
  const date = new Date("2026-10-22T20:00:00.000Z");

  test("uses operator initials, branch station and India business date", () => {
    const number = formatOperatorShipmentTrackingNumber({
      tenantId,
      companyName: "JK Logistics",
      stationCode: "DEL",
      date,
      sequence: 1
    });
    assert.equal(number, "JKLDEL231026001");
    assert.ok(number.length <= 18);
    assert.equal(number.startsWith("SLC"), false);
  });

  test("derives a stable three-letter prefix from one, two or three words", () => {
    assert.equal(getOperatorCompanyTrackingPrefix("Swiftline"), "SWI");
    assert.equal(getOperatorCompanyTrackingPrefix("JK Logistics"), "JKL");
    assert.equal(getOperatorCompanyTrackingPrefix("Swiftline Cargo Express Logistics"), "SCE");
    assert.equal(getOperatorCompanyTrackingPrefix("A B"), "ABB");
  });

  test("uses the requested operator prefix while preserving Swiftline's existing format", () => {
    const first = formatOperatorShipmentTrackingNumber({
      tenantId,
      companyName: "Apex Cargo Services",
      stationCode: "DEL",
      date,
      sequence: 1
    });
    const second = formatOperatorShipmentTrackingNumber({
      tenantId: "64b000000000000000000002",
      companyName: "Beta Freight Logistics",
      stationCode: "DEL",
      date,
      sequence: 1
    });
    assert.notEqual(first, second);
    assert.equal(first, "ACSDEL231026001");
    assert.equal(second, "BFLDEL231026001");
    assert.equal(formatSwiftlineTrackingNumber({ stationCode: "DEL", date, sequence: 1 }), "SLCDEL231026001");
  });

  test("rejects values that cannot fit the fixed tracking format", () => {
    const input = { tenantId, companyName: "Apex Cargo", stationCode: "DEL", date };
    assert.throws(() => formatOperatorShipmentTrackingNumber({ ...input, sequence: 0 }), /OPERATOR_TRACKING_SEQUENCE_EXHAUSTED/);
    assert.throws(() => formatOperatorShipmentTrackingNumber({ ...input, sequence: Number.MAX_SAFE_INTEGER + 1 }), /OPERATOR_TRACKING_SEQUENCE_EXHAUSTED/);
    assert.throws(() => formatOperatorShipmentTrackingNumber({ ...input, tenantId: "bad", sequence: 1 }), /OPERATOR_TENANT_ID_INVALID/);
  });
});
