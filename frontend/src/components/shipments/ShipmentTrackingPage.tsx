"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { FiAlertCircle, FiChevronDown, FiSearch } from "react-icons/fi";
import {
  trackClientShipment,
  type ClientShipmentDetails,
} from "@/lib/clientDashboard";
import {
  listDpdShipments,
  type DpdShipmentHistoryItem,
  type ShipmentEvent,
} from "@/lib/dpdLabels";
import { listShipments, type ShipmentListItem } from "@/lib/shipmentsList";
import type { DeliveryEstimate } from "@/components/shipments/ShipmentJourney";
import TrackingResult from "@/components/shipments/TrackingResult";
import { labelStatus } from "@/lib/shipmentJourney";
import type { TrackingJourney } from "@/lib/shipmentJourney";
import type {
  TrackingAttention,
  ParcelActivity,
  ParcelProgress,
  TrackingPosition,
  TrackingSummary,
} from "@/lib/shipmentTracking";

type TrackingMode = "admin" | "client";
type TrackingRecord = {
  draftId: string;
  consignee: string;
  destination: string;
  status: string;
  statusLabel: string;
  carrierShipmentNumber: string;
  swiftlineTrackingNumber: string;
  parcelNumbers: string[];
  branchName: string;
  service: string;
  parcelCount: number;
  createdAt?: string | null;
  events: ShipmentEvent[];
  deliveryEstimate: DeliveryEstimate | null;
  summary: TrackingSummary | null;
  attention: TrackingAttention | null;
  journey: TrackingJourney | null;
  position: TrackingPosition | null;
  parcelActivities: ParcelActivity[];
  parcelProgress: ParcelProgress | null;
};

type ShipmentTrackingPageProps = {
  mode: TrackingMode;
  title: string;
  description: string;
};

function fromAdmin(item: DpdShipmentHistoryItem): TrackingRecord {
  const current = item.currentEvent;
  const currentIsInternalCollection = current?.status === "PARCEL_COLLECTED";
  return {
    draftId: item.dpdShipment.shipmentDraftId,
    consignee: item.shipmentDraft?.consigneeName || "Shipment consignee",
    destination:
      [
        item.shipmentDraft?.consigneeTownOrCity,
        item.shipmentDraft?.deliveryPostcode,
      ]
        .filter(Boolean)
        .join(", ") || "Destination not available",
    status: currentIsInternalCollection ? "SHIPMENT_BOOKED" : current?.status || item.dpdShipment.status,
    statusLabel: currentIsInternalCollection ? "Booking Confirmed" : current?.statusLabel || labelStatus(item.dpdShipment.status),
    carrierShipmentNumber: item.dpdShipment.dpdShipmentId,
    swiftlineTrackingNumber: item.dpdShipment.swiftlineTrackingNumber,
    parcelNumbers: item.dpdShipment.parcelNumbers,
    branchName: item.branch ? `${item.branch.name} (${item.branch.code})` : "",
    service:
      item.bookingConfirmation?.serviceType ||
      item.dpdShipment.serviceCode ||
      "",
    parcelCount:
      item.bookingConfirmation?.parcelCount ||
      item.dpdShipment.parcelNumbers.length,
    createdAt: item.dpdShipment.createdAt,
    events: item.events.filter((event) => event.status !== "PARCEL_COLLECTED"),
    // Staff tracking asks the history endpoint for an estimate, so Operations
    // sees the same schedule the customer does rather than no schedule at all.
    deliveryEstimate: item.deliveryEstimate ?? null,
    summary: item.trackingSummary ?? null,
    attention: item.trackingAttention ?? null,
    journey: item.trackingJourney ?? null,
    position: item.trackingPosition ?? null,
    parcelActivities: item.parcelActivities ?? [],
    parcelProgress: item.parcelProgress ?? null,
  };
}

function fromClient(shipment: ClientShipmentDetails): TrackingRecord {
  const current = shipment.currentEvent;
  const currentIsInternalCollection = current?.status === "PARCEL_COLLECTED";
  return {
    draftId: shipment.shipmentDraft.id,
    consignee:
      shipment.shipmentDraft.consignee.companyName ||
      shipment.shipmentDraft.consignee.contactName ||
      "Shipment consignee",
    destination:
      [
        shipment.shipmentDraft.consignee.townOrCity,
        shipment.shipmentDraft.consignee.postcode,
        shipment.shipmentDraft.consignee.countryName,
      ]
        .filter(Boolean)
        .join(", ") || "Destination not available",
    status:
      currentIsInternalCollection ? "SHIPMENT_BOOKED" : current?.status ||
      shipment.dpdShipment?.status ||
      shipment.shipmentDraft.status,
    statusLabel:
      currentIsInternalCollection ? "Booking Confirmed" : current?.statusLabel ||
      labelStatus(
        shipment.dpdShipment?.status || shipment.shipmentDraft.status,
      ),
    carrierShipmentNumber: shipment.dpdShipment?.dpdShipmentId || "",
    swiftlineTrackingNumber:
      shipment.dpdShipment?.swiftlineTrackingNumber || "",
    parcelNumbers: shipment.dpdShipment?.parcelNumbers || [],
    branchName: "",
    service:
      shipment.bookingConfirmation?.serviceType ||
      shipment.shipmentDraft.serviceType ||
      "",
    parcelCount: shipment.shipmentDraft.parcelCount,
    createdAt:
      shipment.dpdShipment?.createdAt || shipment.shipmentDraft.createdAt,
    events: shipment.events.filter((event) => event.status !== "PARCEL_COLLECTED"),
    deliveryEstimate: shipment.deliveryEstimate ?? null,
    summary: shipment.trackingSummary ?? null,
    attention: shipment.trackingAttention ?? null,
    journey: shipment.trackingJourney ?? null,
    position: shipment.trackingPosition ?? null,
    parcelActivities: shipment.parcelActivities ?? [],
    parcelProgress: shipment.parcelProgress ?? null,
  };
}

/** One selectable piece, identified by its Swiftline barcode. */
type SelectableParcel = { forwardingNumber: string; swiftlineNumber: string };

function shipmentParcels(shipment: ShipmentListItem): SelectableParcel[] {
  const count = Math.max(
    shipment.forwardingNumbers.length,
    shipment.awbNumbers.length,
  );
  return Array.from({ length: count }, (_, index) => ({
    forwardingNumber: shipment.forwardingNumbers[index] ?? "",
    swiftlineNumber: shipment.awbNumbers[index] ?? "",
  })).filter((parcel) => parcel.forwardingNumber || parcel.swiftlineNumber);
}

function shipmentLabel(shipment: ShipmentListItem) {
  const reference = shipment.swiftlineTrackingNumber || "AWB Pending";
  return [reference, shipment.consignee, shipment.destination]
    .filter(Boolean)
    .join(" · ");
}

export default function ShipmentTrackingPage({
  mode,
  title,
  description,
}: ShipmentTrackingPageProps) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TrackingRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [shipments, setShipments] = useState<ShipmentListItem[]>([]);
  const [selectedShipmentId, setSelectedShipmentId] = useState("");
  // The number the current result was found by, so a parcel-level search can be
  // called out against a timeline that is always shipment level.
  const [trackedNumber, setTrackedNumber] = useState("");

  const loadShipments = useCallback(async () => {
    try {
      setShipments((await listShipments(mode, { limit: 50 })).shipments);
    } catch {
      // The picker is a convenience; manual entry still tracks anything.
      setShipments([]);
    }
  }, [mode]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadShipments(), 0);
    return () => window.clearTimeout(timer);
  }, [loadShipments]);

  const selectedShipment = useMemo(
    () => shipments.find((shipment) => shipment.id === selectedShipmentId) ?? null,
    [selectedShipmentId, shipments],
  );
  const parcels = selectedShipment ? shipmentParcels(selectedShipment) : [];

  const track = useCallback(
    async (value: string) => {
      const trackingNumber = value.trim();
      if (!trackingNumber) {
        setError("Enter a Swiftline, carrier, or parcel tracking number.");
        return;
      }
      setLoading(true);
      setError("");
      setResult(null);
      setSearched(true);
      setTrackedNumber(trackingNumber);
      try {
        if (mode === "client") {
          setResult(
            fromClient((await trackClientShipment(trackingNumber)).shipment),
          );
        } else {
          const matches = (await listDpdShipments(1, trackingNumber, true)).shipments;
          if (!matches[0])
            throw new Error("No shipment was found for that tracking number.");
          setResult(fromAdmin(matches[0]));
        }
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Tracking information could not be loaded.",
        );
      } finally {
        setLoading(false);
      }
    },
    [mode],
  );

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void track(query);
  }

  function trackParcel(parcelNumber: string) {
    setQuery(parcelNumber);
    void track(parcelNumber);
  }

  const detailsHref = result
    ? mode === "client"
      ? `/client/shipments/${result.draftId}`
      : `/dashboard/shipments/${result.draftId}`
    : "#";

  return (
    <div className="mx-auto max-w-8xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-950">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>
      </div>

      <section className="border border-slate-300 bg-white rounded-2xl ">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="font-semibold text-slate-950">Find Shipment</h2>
          <p className="mt-1 text-sm text-slate-500">
            Search using a Swiftline tracking number, carrier shipment number,
            or parcel number.
          </p>
        </div>
        <form onSubmit={search} className="flex flex-col gap-3 p-5 sm:flex-row">
          <label className="relative flex-1">
            <span className="sr-only">Tracking number</span>
            <FiSearch
              aria-hidden="true"
              className="absolute left-3 top-3.5 h-4 w-4 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Example: SLDL20072026000001"
              className="h-11  rounded-xl w-full border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-950 outline-none focus:border-blue-900 focus:ring-1 focus:ring-blue-900"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-11 items-center rounded-4xl justify-center gap-2 bg-blue-950 px-6 text-sm font-semibold text-white hover:bg-blue-900 disabled:bg-slate-400"
          >
            <FiSearch aria-hidden="true" />
            {loading ? "Searching..." : "Track Shipment"}
          </button>
        </form>

        {shipments.length ? (
          <div className="border-t border-slate-200 px-5 py-5">
            <div className="mb-4 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-semibold uppercase text-slate-400">
                Or pick a parcel
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Select Shipment
              </span>
              <div className="relative mt-2">
                <select
                  value={selectedShipmentId}
                  onChange={(event) => setSelectedShipmentId(event.target.value)}
                  className="h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-11 text-sm text-slate-950 outline-none transition focus:border-blue-900 focus:ring-1 focus:ring-blue-900"
                >
                  <option value="">Choose from recent shipments</option>
                  {shipments.map((shipment) => (
                    <option key={shipment.id} value={shipment.id}>
                      {shipmentLabel(shipment)}
                    </option>
                  ))}
                </select>
                <FiChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                />
              </div>
            </label>

            {selectedShipment ? (
              parcels.length ? (
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Parcels- select one to track
                  </p>
                  <ul className="mt-2 grid gap-2 sm:grid-cols-4">
                    {parcels.map((parcel) => {
                      const number =
                        parcel.forwardingNumber || parcel.swiftlineNumber;
                      const active =
                        number.toLowerCase() === query.trim().toLowerCase();
                      return (
                        <li key={number}>
                          <button
                            type="button"
                            onClick={() => trackParcel(number)}
                            disabled={loading}
                            className={`w-full rounded-xl border px-4 py-3 text-left transition disabled:opacity-60 ${
                              active
                                ? "border-blue-900 bg-blue-50"
                                : "border-slate-300 bg-white hover:border-blue-900"
                            }`}
                          >
                            <span className="flex items-center  text-sm  tracking-wide text-slate-950">
                              {/* <FiTruck
                                aria-hidden="true"
                                className="h-4 w-4 shrink-0 text-blue-900"
                              /> */}
                              {number}
                            </span>
                            {parcel.swiftlineNumber &&
                            parcel.swiftlineNumber !== number ? (
                              <span className="mt-1 block  text-xs text-slate-500">
                                {parcel.swiftlineNumber}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-500">
                  No parcel numbers have been assigned to this shipment yet.
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </section>

      {error ? (
        <div className="mt-5 flex rounded-2xl items-start  der border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <FiAlertCircle className=" shrink-0 mr-2 mt-0.5" />
          <div>
            <p className="font-semibold">
              Unable to find shipment {""}
              {error}
            </p>
          </div>
        </div>
      ) : null}
      {!searched && !result ? (
        <div className="mt-5 border border-dashed border-slate-300 bg-white p-10 text-center rounded-2xl">
          {/* <FiPackage className="mx-auto  h-6 w-6 text-blue-900" />
           */}
           <Image
            src="/logo.svg"
            alt="Track Shipment"
            height={100}
            width={100}
            className="mx-auto h-12 w-30"
          />
        
       
          <p className="mt-3 font-semibold text-slate-900">
            Tracking details will appear here
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Enter one of the tracking numbers printed on the shipment label.
          </p>
        </div>
      ) : null}

      {result ? (
        <div className="mt-5">
          <TrackingResult
            record={result}
            trackedNumber={trackedNumber}
            detailsHref={detailsHref}
          />
        </div>
      ) : null}
    </div>
  );
}

