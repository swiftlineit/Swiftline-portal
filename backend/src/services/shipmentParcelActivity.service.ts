import mongoose from "mongoose";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { FlightLinehaul } from "../models/flightLinehaul.model.js";
import { FlightOffload } from "../models/flightOffload.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestConsignment } from "../models/operationsManifestConsignment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { readShipmentBookingSnapshot } from "./shipmentBookingSnapshot.service.js";

export type ShipmentParcelActivity = {
  parcelNumber: string;
  status: "OFFLOADED" | "HELD" | "DEFERRED_TO_NEXT_MANIFEST" | "CANCELLED";
  eventAt: Date;
  reason: string;
  customerMessage: string;
  flightLinehaulId: string | null;
  flightLinehaulNumber: string;
  flightNumber: string;
};

function addActivity(
  target: Map<string, ShipmentParcelActivity[]>,
  shipmentDraftId: unknown,
  activity: ShipmentParcelActivity
) {
  const key = String(shipmentDraftId);
  const current = target.get(key) ?? [];
  current.push(activity);
  target.set(key, current);
}

function shipmentParcelNumbers(shipment: {
  parcelNumbers?: string[];
  currentShipmentSnapshot?: unknown;
  bookingSnapshot?: unknown;
}) {
  const stored = (shipment.parcelNumbers ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (stored.length) return [...new Set(stored)];
  const snapshot = readShipmentBookingSnapshot(shipment.currentShipmentSnapshot)
    ?? readShipmentBookingSnapshot(shipment.bookingSnapshot);
  return [...new Set((snapshot?.parcels ?? [])
    .map((parcel) => parcel.swiftlineParcelNumber.trim().toUpperCase())
    .filter(Boolean))];
}

export async function loadShipmentParcelActivitiesByDraftIds(
  shipmentDraftIds: mongoose.Types.ObjectId[]
) {
  const uniqueDraftIds = [...new Map(shipmentDraftIds.map((id) => [String(id), id])).values()];
  const result = new Map<string, ShipmentParcelActivity[]>();
  if (!uniqueDraftIds.length) return result;

  const [offloads, cancellations, shipments, manifestConsignments] = await Promise.all([
    FlightOffload.find({ "affectedParcels.shipmentDraftId": { $in: uniqueDraftIds } })
      .select("flightLinehaulId detail affectedParcels createdAt")
      .sort({ createdAt: -1 })
      .lean()
      .exec(),
    ShipmentCancellation.find({ shipmentDraftId: { $in: uniqueDraftIds }, status: "COMPLETED" })
      .select("shipmentDraftId reason completedAt reviewedAt updatedAt")
      .sort({ completedAt: -1 })
      .lean()
      .exec(),
    DpdShipment.find({ shipmentDraftId: { $in: uniqueDraftIds } })
      .select("shipmentDraftId parcelNumbers currentShipmentSnapshot bookingSnapshot")
      .lean()
      .exec(),
    OperationsManifestConsignment.find({
      shipmentDraftId: { $in: uniqueDraftIds },
      status: { $ne: "REMOVED" }
    })
      .select("manifestId shipmentDraftId scannedParcelNumbers parcelDispositions createdAt")
      .sort({ createdAt: -1 })
      .lean()
      .exec()
  ]);

  const flightIds = [...new Map(offloads.map((offload) => [String(offload.flightLinehaulId), offload.flightLinehaulId])).values()];
  const flights = flightIds.length
    ? await FlightLinehaul.find({ _id: { $in: flightIds } }).select("flightLinehaulNumber flightNumber").lean().exec()
    : [];
  const flightById = new Map(flights.map((flight) => [String(flight._id), flight]));
  const operationsManifestIds = [...new Map(manifestConsignments.map((item) => [String(item.manifestId), item.manifestId])).values()];
  const operationsManifests = operationsManifestIds.length
    ? await OperationsManifest.find({ _id: { $in: operationsManifestIds } })
      .select("status")
      .lean()
      .exec()
    : [];
  const operationsStatusById = new Map(operationsManifests.map((item) => [String(item._id), item.status]));

  for (const offload of offloads) {
    const flight = flightById.get(String(offload.flightLinehaulId));
    for (const parcel of offload.affectedParcels ?? []) {
      addActivity(result, parcel.shipmentDraftId, {
        parcelNumber: parcel.parcelNumber,
        status: "OFFLOADED",
        eventAt: offload.createdAt,
        reason: offload.detail,
        customerMessage: "This parcel was removed from its scheduled flight and is being handled by Swiftline Operations.",
        flightLinehaulId: offload.flightLinehaulId ? String(offload.flightLinehaulId) : null,
        flightLinehaulNumber: flight?.flightLinehaulNumber ?? "",
        flightNumber: flight?.flightNumber ?? ""
      });
    }
  }

  const shipmentByDraftId = new Map(shipments.map((shipment) => [String(shipment.shipmentDraftId), shipment]));
  for (const cancellation of cancellations) {
    const shipment = shipmentByDraftId.get(String(cancellation.shipmentDraftId));
    const eventAt = cancellation.completedAt ?? cancellation.reviewedAt ?? cancellation.updatedAt;
    for (const parcelNumber of shipment ? shipmentParcelNumbers(shipment) : []) {
      addActivity(result, cancellation.shipmentDraftId, {
        parcelNumber,
        status: "CANCELLED",
        eventAt,
        reason: cancellation.reason,
        customerMessage: "This parcel was cancelled as part of the shipment cancellation.",
        flightLinehaulId: null,
        flightLinehaulNumber: "",
        flightNumber: ""
      });
    }
  }

  for (const consignment of manifestConsignments) {
    // Draft and sealed packing decisions are still internal planning. A client
    // sees the omitted parcel only after the rest of that manifest has left.
    if (operationsStatusById.get(String(consignment.manifestId)) !== "DISPATCHED") continue;
    const laterConsignments = manifestConsignments.filter((candidate) =>
      String(candidate.shipmentDraftId) === String(consignment.shipmentDraftId)
        && new Date(candidate.createdAt).getTime() > new Date(consignment.createdAt).getTime());
    for (const disposition of consignment.parcelDispositions ?? []) {
      if (laterConsignments.some((candidate) =>
        candidate.scannedParcelNumbers.includes(disposition.parcelNumber))) continue;
      const customerMessage = disposition.disposition === "HELD"
        ? "This parcel is being held at the origin facility while the other parcels continue."
        : disposition.disposition === "DEFERRED_TO_NEXT_MANIFEST"
          ? "This parcel is scheduled to travel on a later manifest."
          : "This parcel was cancelled and is not travelling with the shipment.";
      addActivity(result, consignment.shipmentDraftId, {
        parcelNumber: disposition.parcelNumber,
        status: disposition.disposition,
        eventAt: disposition.recordedAt,
        reason: disposition.reason,
        customerMessage,
        flightLinehaulId: null,
        flightLinehaulNumber: "",
        flightNumber: ""
      });
    }
  }

  for (const activities of result.values()) {
    activities.sort((left, right) => right.eventAt.getTime() - left.eventAt.getTime());
  }
  return result;
}

export type ShipmentParcelProgress = {
  milestone: "ORIGIN_DISPATCH";
  completedParcels: number;
  totalParcels: number;
  isPartial: boolean;
};

export async function loadShipmentParcelProgressByDraftIds(shipmentDraftIds: mongoose.Types.ObjectId[]) {
  const result = new Map<string, ShipmentParcelProgress>();
  const uniqueDraftIds = [...new Map(shipmentDraftIds.map((id) => [String(id), id])).values()];
  if (!uniqueDraftIds.length) return result;
  const [shipments, consignments] = await Promise.all([
    DpdShipment.find({ shipmentDraftId: { $in: uniqueDraftIds } })
      .select("shipmentDraftId parcelNumbers currentShipmentSnapshot bookingSnapshot")
      .lean()
      .exec(),
    OperationsManifestConsignment.find({ shipmentDraftId: { $in: uniqueDraftIds }, status: { $ne: "REMOVED" } })
      .select("manifestId shipmentDraftId scannedParcelNumbers")
      .lean()
      .exec()
  ]);
  if (!shipments.length || !consignments.length) return result;
  const manifestIds = [...new Map(consignments.map((item) => [String(item.manifestId), item.manifestId])).values()];
  const dispatched = await OperationsManifest.find({
    _id: { $in: manifestIds },
    status: "DISPATCHED"
  }).select("_id").lean().exec();
  if (!dispatched.length) return result;
  const dispatchedIds = new Set(dispatched.map((item) => String(item._id)));
  for (const shipment of shipments) {
    const draftId = String(shipment.shipmentDraftId);
    const departedParcels = new Set(consignments
      .filter((item) => String(item.shipmentDraftId) === draftId && dispatchedIds.has(String(item.manifestId)))
      .flatMap((item) => item.scannedParcelNumbers));
    if (!departedParcels.size) continue;
    const totalParcels = shipmentParcelNumbers(shipment).length;
    result.set(draftId, {
      milestone: "ORIGIN_DISPATCH",
      completedParcels: departedParcels.size,
      totalParcels,
      isPartial: departedParcels.size < totalParcels
    });
  }
  return result;
}

export async function loadShipmentParcelProgress(shipmentDraftId: mongoose.Types.ObjectId): Promise<ShipmentParcelProgress | null> {
  const byDraftId = await loadShipmentParcelProgressByDraftIds([shipmentDraftId]);
  return byDraftId.get(String(shipmentDraftId)) ?? null;
}

export async function loadShipmentParcelActivities(shipmentDraftId: mongoose.Types.ObjectId) {
  const byDraftId = await loadShipmentParcelActivitiesByDraftIds([shipmentDraftId]);
  return byDraftId.get(String(shipmentDraftId)) ?? [];
}
