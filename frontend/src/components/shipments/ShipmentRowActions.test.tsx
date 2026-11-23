import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdminShipmentCancellationDialog from "./AdminShipmentCancellationDialog.js";
import ShipmentRowActions, { getShipmentRowActionOptions } from "./ShipmentRowActions.js";
import type { ShipmentListItem } from "@/lib/shipmentsList";

describe("shipment row action options", () => {
  test("keeps destructive admin actions ordered after label actions", () => {
    const actions = getShipmentRowActionOptions({
      canRebook: true,
      canDelete: true,
      canCancel: true,
      hasDpdLabel: true
    });

    assert.deepEqual(actions.map(({ value }) => value), [
      "view",
      "invoice",
      "rebook",
      "dpd-label",
      "swiftline-label",
      "delete",
      "cancel"
    ]);
  });

  test("does not expose admin-only actions to operations staff", () => {
    const actions = getShipmentRowActionOptions({
      canRebook: true,
      canDelete: false,
      canCancel: false,
      hasDpdLabel: false
    });

    assert.deepEqual(actions.map(({ value }) => value), [
      "view",
      "invoice",
      "rebook",
      "swiftline-label"
    ]);
  });

  test("renders the accessible action select with the Swiftline label option", () => {
    const html = renderToStaticMarkup(createElement(ShipmentRowActions, {
      shipmentLabel: "SL-TEST-001",
      options: getShipmentRowActionOptions({
        canRebook: false,
        canDelete: true,
        canCancel: true,
        hasDpdLabel: false
      }),
      onAction: () => undefined
    }));

    assert.match(html, /<select aria-label="Actions for shipment SL-TEST-001"/);
    assert.match(html, /<option value="swiftline-label">Swiftline label<\/option>/);
    assert.match(html, /<option value="cancel">Cancel shipment<\/option>/);
  });

  test("renders fee, refund, carrier and settlement confirmations in the direct-cancel dialog", () => {
    const shipment = {
      id: "draft-test",
      swiftlineTrackingNumber: "SL-TEST-001",
      shipmentReference: "REF-001",
      businessAccountName: "Test business"
    } as ShipmentListItem;
    const html = renderToStaticMarkup(createElement(AdminShipmentCancellationDialog, {
      shipment,
      preview: {
        originalAmountMinor: 200_000,
        taxTreatment: "GST_APPLICABLE",
        feeBaseMinor: 70_000,
        feeGstMinor: 12_600,
        feeTotalMinor: 82_600,
        refundableAmountMinor: 117_400,
        feeWasCapped: false,
        manualRefundRequired: false,
        manualRefundSource: false
      },
      busy: false,
      error: "",
      onClose: () => undefined,
      onSubmit: async () => undefined
    }));

    assert.match(html, /Cancellation fee before GST \(INR\)/);
    assert.match(html, /Fee total/);
    assert.match(html, /Refundable/);
    assert.match(html, /cancelled this shipment with the carrier/);
    assert.match(html, /confirm the settlement/);
    assert.match(html, /Complete cancellation/);
  });
});
