import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { groupShipmentLabelDocuments, type ShipmentLabelItem } from "./ShipmentLabelsPanel.js";

function label(input: Partial<ShipmentLabelItem> & Pick<ShipmentLabelItem, "id" | "parcelNumber">): ShipmentLabelItem {
  return {
    labelType: "SWIFTLINE",
    format: "PDF",
    labelSize: "A4",
    ...input
  };
}

describe("shipment label document grouping", () => {
  test("shows one action for parcel records that share a Swiftline PDF", () => {
    const documents = groupShipmentLabelDocuments([
      label({ id: "1", parcelNumber: "SLCDEL120926001-01", fileChecksum: "combined" }),
      label({ id: "2", parcelNumber: "SLCDEL120926001-02", fileChecksum: "combined" }),
      label({ id: "3", parcelNumber: "DPD-1", labelType: "DPD", fileChecksum: "carrier" })
    ]);

    assert.equal(documents.length, 2);
    assert.deepEqual(documents[0]?.parcelNumbers, [
      "SLCDEL120926001-01",
      "SLCDEL120926001-02"
    ]);
    assert.deepEqual(documents[1]?.parcelNumbers, ["DPD-1"]);
  });

  test("keeps historical per-parcel PDFs as separate actions", () => {
    const documents = groupShipmentLabelDocuments([
      label({ id: "1", parcelNumber: "SLCDEL120926001-01", fileChecksum: "first" }),
      label({ id: "2", parcelNumber: "SLCDEL120926001-02", fileChecksum: "second" })
    ]);

    assert.equal(documents.length, 2);
  });
});
