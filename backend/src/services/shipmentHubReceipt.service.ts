import mongoose from "mongoose";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { PickupRequestShipment } from "../models/pickupRequestShipment.model.js";
import { ShipmentOperationsParcelScan } from "../models/shipmentOperationsParcelScan.model.js";
import { resolveOperationsScanParcelNumbers } from "./shipmentOperationsScan.service.js";

export type ShipmentHubReceipt = {
  receivedParcels: number;
  totalParcels: number;
  receivedParcelNumbers: string[];
  notReceivedParcelNumbers: string[];
};

export async function loadShipmentHubReceiptsByDraftIds(draftIds: mongoose.Types.ObjectId[]) {
  const result = new Map<string, ShipmentHubReceipt>();
  if (!draftIds.length) return result;
  const [shipments, scans, closedPickupLinks] = await Promise.all([
    DpdShipment.find({ shipmentDraftId: { $in: draftIds } })
      .select("shipmentDraftId parcelNumbers currentShipmentSnapshot bookingSnapshot").lean().exec(),
    ShipmentOperationsParcelScan.find({ shipmentDraftId: { $in: draftIds }, action: "RECEIVE" })
      .select("shipmentDraftId parcelNumber").lean().exec(),
    PickupRequestShipment.find({ shipmentDraftId: { $in: draftIds }, hubReceiptRecordedAt: { $ne: null } })
      .select("shipmentDraftId").lean().exec()
  ]);
  const receivedByDraft = new Map<string, Set<string>>();
  for (const scan of scans) {
    const key = String(scan.shipmentDraftId);
    const numbers = receivedByDraft.get(key) ?? new Set<string>();
    numbers.add(scan.parcelNumber.trim().toUpperCase());
    receivedByDraft.set(key, numbers);
  }
  const closedIds = new Set(closedPickupLinks.map((link) => String(link.shipmentDraftId)));
  for (const shipment of shipments) {
    const key = String(shipment.shipmentDraftId);
    const received = receivedByDraft.get(key) ?? new Set<string>();
    if (!received.size && !closedIds.has(key)) continue;
    const expected = resolveOperationsScanParcelNumbers({
      currentShipmentSnapshot: shipment.currentShipmentSnapshot,
      bookingSnapshot: shipment.bookingSnapshot,
      parcelNumbers: shipment.parcelNumbers
    });
    if (!expected.length) continue;
    const receivedParcelNumbers = expected.filter((number) => received.has(number));
    result.set(key, {
      receivedParcels: receivedParcelNumbers.length,
      totalParcels: expected.length,
      receivedParcelNumbers,
      notReceivedParcelNumbers: expected.filter((number) => !received.has(number))
    });
  }
  return result;
}

export async function loadShipmentHubReceipt(draftId: mongoose.Types.ObjectId) {
  return (await loadShipmentHubReceiptsByDraftIds([draftId])).get(String(draftId)) ?? null;
}
