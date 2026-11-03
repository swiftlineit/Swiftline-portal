"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FiDownload, FiEdit2, FiMapPin, FiX } from "react-icons/fi";
import OperatorSelect from "@/components/operators/OperatorSelect";
import OperatorShipmentCancellationPanel from "@/components/operators/OperatorShipmentCancellationPanel";
import OperatorShipmentAmendmentPanel from "@/components/operators/OperatorShipmentAmendmentPanel";
import ShipmentKycDocumentsPanel, { collectShipmentKycDocuments } from "@/components/shipments/ShipmentKycDocumentsPanel";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import { OperatorLoadingIndicator } from "@/components/operators/OperatorLoadingState";
import {
  downloadOperatorShipmentDocument,
  getOperatorShipmentDetails,
  getOperatorShipmentLabelAccessUrl,
  openOperatorShipmentKycDocument,
  openOperatorShipmentParcelKycDocument,
  updateOperatorShipmentTracking,
  type OperatorShipmentDetails
} from "@/lib/operatorShipments";

const TRACKING_STATUSES = [
  { value: "PARCEL_COLLECTED", label: "Parcel collected" },
  { value: "IN_TRANSIT", label: "In transit" },
  { value: "DESTINATION_ARRIVED", label: "Arrived in destination country" },
  { value: "OUT_FOR_DELIVERY", label: "Out for delivery" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "RETURNED", label: "Returned" }
] as const;

function humanize(value?: string | null) {
  return (value || "Pending").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatMoney(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

function statusBadgeTone(status?: string | null) {
  const normalized = status?.toUpperCase() ?? "";
  if (normalized === "DELIVERED") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (normalized === "RETURNED") return "bg-amber-50 text-amber-900 ring-amber-200";
  if (["CANCELLED", "SHIPMENT_CANCELLED", "REJECTED", "FAILED", "EXCEPTION"].some((value) => normalized.includes(value))) {
    return "bg-rose-50 text-rose-800 ring-rose-200";
  }
  if (["PARCEL_COLLECTED", "IN_TRANSIT", "DESTINATION_ARRIVED", "OUT_FOR_DELIVERY"].includes(normalized)) {
    return "bg-sky-50 text-sky-800 ring-sky-200";
  }
  if (["PENDING", "NEEDS_REVIEW", "REVIEW_REQUIRED", "ON_HOLD"].includes(normalized)) {
    return "bg-amber-50 text-amber-900 ring-amber-200";
  }
  if (!normalized) return "bg-slate-100 text-slate-700 ring-slate-200";
  return "bg-indigo-50 text-[#0D1282] ring-indigo-200";
}

function textValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function displayAddress(address: Record<string, unknown> | undefined) {
  if (!address) return "Address not available";
  const fields = ["addressLine1", "addressLine2", "townOrCity", "county", "stateOrProvince", "postcode", "countryName", "countryCode"];
  return fields.map((field) => textValue(address, field)).filter(Boolean).join(", ") || "Address not available";
}

function partyName(address: Record<string, unknown> | undefined) {
  return textValue(address, "companyName") || textValue(address, "contactName") || "Not available";
}

function PartyDetails({
  title,
  address,
  showMaskedAadhaar = false
}: {
  title: string;
  address?: Record<string, unknown>;
  showMaskedAadhaar?: boolean;
}) {
  const rows = [
    ["Company or name", partyName(address)],
    ["Contact", textValue(address, "contactName")],
    ["Email", textValue(address, "email")],
    ["Phone", [textValue(address, "mobileCountryCode"), textValue(address, "mobileNumber")].filter(Boolean).join(" ")],
    ["Address", displayAddress(address)],
    ...(showMaskedAadhaar && textValue(address, "aadhaarNumber")
      ? [["Aadhaar", textValue(address, "aadhaarNumber")]]
      : [])
  ].filter(([, value]) => value);

  return (
    <div className="min-w-0 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      <dl className="mt-3 space-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="mt-0.5 break-words leading-5 text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function OperatorShipmentDetail({ operatorSlug, shipmentDraftId }: { operatorSlug: string; shipmentDraftId: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [shipment, setShipment] = useState<OperatorShipmentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyAction, setBusyAction] = useState("");
  const [trackingStatus, setTrackingStatus] = useState("");
  const [trackingNote, setTrackingNote] = useState("");
  const [trackingLocation, setTrackingLocation] = useState("");
  const [trackingEventAt, setTrackingEventAt] = useState("");
  const [trackingEditorOpen, setTrackingEditorOpen] = useState(false);
  const trackingEditorRef = useRef<HTMLFormElement | null>(null);

  const canUpdateTracking = !supportReadOnly && Boolean(session && ["OPERATOR_ADMIN", "OPERATIONS"].includes(session.membership.role));
  const canDownloadKyc = !supportReadOnly && Boolean(session && session.membership.role !== "CLIENT");

  useEffect(() => {
    if (trackingEditorOpen) trackingEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [trackingEditorOpen]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorSession(operatorSlug, controller.signal).then((operator) => {
      if (active) setSession(operator);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object" ? cause as { canonicalSlug?: unknown } : null;
      if (typeof requestError?.canonicalSlug === "string" && requestError.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/shipments/${encodeURIComponent(shipmentDraftId)}`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load operator access.");
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, shipmentDraftId, router]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const controller = new AbortController();
    getOperatorShipmentDetails(operatorSlug, shipmentDraftId, session.membership.role === "CLIENT", controller.signal)
      .then((result) => {
        if (!active) return;
        setShipment(result.shipment);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Unable to load this shipment.");
        setShipment(null);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, shipmentDraftId, session, refreshKey]);

  const events = useMemo(() => [...(shipment?.events ?? [])].sort((left, right) => new Date(right.eventAt).getTime() - new Date(left.eventAt).getTime()), [shipment]);
  const currentEvent = shipment?.currentEvent ?? events[0] ?? null;
  const currentStatus = currentEvent?.status ?? shipment?.dpdShipment?.status ?? "";
  const currentStatusLabel = currentEvent?.statusLabel || humanize(currentStatus);
  const currentTrackingIndex = TRACKING_STATUSES.findIndex((item) => item.value === currentStatus);
  const availableStatuses = currentStatus === "DELIVERED" || currentStatus === "RETURNED"
    ? []
    : TRACKING_STATUSES.filter((_, index) => index > currentTrackingIndex);
  const consignee = shipment?.shipmentDraft.consignee as unknown as Record<string, unknown> | undefined;
  const consignor = shipment?.shipmentDraft.consignor as Record<string, unknown> | undefined;
  const parcels = shipment?.shipmentDraft.parcelList ?? [];
  const totalWeightKg = parcels.reduce((total, parcel) => total + (Number(parcel.weightKg) || 0), 0);
  const goods = parcels.flatMap((parcel) => {
    const items = parcel.items ?? [];
    return items.length
      ? items.map((item) => ({ sequence: parcel.sequence, ...item }))
      : parcel.contentsDescription
        ? [{ sequence: parcel.sequence, description: parcel.contentsDescription, hsnCode: "", quantity: 1, unitRate: 0 }]
        : [];
  });
  const kycDocuments = useMemo(() => shipment ? collectShipmentKycDocuments({
    documents: shipment.shipmentDraft.kycDocuments,
    parcels: shipment.shipmentDraft.parcelList,
    kycUseForAllParcels: shipment.shipmentDraft.kycUseForAllParcels
  }) : [], [shipment]);

  async function handleLabelDownload(labelId: string) {
    setBusyAction(`label:${labelId}`);
    setActionError("");
    try {
      const access = await getOperatorShipmentLabelAccessUrl(operatorSlug, shipmentDraftId, labelId);
      window.location.assign(access.url);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to open this internal label.");
      setBusyAction("");
    }
  }

  async function handleDocumentDownload(documentKind: "tax-invoice" | "shipment-invoice-pdf" | "shipment-invoice-xlsx") {
    setBusyAction(documentKind);
    setActionError("");
    try {
      await downloadOperatorShipmentDocument(operatorSlug, shipmentDraftId, documentKind);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to download this shipment document.");
    } finally {
      setBusyAction("");
    }
  }

  async function handleTrackingUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trackingStatus || busyAction) return;
    setBusyAction("tracking");
    setActionError("");
    try {
      await updateOperatorShipmentTracking(operatorSlug, shipmentDraftId, {
        status: trackingStatus as typeof TRACKING_STATUSES[number]["value"],
        note: trackingNote.trim() || undefined,
        location: trackingLocation.trim() || undefined,
        eventAt: trackingEventAt ? new Date(trackingEventAt).toISOString() : undefined
      });
      setTrackingStatus("");
      setTrackingNote("");
      setTrackingLocation("");
      setTrackingEventAt("");
      setTrackingEditorOpen(false);
      setLoading(true);
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Unable to save this tracking update.");
    } finally {
      setBusyAction("");
    }
  }

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">

      <main className="mx-auto w-full max-w-[1440px] px-3 py-5 sm:px-6 sm:py-8 lg:px-8">
        {loading ? <OperatorLoadingIndicator label="Loading shipment…" className="min-h-[calc(100dvh-10rem)]" /> : null}
        {error ? <div role="alert" className="rounded-lg border border-rose-200 bg-white p-4 text-sm text-rose-800">{error}</div> : null}
        {!loading && shipment ? (
          <>
            <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h1 className="text-lg font-semibold text-slate-950">Shipment details</h1>
                  <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">AWB / tracking number</p>
                  <p className="mt-1 break-all text-2xl font-semibold tabular-nums tracking-[-0.02em] text-slate-950 sm:text-3xl">{shipment.dpdShipment?.swiftlineTrackingNumber || "Booking in progress"}</p>
                  <p className="mt-2 text-sm text-slate-600">Booked {formatDateTime(shipment.dpdShipment?.createdAt)}{shipment.branch?.name ? ` · ${shipment.branch.name}` : ""}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <span className={`inline-flex min-h-9 items-center rounded-full px-3.5 py-1 text-sm font-semibold ring-1 ring-inset ${statusBadgeTone(currentStatus)}`}>{currentStatusLabel}</span>
                  {canUpdateTracking && availableStatuses.length > 0 ? (
                    <button
                      type="button"
                      aria-expanded={trackingEditorOpen}
                      aria-controls="operator-tracking-editor"
                      onClick={() => setTrackingEditorOpen((open) => !open)}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
                    >
                      {trackingEditorOpen ? <FiX aria-hidden="true" className="h-4 w-4" /> : <FiEdit2 aria-hidden="true" className="h-4 w-4" />}
                      {trackingEditorOpen ? "Hide status update" : "Update status"}
                    </button>
                  ) : null}
                </div>
              </div>
            </section>

            {actionError ? <div role="alert" className="mt-5 rounded-lg border border-rose-200 bg-white p-4 text-sm text-rose-800">{actionError}</div> : null}

            <section aria-labelledby="operator-parties-heading" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 id="operator-parties-heading" className="text-base font-semibold text-slate-950">Consignor, consignee and KYC</h2><p className="mt-1 text-sm text-slate-600">Shipment contacts and the documents recorded for this booking.</p></div>
              <div className="grid grid-cols-1 divide-y divide-slate-200 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
                <PartyDetails title="Consignor" address={consignor} showMaskedAadhaar />
                <PartyDetails title="Consignee" address={consignee} />
                <div className="min-w-0 p-4 sm:p-5">
                  <h3 className="text-sm font-semibold text-slate-950">Shipment details</h3>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                    <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Service</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{humanize(shipment.shipmentDraft.serviceType)}</dd></div>
                    <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Parcels</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{shipment.shipmentDraft.parcelCount || parcels.length || 0}</dd></div>
                    <div className="col-span-2"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total weight</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{totalWeightKg ? `${totalWeightKg.toFixed(2)} kg` : "Not recorded"}</dd></div>
                  </dl>
                  {parcels.length ? (
                    <div className="mt-4 border-t border-slate-200 pt-3">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Parcel weights</h4>
                      <ul className="mt-2 divide-y divide-slate-100">
                        {parcels.map((parcel) => {
                          const dimensions = [parcel.lengthCm, parcel.widthCm, parcel.heightCm].filter((value) => Number(value) > 0).join(" × ");
                          return (
                            <li key={parcel.sequence} className="flex min-w-0 items-center justify-between gap-3 py-2">
                              <div className="min-w-0"><p className="text-sm font-medium text-slate-800">Parcel {parcel.sequence}</p>{dimensions ? <p className="mt-0.5 text-xs text-slate-500">{dimensions} cm</p> : null}</div>
                              <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{Number(parcel.weightKg) ? `${Number(parcel.weightKg).toFixed(2)} kg` : "Not recorded"}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="border-t border-slate-200 px-4 py-4 sm:px-5">
                <ShipmentKycDocumentsPanel
                  documents={kycDocuments}
                  title="Shipment KYC documents"
                  previewOnDocumentName
                  canDownload={canDownloadKyc}
                  showUploadedAt
                  className="mt-0 border-t-0 pt-0"
                  onOpen={(document) => document.sequence
                    ? openOperatorShipmentParcelKycDocument(operatorSlug, shipmentDraftId, document.sequence, document.type)
                    : openOperatorShipmentKycDocument(operatorSlug, shipmentDraftId, document.type)}
                />
              </div>
            </section>

            <section aria-labelledby="operator-documents-heading" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 id="operator-documents-heading" className="text-base font-semibold text-slate-950">Shipment documents</h2><p className="mt-1 text-sm text-slate-600">Documents are available as soon as booking is complete.</p></div>
              <div className="divide-y divide-slate-200">
                <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="min-w-0"><p className="font-semibold text-slate-900">Tax invoice</p><p className="mt-1 break-all text-sm text-slate-600">{shipment.taxInvoiceNumber || shipment.shipmentInvoice?.invoiceNumber || "Issued at booking"}{shipment.shipmentInvoice?.totalAmountMinor != null ? ` · ${formatMoney(shipment.shipmentInvoice.totalAmountMinor, shipment.shipmentInvoice.currency || "INR")}` : ""}</p><p className="mt-1 text-xs text-slate-500">Freight charges and credit billing</p></div>
                  <button type="button" onClick={() => void handleDocumentDownload("tax-invoice")} disabled={Boolean(busyAction)} className="inline-flex min-h-10 w-full shrink-0 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:opacity-55 sm:w-[236px]"><FiDownload aria-hidden="true" className="h-4 w-4" />{busyAction === "tax-invoice" ? "Preparing PDF…" : "Download tax invoice"}</button>
                </div>
                <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div><p className="font-semibold text-slate-900">Shipment invoice</p><p className="mt-1 text-sm text-slate-600">Goods declaration and declared values</p></div>
                  <div className="flex w-full gap-2 sm:w-[236px]">
                    <button type="button" onClick={() => void handleDocumentDownload("shipment-invoice-pdf")} disabled={Boolean(busyAction)} className="inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-md border border-slate-300 px-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:opacity-55"><FiDownload aria-hidden="true" className="h-4 w-4 shrink-0" />{busyAction === "shipment-invoice-pdf" ? "Preparing PDF…" : "PDF"}</button>
                    <button type="button" onClick={() => void handleDocumentDownload("shipment-invoice-xlsx")} disabled={Boolean(busyAction)} className="inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-md border border-emerald-600 px-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-55"><FiDownload aria-hidden="true" className="h-4 w-4 shrink-0" />{busyAction === "shipment-invoice-xlsx" ? "Preparing Excel…" : "Excel"}</button>
                  </div>
                </div>
                <div className="px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between"><div><p className="font-semibold text-slate-900">Internal labels</p><p className="mt-1 text-sm text-slate-600">Labels for the operator’s shipment workflow</p></div>{shipment.labels.length ? <span className="text-sm text-slate-500">{shipment.labels.length} {shipment.labels.length === 1 ? "label" : "labels"}</span> : null}</div>
                  {shipment.labels.length ? <ul className="mt-3 divide-y divide-slate-200 border-t border-slate-200">{shipment.labels.map((label) => <li key={label.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">Parcel {label.parcelNumber || "label"}</p><p className="mt-0.5 text-xs text-slate-500">Internal label · {label.format}</p></div><button type="button" onClick={() => void handleLabelDownload(label.id)} disabled={Boolean(busyAction)} aria-label={`Download internal label for parcel ${label.parcelNumber || "shipment"}`} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:opacity-50"><FiDownload aria-hidden="true" className="h-4 w-4" /></button></li>)}</ul> : <p className="mt-3 text-sm text-slate-600">No internal labels are available.</p>}
                </div>
              </div>
            </section>

            <section aria-labelledby="operator-tracking-heading" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 id="operator-tracking-heading" className="text-base font-semibold text-slate-950">Tracking timeline</h2></div>
              {canUpdateTracking && trackingEditorOpen ? (
                <form id="operator-tracking-editor" ref={trackingEditorRef} onSubmit={(event) => void handleTrackingUpdate(event)} className="grid gap-4 border-b border-slate-200 bg-slate-50/70 p-4 sm:grid-cols-2 sm:p-5">
                  <div className="flex items-start justify-between gap-3 sm:col-span-2"><div><h3 className="text-sm font-semibold text-slate-950">Update shipment status</h3><p className="mt-1 text-sm text-slate-600">This update will appear in the shipment timeline.</p></div><button type="button" aria-label="Close status update" onClick={() => setTrackingEditorOpen(false)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><FiX aria-hidden="true" className="h-4 w-4" /></button></div>
                  <OperatorSelect id="operator-tracking-status" label="Next status" value={trackingStatus} options={availableStatuses.map((item) => ({ value: item.value, label: item.label }))} placeholder="Select a status" disabled={!availableStatuses.length || Boolean(busyAction)} onChange={setTrackingStatus} />
                  <div><label htmlFor="operator-tracking-location" className="mb-1.5 block text-sm font-medium text-slate-700">Location</label><div className="relative"><FiMapPin aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input id="operator-tracking-location" value={trackingLocation} onChange={(event) => setTrackingLocation(event.target.value)} maxLength={120} className="min-h-11 w-full rounded-md border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20" /></div></div>
                  <div><label htmlFor="operator-tracking-note" className="mb-1.5 block text-sm font-medium text-slate-700">Customer note</label><input id="operator-tracking-note" value={trackingNote} onChange={(event) => setTrackingNote(event.target.value)} maxLength={500} className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20" /></div>
                  <div><label htmlFor="operator-tracking-date" className="mb-1.5 block text-sm font-medium text-slate-700">Event time <span className="font-normal text-slate-500">(optional)</span></label><input id="operator-tracking-date" type="datetime-local" value={trackingEventAt} onChange={(event) => setTrackingEventAt(event.target.value)} className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20" /></div>
                  <div className="sm:col-span-2 sm:flex sm:justify-end"><button type="submit" disabled={!trackingStatus || Boolean(busyAction)} className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#10166F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto">{busyAction === "tracking" ? "Saving update…" : "Save tracking update"}</button></div>
                </form>
              ) : null}
              {events.length ? (
                <ol aria-label="Shipment tracking history" className="space-y-0 px-4 py-5 sm:px-5">
                  {events.map((event, index) => {
                    const isLatest = index === 0;
                    const isLast = index === events.length - 1;
                    const note = event.note?.trim();
                    const location = event.location?.trim();
                    return (
                      <li key={event.id} className="relative grid grid-cols-[0.5rem_minmax(0,1fr)] gap-x-4 pb-5 last:pb-0">
                        {!isLast ? <span aria-hidden="true" className="absolute left-[3.5px] top-3 -bottom-1 w-px bg-sky-200" /> : null}
                        <span aria-hidden="true" className={`absolute left-0 top-1 z-10 h-2 w-2 rounded-full ${isLatest ? "bg-emerald-500 ring-4 ring-emerald-100 shadow-[0_2px_8px_rgba(34,197,94,0.4)]" : "bg-sky-300 ring-4 ring-sky-50"}`} />
                        <div className="col-start-2 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                          <h3 className={`min-w-0 font-semibold ${isLatest ? "text-slate-950" : "text-slate-800"}`}>{event.statusLabel || humanize(event.status)}</h3>
                          <time dateTime={event.eventAt} className="shrink-0 text-xs tabular-nums text-slate-500">{formatDateTime(event.eventAt)}</time>
                        </div>
                        {note ? <p className="col-start-2 mt-1 min-w-0 break-words text-sm leading-5 text-slate-600">{note}</p> : null}
                        {location ? <p className="col-start-2 mt-1 min-w-0 break-words text-xs leading-5 text-slate-500">{location}</p> : null}
                      </li>
                    );
                  })}
                </ol>
              ) : <p className="px-4 py-5 text-sm text-slate-600 sm:px-5">No tracking updates have been recorded yet.</p>}
            </section>
            {session?.membership.role === "CLIENT" ? (
              <div className="mt-5 space-y-5">
                <OperatorShipmentAmendmentPanel
                  operatorSlug={operatorSlug}
                  draftId={shipmentDraftId}
                  address={shipment.shipmentDraft.consignee}
                  parcelList={shipment.shipmentDraft.parcelList}
                  serviceType={shipment.shipmentDraft.serviceType ?? "COURIER"}
                />
                <OperatorShipmentCancellationPanel operatorSlug={operatorSlug} draftId={shipmentDraftId} />
              </div>
            ) : null}

            <section aria-labelledby="operator-goods-heading" className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 id="operator-goods-heading" className="text-base font-semibold text-slate-950">Parcels and goods</h2><p className="mt-1 text-sm text-slate-600">Declared contents and values carried with the shipment.</p></div>
              {parcels.length ? (
                <div className="divide-y divide-slate-200">
                  {parcels.map((parcel) => {
                    const parcelGoods = goods.filter((item) => item.sequence === parcel.sequence);
                    return (
                      <article key={parcel.sequence} className="px-4 py-4 sm:px-5">
                        <h3 className="font-semibold text-slate-900">Parcel {parcel.sequence}</h3>
                        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{humanize(parcel.shipmentContentType)}</p>
                        {parcelGoods.length ? (
                          <div className="mt-3 space-y-2">
                            {parcelGoods.map((item, index) => (
                              <div key={`${parcel.sequence}-${index}`} className="grid min-w-0 gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2 xl:grid-cols-4">
                                <div className="min-w-0 sm:col-span-2 xl:col-span-1"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Description</p><p className="mt-1 break-words text-sm font-medium leading-5 text-slate-900">{item.description || "Goods"}</p></div>
                                <div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">HSN</p><p className="mt-1 break-words text-sm tabular-nums text-slate-700">{item.hsnCode || "-"}</p></div>
                                <div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Quantity</p><p className="mt-1 text-sm tabular-nums text-slate-700">{item.quantity || "-"}</p></div>
                                <div className="grid min-w-0 grid-cols-2 gap-3 sm:col-span-2 xl:col-span-1">
                                  <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Unit value</p><p className="mt-1 text-sm tabular-nums text-slate-700">{item.unitRate ? formatMoney(Math.round(item.unitRate * 100), "INR") : "-"}</p></div>
                                  <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Goods value</p><p className="mt-1 text-sm tabular-nums text-slate-900">{item.unitRate ? formatMoney(Math.round(item.unitRate * (item.quantity || 0) * 100), "INR") : "-"}</p></div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : <p className="mt-3 text-sm leading-5 text-slate-600">{parcel.contentsDescription || "No item-level goods description is recorded."}</p>}
                      </article>
                    );
                  })}
                </div>
              ) : <p className="px-4 py-6 text-sm text-slate-600 sm:px-5">Parcel information is not available.</p>}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
