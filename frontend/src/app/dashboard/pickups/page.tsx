"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  FiCalendar,
  FiClock,
  FiMapPin,
  FiPackage,
  FiRefreshCw,
  FiTruck,
  FiUser,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import PickupProofGallery from "@/components/pickups/PickupProofGallery";
import PickupDocumentsList from "@/components/pickups/PickupDocumentsList";
import PickupHubReceiptForm from "@/components/pickups/PickupHubReceiptForm";
import PickupHubReceiptSummary from "@/components/pickups/PickupHubReceiptSummary";
import PickupCourierAddressBook from "@/components/pickups/PickupCourierAddressBook";
import {
  PickupNewBadge,
  PickupStatusBadge,
} from "@/components/pickups/PickupStatusBadge";
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
  updateInternalPickupPartnerInfo,
  updateInternalPickupStatus,
  type PickupDetail,
  type PickupReceivedParcel,
  type PickupSummary,
} from "@/lib/pickups";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

const format = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }).format(new Date(value))
    : "Not set";
const formatDate = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeZone: "Asia/Kolkata",
      }).format(new Date(value))
    : "Not set";
const arrivalLabels: Record<string, string> = {
  MORNING: "Morning · 06:00–12:00",
  AFTERNOON: "Afternoon · 12:00–17:00",
  EVENING: "Evening · 17:00–22:00",
  EXACT: "Exact time",
};
const address = (value: Record<string, string>) =>
  [
    value.addressLine1,
    value.addressLine2,
    value.townOrCity,
    value.county,
    value.postcode,
    value.countryName,
  ]
    .filter(Boolean)
    .join(", ");

export default function PickupManagementPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [pickups, setPickups] = useState<PickupSummary[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selected, setSelected] = useState<PickupDetail | null>(null);
  const [mode, setMode] = useState<"review" | "quick" | "couriers">("review");
  const [partnerInfo, setPartnerInfo] = useState("");
  const [partnerSaving, setPartnerSaving] = useState(false);
  const [driverId, setDriverId] = useState("");
  const [vehicle, setVehicle] = useState({
    source: "DRIVER_OWNED",
    type: "",
    registrationNumber: "",
  });
  const [cancelReason, setCancelReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const [pickupData, driverData] = await Promise.all([
      listInternalPickups(),
      listAvailablePickupDrivers(),
    ]);
    setPickups(pickupData.pickups);
    setDrivers(driverData.drivers);
  }
  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.all([listInternalPickups(), listAvailablePickupDrivers()])
      .then(([pickupData, driverData]) => {
        if (active) {
          setPickups(pickupData.pickups);
          setDrivers(driverData.drivers);
        }
      })
      .catch((caught) => {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load pickups.",
          );
      });
    return () => {
      active = false;
    };
  }, [user]);

  async function open(pickup: PickupSummary) {
    setBusy(true);
    setShowCancel(false);
    try {
      const detail = (await getInternalPickup(pickup.id)).pickup;
      setSelected(detail);
      setPartnerInfo(detail.pickupPartnerInfo ?? "");
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Unable to open pickup.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      const result = await confirmInternalPickup(selected.id);
      setSelected(result.pickup);
      toast.success("Pickup approved. Driver assignment is optional.");
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Unable to confirm pickup.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function updateStatus(status: "IN_PROGRESS" | "RECEIVED_AT_DELHI_HUB", receivedParcels?: PickupReceivedParcel[]) {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await updateInternalPickupStatus(selected.id, status, receivedParcels);
      setSelected(result.pickup);
      toast.success(
        status === "IN_PROGRESS"
          ? "Pickup marked as started."
          : result.pickup.status === "COMPLETED_WITH_MISSING_PARCELS"
            ? "Pickup completed with parcels not received at the hub."
            : "Pickup received at Delhi hub.",
      );
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Pickup status could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function savePartnerInfo(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setPartnerSaving(true);
    try {
      const result = await updateInternalPickupPartnerInfo(
        selected.id,
        partnerInfo,
      );
      setSelected(result.pickup);
      toast.success("Pickup partner information saved.");
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Pickup partner information could not be saved.",
      );
    } finally {
      setPartnerSaving(false);
    }
  }
  async function assign(event: FormEvent) {
    event.preventDefault();
    const attempt = selected?.attempts[0];
    if (!selected || !attempt) return;
    setBusy(true);
    try {
      const result = await assignInternalPickup(selected.id, {
        attemptId: attempt._id,
        driverProfileId: driverId,
        vehicle,
      });
      setSelected(result.pickup);
      toast.success("Driver assigned.");
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Unable to assign driver.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function reviewOtpException(attemptId: string, approved: boolean) {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await reviewInternalPickupOtpException(selected.id, {
        attemptId,
        approved,
      });
      setSelected(result.pickup);
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Unable to review OTP exception.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!selected || cancelReason.trim().length < 3) return;
    setBusy(true);
    try {
      const result = await cancelInternalPickup(selected.id, cancelReason);
      setSelected(result.pickup);
      setShowCancel(false);
      setCancelReason("");
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Unable to cancel pickup.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user) return <DashboardLoading />;
  const attempt = selected?.attempts[0] ?? null;
  const pendingOtpExceptions =
    selected?.attempts.filter(
      (item) =>
        item.otpExceptionRequestedAt &&
        !item.otpExceptionApprovedAt &&
        !item.otpExceptionRejectedAt,
    ) ?? [];
  const canCancel =
    selected &&
    [
      "REQUESTED",
      "CONFIRMED",
      "DRIVER_ASSIGNED",
      "ACTION_REQUIRED",
      "MISSED",
    ].includes(selected.status) &&
    (!attempt || ["SCHEDULED", "ASSIGNED"].includes(attempt.status));
  const cancelledBy =
    selected?.cancelledBy && typeof selected.cancelledBy !== "string"
      ? selected.cancelledBy.name ||
        `${selected.cancelledBy.firstName ?? ""} ${selected.cancelledBy.lastName ?? ""}`.trim()
      : "";
  const canMarkStarted = Boolean(
    selected &&
    !selected.pickupStartedAt &&
    ["CONFIRMED", "DRIVER_ASSIGNED", "ACTION_REQUIRED"].includes(
      selected.status,
    ),
  );
  const canMarkReceived = Boolean(
    selected && ["IN_PROGRESS", "COLLECTED", "PARTIALLY_COLLECTED"].includes(selected.status),
  );
  const visiblePickups =
    mode === "quick"
      ? pickups.filter((pickup) =>
          [
            "CONFIRMED",
            "DRIVER_ASSIGNED",
            "IN_PROGRESS",
            "COLLECTED",
            "PARTIALLY_COLLECTED",
            "ACTION_REQUIRED",
          ].includes(pickup.status),
        )
      : pickups;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">
            {mode === "quick" ? "Quick Pickup Status" : mode === "couriers" ? "Courier addresses" : "Pickup Requests"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === "couriers"
              ? "Save collection locations and contacts for each courier and branch."
              : mode === "quick"
              ? "Update approved pickup progress and confirm verified receipt at the Delhi hub."
              : "Review requests, approve from the client’s dispatch time, and optionally assign a driver."}
          </p>
        </div>
        {mode !== "couriers" ? <button
          onClick={() => void load()}
          className="inline-flex h-10 items-center gap-2 rounded-full border border-slate-300 px-4 text-sm font-semibold"
        >
          <FiRefreshCw />
          Refresh
        </button> : null}
      </div>
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Pickup workspace"
      >
        <button
          type="button"
          aria-pressed={mode === "review"}
          onClick={() => {
            setMode("review");
            setSelected(null);
          }}
          className={`h-10 rounded-full px-4 text-sm font-semibold ${mode === "review" ? "bg-[#0D1282] text-white" : "border border-slate-300 bg-white text-slate-600"}`}
        >
          Review requests
        </button>
        <button
          type="button"
          aria-pressed={mode === "quick"}
          onClick={() => {
            setMode("quick");
            setSelected(null);
          }}
          className={`inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold ${mode === "quick" ? "bg-[#0D1282] text-white" : "border border-slate-300 bg-white text-slate-600"}`}
        >
          <FiClock />
          Quick status
        </button>
        <button
          type="button"
          aria-pressed={mode === "couriers"}
          onClick={() => { setMode("couriers"); setSelected(null); }}
          className={`inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold ${mode === "couriers" ? "bg-[#0D1282] text-white" : "border border-slate-300 bg-white text-slate-600"}`}
        >
          <FiMapPin /> Courier addresses
        </button>
        {mode === "quick" ? (
          <p className="text-sm text-slate-500">
            Approved pickups in progress and awaiting hub receipt.
          </p>
        ) : null}
      </div>
      {mode === "couriers" ? <PickupCourierAddressBook /> : <div className="grid gap-5 xl:grid-cols-[.75fr_1.25fr]">
        <section className="space-y-3">
          {visiblePickups.map((pickup) => (
            <button
              key={pickup.id}
              onClick={() => void open(pickup)}
              className={`w-full rounded-2xl border bg-white p-4 text-left shadow-sm ${selected?.id === pickup.id ? "border-[#0D1282] ring-2 ring-blue-100" : "border-slate-200"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{pickup.requestNumber}</strong>
                <div className="flex gap-2">
                  {pickup.status === "REQUESTED" ? <PickupNewBadge /> : null}
                  <PickupStatusBadge status={pickup.status} />
                </div>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                {pickup.businessAccountName || pickup.pickupContact.name}
              </p>
              <p className="mt-1 text-xs font-medium text-slate-600">
                Dispatch{" "}
                {format(pickup.dispatchAt || pickup.requestedWindow.startAt)} ·{" "}
                {pickup.totalBoxes ?? pickup.parcelCount} boxes ·{" "}
                {formatPickupWeightKg(pickup.totalWeightKg)}
              </p>
              <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                {address(pickup.pickupAddress)}
              </p>
              {pickup.status === "CANCELLED" ? (
                <p className="mt-2 text-xs font-semibold text-slate-600">
                  Cancelled by{" "}
                  {pickup.cancellationSource === "CLIENT" ? "Client" : "Admin"}
                </p>
              ) : null}
            </button>
          ))}
          {!visiblePickups.length ? (
            <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
              {mode === "quick"
                ? "No approved pickups are awaiting a status update."
                : "No pickup requests found."}
            </div>
          ) : null}
        </section>
        <section className="h-fit rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:sticky xl:top-4">
          {selected ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">
                    {selected.requestNumber}
                  </h2>
                  <div className="mt-2">
                    <PickupStatusBadge status={selected.status} />
                  </div>
                </div>
                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-[#0D1282]">
                  {selected.shipmentCount} shipments ·{" "}
                  {selected.totalBoxes ?? selected.parcelCount} boxes
                </span>
              </div>
              {selected.status === "CANCELLED" ? (
                <div className="rounded-xl border border-slate-300 bg-slate-100 p-4">
                  <strong>
                    Cancelled by{" "}
                    {selected.cancellationSource === "CLIENT"
                      ? "Client"
                      : "Admin"}
                  </strong>
                  {cancelledBy ? <span> ({cancelledBy})</span> : null}
                  <p className="mt-1 text-xs text-slate-500">
                    {format(selected.cancelledAt)}
                  </p>
                  <p className="mt-2 text-sm">{selected.cancellationReason}</p>
                </div>
              ) : null}
              {["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(selected.status) ? (
                <div className={`rounded-xl border p-4 ${selected.status === "COMPLETED_WITH_MISSING_PARCELS" ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
                  <strong className={selected.status === "COMPLETED_WITH_MISSING_PARCELS" ? "text-amber-950" : "text-emerald-950"}>
                    {selected.status === "COMPLETED_WITH_MISSING_PARCELS" ? "Completed with parcels not received at " : "Received at "}
                    {selected.branchId && typeof selected.branchId !== "string"
                      ? selected.branchId.name
                      : "Delhi hub"}
                  </strong>
                  <p className="mt-1 text-sm text-slate-700">
                    {format(selected.receivedAtDelhiHubAt)}
                  </p>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <p className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Client company
                  </span>
                  <strong className="mt-1 block break-words text-slate-950">
                    {selected.businessAccountName || "Business account"}
                  </strong>
                </p>
                <p className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
                  <FiUser className="mb-1 text-[#0D1282]" />
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Courier collection contact</span>
                  <strong>{selected.pickupContact.name}</strong>
                  <span className="mt-1 block text-xs text-slate-600">
                    {selected.pickupContact.phone}
                  </span>
                </p>
                <p className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Requested by</span>
                  <strong className="mt-1 block">{selected.requester?.name || "Account holder"}</strong>
                  <span className="mt-1 block break-all text-xs text-slate-600">{selected.requester?.email || selected.pickupContact.email || ""}</span>
                </p>
                <p className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
                  <FiTruck className="mb-1 text-[#0D1282]" />
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Transport / courier
                  </span>
                  <strong className="mt-1 block">
                    {selected.transportCompany || "Not provided"}
                  </strong>
                </p>
                <p className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm">
                  <FiMapPin className="mb-1 text-[#0D1282]" />
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Collection address
                  </span>
                  <span className="mt-1 block break-words">
                    {address(selected.pickupAddress)}
                  </span>
                </p>
                <p className="rounded-xl bg-slate-50 p-3 text-sm">
                  <FiCalendar className="mb-1 text-[#0D1282]" />
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Dispatch
                  </span>
                  <strong className="mt-1 block">
                    {format(
                      selected.dispatchAt || selected.requestedWindow.startAt,
                    )}
                  </strong>
                </p>
                <p className="rounded-xl bg-slate-50 p-3 text-sm">
                  <FiClock className="mb-1 text-[#0D1282]" />
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Expected Delhi arrival
                  </span>
                  <strong className="mt-1 block">
                    {selected.expectedDelhiArrival
                      ? `${formatDate(selected.expectedDelhiArrival.date)} · ${selected.expectedDelhiArrival.window === "EXACT" ? `Exact · ${format(selected.expectedDelhiArrival.exactAt)}` : arrivalLabels[selected.expectedDelhiArrival.window]}`
                      : "Not specified"}
                  </strong>
                </p>
                <p className="rounded-xl bg-blue-50 p-3 text-sm sm:col-span-2">
                  <FiPackage className="mb-1 text-[#0D1282]" />
                  <strong>
                    {selected.totalBoxes ?? selected.parcelCount} boxes
                  </strong>
                  <span className="mx-2 text-blue-300">·</span>
                  <strong>
                    {formatPickupWeightKg(selected.totalWeightKg, true)}
                  </strong>
                  <span className="ml-2 text-xs text-slate-600">
                    {selected.shipmentCount} linked shipments
                  </span>
                </p>
                {selected.handlingRemarks || selected.instructions ? (
                  <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 sm:col-span-2">
                    <strong className="block text-xs uppercase tracking-wide text-amber-800">
                      Handling remarks
                    </strong>
                    <span className="mt-1 block">
                      {selected.handlingRemarks || selected.instructions}
                    </span>
                  </p>
                ) : null}
              </div>
              {mode === "review" &&
              ["REQUESTED", "ACTION_REQUIRED", "PARTIALLY_COLLECTED"].includes(
                selected.status,
              ) ? (
                <form
                  onSubmit={confirm}
                  className="rounded-xl border border-blue-100 bg-blue-50/50 p-4"
                >
                  <h3 className="font-semibold">
                    {selected.status === "PARTIALLY_COLLECTED"
                      ? "Schedule remaining pickup"
                      : "Approve pickup request"}
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Dispatch:{" "}
                    {format(
                      selected.dispatchAt || selected.requestedWindow.startAt,
                    )}
                    . Approval uses the client’s requested time; no second
                    collection window is needed.
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Driver assignment is optional. You can also use the status
                    actions below for a pickup without a driver.
                  </p>
                  <button
                    disabled={
                      busy ||
                      (selected.status === "PARTIALLY_COLLECTED" &&
                        selected.shipments.length === 0)
                    }
                    className="mt-3 h-10 rounded-full bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:bg-slate-300"
                  >
                    {selected.status === "PARTIALLY_COLLECTED"
                      ? "Schedule retry"
                      : "Approve pickup"}
                  </button>
                </form>
              ) : null}
              <section className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
                <div className="flex items-start gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-950">
                      Quick pickup status
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">
                      Use these actions with or without a driver assignment. The
                      client receives an email when the pickup starts and when
                      the hub receipt is recorded.
                    </p>
                  </div>
                </div>
                {canMarkStarted ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void updateStatus("IN_PROGRESS")}
                    className="mt-4 h-10 w-full rounded-xl bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    Mark pickup started
                  </button>
                ) : null}
                {canMarkReceived ? (
                  <PickupHubReceiptForm key={selected.id} pickup={selected} busy={busy} onComplete={(parcels) => updateStatus("RECEIVED_AT_DELHI_HUB", parcels)} />
                ) : null}
                {!canMarkStarted &&
                !canMarkReceived &&
                !["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(selected.status) ? (
                  <p className="mt-3 rounded-lg bg-white/80 p-3 text-xs text-slate-500">
                    No quick status action is available for this request state.
                  </p>
                ) : null}
              </section>
              <form
                onSubmit={savePartnerInfo}
                className="rounded-xl border border-slate-200 p-4"
              >
                <label className="block text-sm font-semibold text-slate-900">
                  Pickup partner information{" "}
                  <span className="font-normal text-slate-400">(optional)</span>
                  <textarea
                    maxLength={500}
                    rows={3}
                    value={partnerInfo}
                    onChange={(event) => setPartnerInfo(event.target.value)}
                    placeholder="Vehicle and registration, driver name, or other pickup details"
                    className="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm font-normal outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-xs text-slate-500">
                    Visible to the client when saved.
                  </p>
                  <button
                    type="submit"
                    disabled={partnerSaving || partnerInfo.length > 500}
                    className="h-9 shrink-0 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:border-blue-300 disabled:opacity-50"
                  >
                    {partnerSaving ? "Saving…" : "Save information"}
                  </button>
                </div>
              </form>
              <PickupDocumentsList
                pickupId={selected.id}
                documents={selected.documents}
                audience="internal"
              />
              <section className="rounded-xl border border-slate-200 p-4">
                <h3 className="font-semibold">Linked shipments</h3>
                {selected.shipments.length ? (
                  <div className="mt-3 space-y-2">
                    {selected.shipments.map((shipment) => (
                      <div
                        key={shipment._id}
                        className="rounded-xl bg-slate-50 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="text-sm">
                            {shipment.trackingNumber}
                          </strong>
                          <PickupStatusBadge status={shipment.status} />
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {shipment.parcels.length} boxes ·{" "}
                          {shipment.parcels
                            .map((parcel) => parcel.parcelNumber)
                            .join(", ")}
                        </p>
                        <PickupHubReceiptSummary shipment={shipment} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
                    No booked shipment was linked. Use the request’s manual
                    volume and status actions.
                  </p>
                )}
              </section>
              {mode === "review" &&
              attempt &&
              ["SCHEDULED", "ASSIGNED"].includes(attempt.status) ? (
                <form
                  onSubmit={assign}
                  className="rounded-xl border border-amber-100 bg-amber-50/50 p-4"
                >
                  <h3 className="font-semibold">Optional driver assignment</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <select
                      required
                      value={driverId}
                      onChange={(event) => setDriverId(event.target.value)}
                      className="h-11 rounded-xl border border-slate-300 px-3 text-sm"
                    >
                      <option value="">Select approved driver</option>
                      {drivers.map((driver) => (
                        <option key={driver.id} value={driver.id}>
                          {driver.firstName} {driver.lastName} ·{" "}
                          {driver.engagementType.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                    <select
                      value={vehicle.source}
                      onChange={(event) =>
                        setVehicle((current) => ({
                          ...current,
                          source: event.target.value,
                        }))
                      }
                      className="h-11 rounded-xl border border-slate-300 px-3 text-sm"
                    >
                      <option value="COMPANY_OWNED">Company owned</option>
                      <option value="DRIVER_OWNED">Driver owned</option>
                      <option value="HIRED">Hired</option>
                    </select>
                    <select
                      required
                      value={vehicle.type}
                      onChange={(event) =>
                        setVehicle((current) => ({
                          ...current,
                          type: event.target.value,
                        }))
                      }
                      className="h-11 rounded-xl border border-slate-300 px-3 text-sm"
                    >
                      <option value="">Select vehicle type</option>
                      {pickupVehicleTypes.map((type) => (
                        <option key={type}>{type}</option>
                      ))}
                    </select>
                    <input
                      required
                      placeholder="Registration number"
                      value={vehicle.registrationNumber}
                      onChange={(event) =>
                        setVehicle((current) => ({
                          ...current,
                          registrationNumber: event.target.value,
                        }))
                      }
                      className="h-11 rounded-xl border border-slate-300 px-3 text-sm uppercase"
                    />
                  </div>
                  <button
                    disabled={busy || !driverId}
                    className="mt-3 inline-flex h-10 items-center gap-2 rounded-full bg-amber-500 px-4 text-sm font-semibold text-amber-950"
                  >
                    <FiTruck />
                    Assign driver
                  </button>
                </form>
              ) : null}
              {mode === "review" &&
                pendingOtpExceptions.map((item) => (
                  <div
                    key={item._id}
                    className="rounded-xl border border-amber-200 bg-amber-50 p-4"
                  >
                    <h3 className="font-semibold text-amber-950">
                      OTP exception review
                    </h3>
                    <p className="mt-1 text-sm text-amber-900">
                      {item.otpExceptionReason}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        disabled={busy}
                        onClick={() => void reviewOtpException(item._id, true)}
                        className="h-9 rounded-full bg-emerald-600 px-3 text-xs font-semibold text-white"
                      >
                        Approve exception
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void reviewOtpException(item._id, false)}
                        className="h-9 rounded-full border border-red-300 bg-white px-3 text-xs font-semibold text-red-700"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              <div className="space-y-2">
                {selected.attempts.map((item) => (
                  <div
                    key={item._id}
                    className="rounded-xl border border-slate-200 p-4 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong>Attempt {item.sequence}</strong>
                      <PickupStatusBadge status={item.status} />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {format(item.scheduledWindow.startAt)} -{" "}
                      {format(item.scheduledWindow.endAt)}
                    </p>
                    {item.assignedDriverUserId ? (
                      <p className="mt-2">
                        Driver:{" "}
                        {item.assignedDriverUserId.name ||
                          `${item.assignedDriverUserId.firstName ?? ""} ${item.assignedDriverUserId.lastName ?? ""}`}
                      </p>
                    ) : (
                      <p className="mt-2 text-slate-500">No driver assigned.</p>
                    )}
                  </div>
                ))}
              </div>
              <PickupProofGallery
                pickupId={selected.id}
                attempts={selected.attempts}
                audience="internal"
                canUpload={Boolean(selected.pickupStartedAt || ["COLLECTED", "PARTIALLY_COLLECTED", "RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(selected.status))}
                onUploaded={setSelected}
              />
              {canCancel ? (
                <div className="rounded-xl border border-red-200 p-4">
                  {showCancel ? (
                    <div>
                      <textarea
                        value={cancelReason}
                        onChange={(event) =>
                          setCancelReason(event.target.value)
                        }
                        placeholder="Cancellation reason"
                        className="min-h-20 w-full rounded-xl border border-red-300 p-3 text-sm"
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => setShowCancel(false)}
                          className="h-10 rounded-full border border-slate-300 px-4 text-sm font-semibold"
                        >
                          Keep pickup
                        </button>
                        <button
                          type="button"
                          disabled={busy || cancelReason.trim().length < 3}
                          onClick={() => void cancel()}
                          className="h-10 rounded-full bg-red-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
                        >
                          Cancel pickup
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCancel(true)}
                      className="h-10 rounded-full border border-red-300 px-4 text-sm font-semibold text-red-700"
                    >
                      Cancel pickup request
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="py-20 text-center text-sm text-slate-500">
              <FiTruck className="mx-auto mb-3 h-8 w-8" />
              Select a pickup request.
            </div>
          )}
        </section>
      </div>}
    </div>
  );
}
