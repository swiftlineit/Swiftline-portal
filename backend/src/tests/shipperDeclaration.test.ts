import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bookingRequiresShipperDeclarationAcceptance,
  hasCurrentShipperDeclarationAcceptance,
  resolveShipperDeclarationAcceptance,
  SHIPPER_DECLARATION_VERSION
} from "../services/shipperDeclaration.service.js";

describe("shipper declaration acceptance", () => {
  test("requires a timestamp and the current declaration version", () => {
    const acceptedAt = new Date("2026-11-13T12:00:00.000Z");

    assert.equal(hasCurrentShipperDeclarationAcceptance({
      shipperDeclarationAcceptedAt: acceptedAt,
      shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
    }), true);
    assert.equal(hasCurrentShipperDeclarationAcceptance({
      shipperDeclarationAcceptedAt: acceptedAt,
      shipperDeclarationVersion: "old"
    }), false);
    assert.equal(hasCurrentShipperDeclarationAcceptance({
      shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
    }), false);
  });

  test("requires client and staff acceptance while keeping operator and public booking flows unchanged", () => {
    assert.equal(bookingRequiresShipperDeclarationAcceptance("admin", {}), true);
    assert.equal(bookingRequiresShipperDeclarationAcceptance("client", {}), true);
    assert.equal(bookingRequiresShipperDeclarationAcceptance("operator", {}), false);
    assert.equal(bookingRequiresShipperDeclarationAcceptance("public", {}), false);
    assert.equal(bookingRequiresShipperDeclarationAcceptance("client", {
      shipperDeclarationAcceptedAt: new Date(),
      shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
    }), false);
  });

  test("records acceptance with a server timestamp and version", () => {
    const acceptedAt = new Date("2026-11-13T12:00:00.000Z");
    const acceptance = resolveShipperDeclarationAcceptance({
      current: {},
      requestedAcceptance: true,
      shipmentDetailsChanged: false,
      acceptedAt
    });

    assert.deepEqual(acceptance, {
      shipperDeclarationAcceptedAt: acceptedAt,
      shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
    });
  });

  test("applies a checked declaration to details saved in the same request", () => {
    const acceptedAt = new Date("2026-11-13T12:10:00.000Z");
    const acceptance = resolveShipperDeclarationAcceptance({
      current: {
        shipperDeclarationAcceptedAt: new Date("2026-11-13T12:00:00.000Z"),
        shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
      },
      requestedAcceptance: true,
      shipmentDetailsChanged: true,
      acceptedAt
    });

    assert.deepEqual(acceptance, {
      shipperDeclarationAcceptedAt: acceptedAt,
      shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
    });
    assert.equal(bookingRequiresShipperDeclarationAcceptance("admin", acceptance), false);
    assert.equal(bookingRequiresShipperDeclarationAcceptance("client", acceptance), false);
  });

  test("clears an earlier acceptance when shipment details change without consent", () => {
    const acceptance = resolveShipperDeclarationAcceptance({
      current: {
        shipperDeclarationAcceptedAt: new Date("2026-11-13T12:00:00.000Z"),
        shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
      },
      shipmentDetailsChanged: true
    });

    assert.deepEqual(acceptance, {
      shipperDeclarationAcceptedAt: null,
      shipperDeclarationVersion: ""
    });
  });

  test("unchecking the declaration clears acceptance", () => {
    const acceptance = resolveShipperDeclarationAcceptance({
      current: {
        shipperDeclarationAcceptedAt: new Date("2026-11-13T12:00:00.000Z"),
        shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
      },
      requestedAcceptance: false,
      shipmentDetailsChanged: true
    });

    assert.equal(hasCurrentShipperDeclarationAcceptance(acceptance), false);
  });
});
