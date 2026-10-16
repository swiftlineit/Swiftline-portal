"use client";

import { useEffect, useMemo, useState } from "react";
import {
  FiBriefcase,
  FiCalendar,
  FiClock,
  FiMapPin,
  FiPackage,
  FiPhone,
  FiTruck,
  FiUser,
  FiX,
} from "react-icons/fi";
import { toast } from "react-toastify";
import PickupDocumentsList from "@/components/pickups/PickupDocumentsList";
import PickupHubReceiptSummary from "@/components/pickups/PickupHubReceiptSummary";
import PickupProofGallery from "@/components/pickups/PickupProofGallery";
import { PickupStatusBadge } from "@/components/pickups/PickupStatusBadge";
import {
  cancelClientPickup,
  formatPickupWeightKg,
  getClientPickup,
  rescheduleClientPickup,
  reschedulableClientPickupStatuses,
  type PickupDetail,
} from "@/lib/pickups";

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
const formatTime = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-IN", {
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }).format(new Date(value))
    : "Not set";
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
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
const arrivalLabel: Record<string, string> = {
  MORNING: "Morning · 06:00–12:00",
  AFTERNOON: "Afternoon · 12:00–17:00",
  EVENING: "Evening · 17:00–22:00",
  EXACT: "Exact time",
};

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof FiMapPin;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 gap-3">
      <span className="mt-3 shrink-0 text-[#0D1282]">
        <Icon aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <div className="mt-1 break-words text-sm font-medium text-slate-900">
          {children}
        </div>
      </div>
    </div>
  );
}

export default function ClientPickupDetail({
  pickupId,
  onClose,
  onUpdated,
}: {
  pickupId: string;
  onClose: () => void;
  onUpdated: (pickup: PickupDetail) => void;
}) {
  const [pickup, setPickup] = useState<PickupDetail | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const [newDispatchDate, setNewDispatchDate] = useState("");
  const [newDispatchTime, setNewDispatchTime] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void getClientPickup(pickupId)
      .then((result) => {
        if (active) setPickup(result.pickup);
      })
      .catch((caught) => {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Pickup details could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [pickupId]);

  const latestAttempt = pickup?.attempts[0] ?? null;
  const driver = latestAttempt?.assignedDriverUserId;
  const canCancel = Boolean(
    pickup &&
    [
      "REQUESTED",
      "CONFIRMED",
      "DRIVER_ASSIGNED",
      "ACTION_REQUIRED",
      "MISSED",
    ].includes(pickup.status) &&
    (!latestAttempt ||
      ["SCHEDULED", "ASSIGNED"].includes(latestAttempt.status)),
  );
  const canReschedule = Boolean(
    pickup && reschedulableClientPickupStatuses.includes(pickup.status),
  );
  const cancelledByName = useMemo(() => {
    if (!pickup?.cancelledBy || typeof pickup.cancelledBy === "string")
      return "";
    return (
      pickup.cancelledBy.name ||
      `${pickup.cancelledBy.firstName ?? ""} ${pickup.cancelledBy.lastName ?? ""}`.trim()
    );
  }, [pickup]);
  const branchName =
    pickup?.branchId && typeof pickup.branchId !== "string"
      ? pickup.branchId.name
      : "Delhi hub";

  async function reschedule() {
    if (!pickup || !newDispatchDate || !newDispatchTime) return;
    setBusy(true);
    try {
      const result = await rescheduleClientPickup(pickup.id, {
        dispatchDate: newDispatchDate,
        dispatchTime: newDispatchTime,
      });
      setPickup(result.pickup);
      onUpdated(result.pickup);
      setShowReschedule(false);
      setNewDispatchDate("");
      setNewDispatchTime("");
      toast.success(result.message);
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Pickup could not be rescheduled.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!pickup || reason.trim().length < 3) return;
    setBusy(true);
    try {
      const result = await cancelClientPickup(pickup.id, reason);
      setPickup(result.pickup);
      onUpdated(result.pickup);
      setShowCancel(false);
      toast.success(result.message);
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Pickup could not be cancelled.",
      );
    } finally {
      setBusy(false);
    }
  }

  const showDriverProofs = Boolean(pickup && [
    "COLLECTED", "PARTIALLY_COLLECTED", "RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS",
  ].includes(pickup.status));
  const visibleProofAttempts = pickup?.attempts.map((attempt) => ({
    ...attempt,
    proofs: showDriverProofs ? attempt.proofs : attempt.proofs?.filter((proof) => proof.source === "STAFF"),
  })) ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/55"
      role="dialog"
      aria-modal="true"
      aria-label="Pickup request details"
    >
      <div className="flex h-full w-full flex-col bg-slate-50 shadow-2xl sm:max-w-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Pickup details
            </p>
            <h2 className="mt-0.5 text-lg font-bold text-slate-950">
              {pickup?.requestNumber ?? "Loading…"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pickup details"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            <FiX />
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700"
            >
              {error}
            </p>
          ) : null}
          {!pickup && !error ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((item) => (
                <div
                  key={item}
                  className="h-24 animate-pulse rounded-2xl bg-white"
                />
              ))}
            </div>
          ) : null}
          {pickup ? (
            <>
              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Current status
                    </p>
                    <div className="mt-2">
                      <PickupStatusBadge status={pickup.status} />
                    </div>
                  </div>
                  <span className="text-xs text-slate-500">
                    Requested {format(pickup.createdAt)}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-xl bg-slate-50 p-3 text-center">
                    <strong className="text-lg text-slate-950">
                      {pickup.shipmentCount}
                    </strong>
                    <p className="text-[11px] text-slate-500">Shipments</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3 text-center">
                    <strong className="text-lg text-slate-950">
                      {pickup.totalBoxes ?? pickup.parcelCount}
                    </strong>
                    <p className="text-[11px] text-slate-500">Boxes</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3 text-center">
                    <strong className="text-lg text-slate-950">
                      {formatPickupWeightKg(pickup.totalWeightKg)}
                    </strong>
                    <p className="text-[11px] text-slate-500">Gross weight</p>
                  </div>
                </div>
              </section>

              {["RECEIVED_AT_DELHI_HUB", "COMPLETED_WITH_MISSING_PARCELS"].includes(pickup.status) ? (
                <section className={`rounded-2xl border p-4 ${pickup.status === "COMPLETED_WITH_MISSING_PARCELS" ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
                  <p className="font-semibold text-slate-950">
                    {pickup.status === "COMPLETED_WITH_MISSING_PARCELS" ? "Completed with parcels not received at " : "Received at "}{branchName}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    {format(pickup.receivedAtDelhiHubAt)}
                  </p>
                </section>
              ) : null}
              {pickup.status === "CANCELLED" ? (
                <section className="rounded-2xl border border-slate-300 bg-slate-100 p-4">
                  <h3 className="font-semibold">Cancellation</h3>
                  <p className="mt-2 text-sm">
                    Cancelled by{" "}
                    <strong>
                      {pickup.cancellationSource === "CLIENT"
                        ? "you"
                        : "Swiftline"}
                    </strong>
                    {cancelledByName ? ` (${cancelledByName})` : ""} on{" "}
                    {format(pickup.cancelledAt)}.
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    {pickup.cancellationReason}
                  </p>
                </section>
              ) : null}

              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <h3 className="text-base font-semibold text-slate-950">
                  Pickup plan
                </h3>
                <div className="mt-4 divide-y divide-slate-100">
                  <div className="grid gap-5 pb-4 sm:grid-cols-2">
                    <DetailRow icon={FiCalendar} label="Dispatch date and time">
                      {format(
                        pickup.dispatchAt || pickup.requestedWindow.startAt,
                      )}
                    </DetailRow>
                    <DetailRow icon={FiClock} label="Expected Delhi arrival">
                      {pickup.expectedDelhiArrival ? (
                        <>
                          {formatDate(pickup.expectedDelhiArrival.date)} ·{" "}
                          {pickup.expectedDelhiArrival.window === "EXACT"
                            ? formatTime(pickup.expectedDelhiArrival.exactAt)
                            : arrivalLabel[pickup.expectedDelhiArrival.window]}
                        </>
                      ) : (
                        format(pickup.requestedWindow.startAt)
                      )}
                    </DetailRow>
                  </div>
                  <div className="grid gap-5 py-4 sm:grid-cols-2">
                    <DetailRow icon={FiTruck} label="Transport / courier">
                      {pickup.transportCompany || "Not specified"}
                    </DetailRow>
                    <DetailRow icon={FiBriefcase} label="Business account">
                      {pickup.businessAccountName || "Business account"}
                    </DetailRow>
                  </div>
                  <div className="grid gap-5 py-4 sm:grid-cols-2">
                    <DetailRow icon={FiMapPin} label="Collection address">
                      {address(pickup.pickupAddress)}
                    </DetailRow>
                    <DetailRow icon={FiUser} label="Pickup contact">
                      {pickup.pickupContact.name}
                      <span className="mt-1 flex items-center gap-1 text-xs font-normal text-slate-500">
                        <FiPhone aria-hidden="true" />
                        {pickup.pickupContact.phone}
                      </span>
                    </DetailRow>
                  </div>
                  {pickup.pickupPartnerInfo ||
                  pickup.handlingRemarks ||
                  pickup.instructions ? (
                    <div className="space-y-4 pt-4">
                      {pickup.pickupPartnerInfo ? (
                        <DetailRow icon={FiTruck} label="Pickup partner">
                          {pickup.pickupPartnerInfo}
                        </DetailRow>
                      ) : null}
                      {pickup.handlingRemarks || pickup.instructions ? (
                        <div className=" bg-gray-200 rounded py-3 px-7">
                          <p className="text-xs font-medium text-slate-500">
                            Handling instructions
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-900">
                            {pickup.handlingRemarks || pickup.instructions}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </section>

              {driver ? (
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <h3 className="font-semibold">Assigned driver</h3>
                  <div className="mt-3 rounded-xl bg-slate-50 p-3">
                    <p className="font-semibold">
                      {driver.name ||
                        `${driver.firstName ?? ""} ${driver.lastName ?? ""}`}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {driver.phone || "Phone not provided"}
                    </p>
                    <p className="mt-2 text-xs font-semibold uppercase text-slate-500">
                      {latestAttempt?.assignedDriverProfileId?.engagementType?.replace(
                        /_/g,
                        " ",
                      )}{" "}
                      · {latestAttempt?.status.replace(/_/g, " ")}
                    </p>
                    {latestAttempt?.vehicle?.type ? (
                      <p className="mt-2 flex items-center gap-2 text-sm">
                        <FiTruck className="text-[#0D1282]" />
                        {latestAttempt.vehicle.type} ·{" "}
                        {latestAttempt.vehicle.registrationNumber}
                      </p>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <h3 className="font-semibold text-slate-950">
                  Linked shipments
                </h3>
                {pickup.shipments.length ? (
                  <div className="mt-3 space-y-3">
                    {pickup.shipments.map((shipment) => (
                      <div
                        key={shipment._id}
                        className="rounded-xl border border-slate-200 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong className="text-sm">
                            {shipment.trackingNumber}
                          </strong>
                          <PickupStatusBadge status={shipment.status} />
                        </div>
                        <div className="mt-2 space-y-1">
                          {shipment.parcels.map((parcel) => (
                            <p
                              key={parcel.parcelNumber}
                              className="flex items-center justify-between gap-3 text-xs text-slate-600"
                            >
                              <span className="flex items-center gap-1">
                                <FiPackage />
                                {parcel.parcelNumber}
                              </span>
                              <span>{parcel.status.replace(/_/g, " ")}</span>
                            </p>
                          ))}
                        </div>
                        <PickupHubReceiptSummary shipment={shipment} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-500">
                    No booked shipments were linked. This pickup was submitted
                    with the entered box and weight totals.
                  </p>
                )}
              </section>

              <PickupDocumentsList
                pickupId={pickup.id}
                documents={pickup.documents}
                audience="client"
              />
              {(visibleProofAttempts.some((attempt) => (attempt.proofs?.length ?? 0) > 0) || showDriverProofs) ? (
                <PickupProofGallery
                  pickupId={pickup.id}
                  attempts={visibleProofAttempts}
                  audience="client"
                />
              ) : null}

              {canReschedule ? (
                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  {showReschedule ? (
                    <div>
                      <h3 className="font-semibold text-slate-900">
                        Change dispatch time
                      </h3>
                      <p className="mt-1 text-sm text-slate-500">
                        The request returns to review so the new time can be
                        confirmed.
                      </p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Dispatch date
                          <input
                            type="date"
                            min={today()}
                            value={newDispatchDate}
                            onChange={(event) =>
                              setNewDispatchDate(event.target.value)
                            }
                            className="mt-1 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm normal-case"
                          />
                        </label>
                        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Dispatch time
                          <input
                            type="time"
                            value={newDispatchTime}
                            onChange={(event) =>
                              setNewDispatchTime(event.target.value)
                            }
                            className="mt-1 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm normal-case"
                          />
                        </label>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setShowReschedule(false)}
                          className="h-11 rounded-xl border border-slate-300 text-sm font-semibold"
                        >
                          Keep time
                        </button>
                        <button
                          type="button"
                          disabled={
                            busy || !newDispatchDate || !newDispatchTime
                          }
                          onClick={() => void reschedule()}
                          className="h-11 rounded-xl bg-[#0D1282] text-sm font-semibold text-white disabled:bg-slate-300"
                        >
                          Submit new time
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowReschedule(true)}
                      className="h-11 w-full rounded-xl border border-slate-300 text-sm font-semibold text-slate-700"
                    >
                      Reschedule pickup
                    </button>
                  )}
                </section>
              ) : null}
              {canCancel ? (
                <section className="rounded-2xl border border-red-200 bg-white p-4">
                  {showCancel ? (
                    <div>
                      <h3 className="font-semibold text-red-800">
                        Cancel pickup request
                      </h3>
                      <textarea
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="Reason for cancellation"
                        maxLength={500}
                        className="mt-3 min-h-24 w-full rounded-xl border border-red-300 p-3 text-sm"
                      />
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setShowCancel(false)}
                          className="h-11 rounded-xl border border-slate-300 text-sm font-semibold"
                        >
                          Keep pickup
                        </button>
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 3}
                          onClick={() => void cancel()}
                          className="h-11 rounded-xl bg-red-600 text-sm font-semibold text-white disabled:bg-slate-300"
                        >
                          Confirm cancellation
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCancel(true)}
                      className="h-11 w-full rounded-xl border border-red-300 text-sm font-semibold text-red-700"
                    >
                      Cancel pickup request
                    </button>
                  )}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
