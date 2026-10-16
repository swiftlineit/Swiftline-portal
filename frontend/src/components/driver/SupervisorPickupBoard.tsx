"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiArrowLeft, FiCalendar, FiClock, FiMapPin, FiPackage, FiRefreshCw, FiTruck, FiUser } from "react-icons/fi";
import { toast } from "react-toastify";
import PickupDocumentsList from "@/components/pickups/PickupDocumentsList";
import PickupProofGallery from "@/components/pickups/PickupProofGallery";
import PickupHubReceiptForm from "@/components/pickups/PickupHubReceiptForm";
import PickupHubReceiptSummary from "@/components/pickups/PickupHubReceiptSummary";
import { PickupNewBadge, PickupStatusBadge } from "@/components/pickups/PickupStatusBadge";
import type { Driver } from "@/lib/drivers";
import {
  assignInternalPickup,
  cancelInternalPickup,
  confirmInternalPickup,
  formatPickupWeightKg,
  getInternalPickup,
  listAvailablePickupDrivers,
  listInternalPickups,
  pickupVehicleTypes,
  reviewInternalPickupOtpException,
  updateInternalPickupStatus,
  type PickupDetail,
  type PickupReceivedParcel,
  type PickupSummary,
} from "@/lib/pickups";

const address = (value: Record<string, string>) => [value.addressLine1, value.addressLine2, value.townOrCity, value.county, value.postcode, value.countryName].filter(Boolean).join(", ");
const format = (value?: string | null) => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "Not set";
const formatDate = (value?: string | null) => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(value)) : "Not set";
const arrivalLabels: Record<string, string> = { MORNING: "Morning · 06:00–12:00", AFTERNOON: "Afternoon · 12:00–17:00", EVENING: "Evening · 17:00–22:00", EXACT: "Exact time" };

export default function SupervisorPickupBoard() {
  const [pickups, setPickups] = useState<PickupSummary[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selected, setSelected] = useState<PickupDetail | null>(null);
  const [driverId, setDriverId] = useState("");
  const [vehicle, setVehicle] = useState({ source: "DRIVER_OWNED", type: "", registrationNumber: "" });
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [pickupResult, driverResult] = await Promise.all([listInternalPickups(), listAvailablePickupDrivers()]);
    setPickups(pickupResult.pickups);
    setDrivers(driverResult.drivers);
  }

  useEffect(() => {
    let active = true;
    void Promise.all([listInternalPickups(), listAvailablePickupDrivers()])
      .then(([pickupResult, driverResult]) => {
        if (active) { setPickups(pickupResult.pickups); setDrivers(driverResult.drivers); }
      })
      .catch((caught) => toast.error(caught instanceof Error ? caught.message : "Unable to load dispatch."));
    return () => { active = false; };
  }, []);

  async function open(id: string) {
    setBusy(true); setShowCancel(false);
    try { setSelected((await getInternalPickup(id)).pickup); }
    catch (caught) { toast.error(caught instanceof Error ? caught.message : "Unable to open pickup."); }
    finally { setBusy(false); }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true);
    try {
      const result = await confirmInternalPickup(selected.id);
      setSelected(result.pickup); toast.success("Pickup approved. Driver assignment is optional."); await load();
    } catch (caught) { toast.error(caught instanceof Error ? caught.message : "Unable to approve pickup."); }
    finally { setBusy(false); }
  }

  async function updateStatus(status: "IN_PROGRESS" | "RECEIVED_AT_DELHI_HUB", receivedParcels?: PickupReceivedParcel[]) {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await updateInternalPickupStatus(selected.id, status, receivedParcels);
      setSelected(result.pickup); toast.success(status === "IN_PROGRESS" ? "Pickup marked as started." : result.pickup.status === "COMPLETED_WITH_MISSING_PARCELS" ? "Pickup completed with parcels not received at the hub." : "Pickup received at Delhi hub."); await load();
    } catch (caught) { toast.error(caught instanceof Error ? caught.message : "Pickup status could not be updated."); }
    finally { setBusy(false); }
  }

  async function assign(event: FormEvent) {
    event.preventDefault(); const attempt = selected?.attempts[0]; if (!selected || !attempt) return;
    setBusy(true);
    try {
      const result = await assignInternalPickup(selected.id, { attemptId: attempt._id, driverProfileId: driverId, vehicle });
      setSelected(result.pickup); toast.success("Driver assigned."); await load();
    } catch (caught) { toast.error(caught instanceof Error ? caught.message : "Unable to assign driver."); }
    finally { setBusy(false); }
  }

  async function review(attemptId: string, approved: boolean) {
    if (!selected) return; setBusy(true);
    try {
      const result = await reviewInternalPickupOtpException(selected.id, { attemptId, approved });
      setSelected(result.pickup); toast.success(result.message); await load();
    } catch (caught) { toast.error(caught instanceof Error ? caught.message : "Unable to review exception."); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!selected || cancelReason.trim().length < 3) return; setBusy(true);
    try {
      const result = await cancelInternalPickup(selected.id, cancelReason);
      setSelected(result.pickup); setCancelReason(""); setShowCancel(false); toast.success(result.message); await load();
    } catch (caught) { toast.error(caught instanceof Error ? caught.message : "Unable to cancel pickup."); }
    finally { setBusy(false); }
  }

  if (selected) {
    const attempt = selected.attempts[0] ?? null;
    const canCancel = ["REQUESTED", "CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED", "MISSED"].includes(selected.status) && (!attempt || ["SCHEDULED", "ASSIGNED"].includes(attempt.status));
    const canStart = !selected.pickupStartedAt && ["CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED"].includes(selected.status);
    const canReceive = ["IN_PROGRESS", "COLLECTED", "PARTIALLY_COLLECTED"].includes(selected.status);
    const branchName = selected.branchId && typeof selected.branchId !== "string" ? selected.branchId.name : "Delhi hub";

    return <div className="space-y-4">
      <button type="button" onClick={() => setSelected(null)} className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold shadow-sm"><FiArrowLeft />All pickups</button>
      <section className="rounded-3xl bg-white p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pickup request</p><h1 className="mt-1 text-xl font-bold text-slate-950">{selected.requestNumber}</h1><p className="mt-2 text-sm font-medium text-slate-700">{selected.businessAccountName || "Business account"}</p></div><PickupStatusBadge status={selected.status} /></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pickup contact</p><p className="mt-1 text-sm font-semibold text-slate-900">{selected.pickupContact.name}</p><p className="mt-1 text-xs text-slate-600">{selected.pickupContact.phone}</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Transport / courier</p><p className="mt-1 text-sm font-semibold text-slate-900">{selected.transportCompany || "Not provided"}</p></div>
          <p className="rounded-xl bg-slate-50 p-3 text-sm"><FiMapPin className="mb-1 text-[#0D1282]" /><span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Collection address</span><span className="mt-1 block text-slate-800">{address(selected.pickupAddress)}</span></p>
          <p className="rounded-xl bg-slate-50 p-3 text-sm"><FiCalendar className="mb-1 text-[#0D1282]" /><span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Dispatch</span><strong className="mt-1 block">{format(selected.dispatchAt || selected.requestedWindow.startAt)}</strong></p>
          <p className="rounded-xl bg-slate-50 p-3 text-sm"><FiClock className="mb-1 text-[#0D1282]" /><span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Expected Delhi arrival</span><strong className="mt-1 block">{selected.expectedDelhiArrival ? `${formatDate(selected.expectedDelhiArrival.date)} · ${selected.expectedDelhiArrival.window === "EXACT" ? `Exact · ${format(selected.expectedDelhiArrival.exactAt)}` : arrivalLabels[selected.expectedDelhiArrival.window]}` : "Not specified"}</strong></p>
          <p className="rounded-xl bg-blue-50 p-3 text-sm"><FiPackage className="mb-1 text-[#0D1282]" /><strong>{selected.shipmentCount} shipments · {selected.totalBoxes ?? selected.parcelCount} boxes</strong><span className="mt-1 block text-xs text-slate-600">{formatPickupWeightKg(selected.totalWeightKg, true)}</span></p>
          {selected.handlingRemarks || selected.instructions ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 sm:col-span-2"><strong>Handling remarks</strong><span className="mt-1 block">{selected.handlingRemarks || selected.instructions}</span></p> : null}
          {selected.pickupPartnerInfo ? <p className="rounded-xl bg-slate-50 p-3 text-sm sm:col-span-2"><strong>Pickup partner</strong><span className="mt-1 block">{selected.pickupPartnerInfo}</span></p> : null}
        </div>
        <p className="mt-4 flex gap-2 text-xs text-slate-500"><FiUser className="mt-0.5" />All times shown in India Standard Time.</p>
      </section>

      {["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(selected.status) ? <section className={`rounded-2xl border p-4 ${selected.status === "COMPLETED_WITH_MISSING_PARCELS" ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}><strong className="text-slate-950">{selected.status === "COMPLETED_WITH_MISSING_PARCELS" ? "Completed with parcels not received at " : "Received at "}{branchName}</strong><p className="mt-1 text-sm text-slate-700">{format(selected.receivedAtDelhiHubAt)}</p></section> : null}
      {selected.status === "CANCELLED" ? <section className="rounded-2xl bg-slate-200 p-4"><strong>Cancelled by {selected.cancellationSource === "CLIENT" ? "Client" : "Admin"}</strong><p className="mt-1 text-xs text-slate-500">{format(selected.cancelledAt)}</p><p className="mt-2 text-sm">{selected.cancellationReason}</p></section> : null}

      <section className="rounded-3xl border border-indigo-100 bg-white p-4 shadow-sm">
        <h2 className="font-bold text-slate-950">Quick pickup status</h2><p className="mt-1 text-sm text-slate-500">These updates also notify the pickup requester.</p>
        {canStart ? <button type="button" disabled={busy} onClick={() => void updateStatus("IN_PROGRESS")} className="mt-3 h-11 w-full rounded-xl bg-[#0D1282] font-semibold text-white disabled:opacity-50">Mark pickup started</button> : null}
        {canReceive ? <PickupHubReceiptForm key={selected.id} pickup={selected} busy={busy} onComplete={(parcels) => updateStatus("RECEIVED_AT_DELHI_HUB", parcels)} /> : null}
        {!canStart && !canReceive && !["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(selected.status) ? <p className="mt-3 text-sm text-slate-500">Approve the request before starting a pickup.</p> : null}
      </section>

      {selected.status === "REQUESTED" || selected.status === "ACTION_REQUIRED" || selected.status === "PARTIALLY_COLLECTED" ? <form onSubmit={confirm} className="rounded-3xl bg-white p-4 shadow-sm"><h2 className="font-bold">{selected.status === "PARTIALLY_COLLECTED" ? "Schedule remaining pickup" : "Approve pickup request"}</h2><p className="mt-1 text-sm text-slate-500">Dispatch: {format(selected.dispatchAt || selected.requestedWindow.startAt)}. Approval uses this time; no second collection window is needed.</p><button disabled={busy} className="mt-3 h-11 w-full rounded-xl bg-[#0D1282] font-semibold text-white disabled:opacity-50">{selected.status === "PARTIALLY_COLLECTED" ? "Schedule retry" : "Approve pickup"}</button></form> : null}

      {attempt && ["SCHEDULED", "ASSIGNED"].includes(attempt.status) ? <form onSubmit={assign} className="rounded-3xl bg-white p-4 shadow-sm"><h2 className="font-bold">Optional driver assignment</h2><p className="mt-1 text-sm text-slate-500">Continue with driver proof and parcel scanning when needed.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><select required value={driverId} onChange={(event) => setDriverId(event.target.value)} className="h-12 rounded-xl border border-slate-300 px-3"><option value="">Select active driver</option>{drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.firstName} {driver.lastName} · {driver.engagementType.replace(/_/g, " ")}</option>)}</select><select value={vehicle.source} onChange={(event) => setVehicle((current) => ({ ...current, source: event.target.value }))} className="h-12 rounded-xl border border-slate-300 px-3"><option value="COMPANY_OWNED">Company vehicle</option><option value="DRIVER_OWNED">Driver vehicle</option><option value="HIRED">Hired vehicle</option></select><select required value={vehicle.type} onChange={(event) => setVehicle((current) => ({ ...current, type: event.target.value }))} className="h-12 rounded-xl border border-slate-300 px-3"><option value="">Select vehicle type</option>{pickupVehicleTypes.map((type) => <option key={type}>{type}</option>)}</select><input required placeholder="Registration number" value={vehicle.registrationNumber} onChange={(event) => setVehicle((current) => ({ ...current, registrationNumber: event.target.value }))} className="h-12 rounded-xl border border-slate-300 px-3 uppercase" /></div><button disabled={busy || !driverId} className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-amber-400 font-bold text-amber-950"><FiTruck />Assign driver</button></form> : null}

      {selected.attempts.filter((item) => item.otpExceptionRequestedAt && !item.otpExceptionApprovedAt && !item.otpExceptionRejectedAt).map((item) => <section key={item._id} className="rounded-3xl border border-amber-200 bg-amber-50 p-4"><h2 className="font-bold text-amber-950">OTP exception requested</h2><p className="mt-2 text-sm text-amber-900">{item.otpExceptionReason}</p><div className="mt-3 grid grid-cols-2 gap-2"><button disabled={busy} onClick={() => void review(item._id, true)} className="h-11 rounded-xl bg-emerald-600 text-sm font-semibold text-white">Approve</button><button disabled={busy} onClick={() => void review(item._id, false)} className="h-11 rounded-xl border border-red-300 bg-white text-sm font-semibold text-red-700">Reject</button></div></section>)}
      {selected.shipments.length ? <section className="rounded-2xl bg-white p-4 shadow-sm"><h2 className="font-bold">Linked shipments</h2><div className="mt-3 space-y-2">{selected.shipments.map((shipment) => <div key={shipment._id} className="rounded-xl bg-slate-50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{shipment.trackingNumber}</strong><PickupStatusBadge status={shipment.status} /></div><p className="mt-1 text-xs text-slate-500">{shipment.parcels.length} boxes · {shipment.parcels.map((parcel) => parcel.parcelNumber).join(", ")}</p><PickupHubReceiptSummary shipment={shipment} /></div>)}</div></section> : null}
      {!selected.shipments.length ? <section className="rounded-2xl bg-white p-4 text-sm text-slate-600">No shipments linked · {selected.totalBoxes ?? 0} boxes · {formatPickupWeightKg(selected.totalWeightKg)}</section> : null}
      <PickupDocumentsList pickupId={selected.id} documents={selected.documents} audience="internal" />
      {attempt ? <section className="rounded-2xl bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><strong>Attempt {attempt.sequence}</strong><PickupStatusBadge status={attempt.status} /></div><p className="mt-2 text-xs text-slate-500">{format(attempt.scheduledWindow.startAt)} – {format(attempt.scheduledWindow.endAt)}</p>{attempt.assignedDriverUserId ? <p className="mt-2 text-sm">Driver: {attempt.assignedDriverUserId.name || `${attempt.assignedDriverUserId.firstName ?? ""} ${attempt.assignedDriverUserId.lastName ?? ""}`}</p> : <p className="mt-2 text-sm text-slate-500">No driver assigned.</p>}</section> : null}
      <PickupProofGallery pickupId={selected.id} attempts={selected.attempts} audience="internal" />
      {canCancel ? <section className="rounded-3xl border border-red-200 bg-white p-4">{showCancel ? <><textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="Cancellation reason" className="min-h-20 w-full rounded-xl border border-red-300 p-3" /><div className="mt-2 grid grid-cols-2 gap-2"><button type="button" onClick={() => setShowCancel(false)} className="h-11 rounded-xl border border-slate-300 font-semibold">Keep</button><button type="button" disabled={busy || cancelReason.trim().length < 3} onClick={() => void cancel()} className="h-11 rounded-xl bg-red-600 font-semibold text-white disabled:bg-slate-300">Cancel pickup</button></div></> : <button type="button" onClick={() => setShowCancel(true)} className="h-11 w-full rounded-xl border border-red-300 font-semibold text-red-700">Cancel pickup request</button>}</section> : null}
    </div>;
  }

  return <div className="space-y-4">
    <div className="flex items-start justify-between gap-3"><div><h1 className="text-2xl font-bold">Pickup dispatch</h1><p className="mt-1 text-sm text-slate-500">Requests for your assigned branches. Times are shown in India Standard Time.</p></div><button aria-label="Refresh pickups" disabled={busy} onClick={() => void load()} className="flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-sm"><FiRefreshCw /></button></div>
    <div className="grid gap-3 md:grid-cols-2">{pickups.map((pickup) => <button key={pickup.id} onClick={() => void open(pickup.id)} className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-[#0D1282]">
      <div className="flex flex-wrap justify-between gap-2"><strong>{pickup.requestNumber}</strong><div className="flex gap-2">{pickup.status === "REQUESTED" ? <PickupNewBadge /> : null}<PickupStatusBadge status={pickup.status} /></div></div>
      <p className="mt-2 text-sm font-semibold text-slate-700">{pickup.businessAccountName || pickup.pickupContact.name}</p>
      <p className="mt-1 text-xs text-slate-600">Dispatch {format(pickup.dispatchAt || pickup.requestedWindow.startAt)} · {pickup.totalBoxes ?? pickup.parcelCount} boxes · {formatPickupWeightKg(pickup.totalWeightKg)}</p>
      <p className="mt-1 line-clamp-2 text-xs text-slate-500">{address(pickup.pickupAddress)}</p>
    </button>)}</div>
    {!pickups.length ? <p className="rounded-3xl bg-white p-10 text-center text-sm text-slate-500">No pickup requests in your branches.</p> : null}
  </div>;
}
