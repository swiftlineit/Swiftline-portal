"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  FiArrowLeft,
  FiCamera,
  FiCheckCircle,
  FiClock,
  FiMapPin,
  FiNavigation,
  FiPackage,
  FiPhone,
  FiRefreshCw,
  FiShield,
  FiTruck,
} from "react-icons/fi";
import { toast } from "react-toastify";
import ParcelScanner from "@/components/driver/ParcelScanner";
import SignaturePad from "@/components/driver/SignaturePad";
import PickupProofGallery from "@/components/pickups/PickupProofGallery";
import { PickupStatusBadge } from "@/components/pickups/PickupStatusBadge";
import {
  addMyPickupException,
  completeMyPickup,
  getMyPickupAttempt,
  listMyPickupAttempts,
  requestMyPickupOtp,
  requestMyPickupOtpException,
  scanMyPickupParcel,
  updateMyPickupStatus,
  uploadMyPickupProof,
  verifyMyPickupOtp,
  type PickupAttempt,
  type PickupDetail,
  type PickupLocation,
} from "@/lib/pickups";

const format = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
const address = (value: Record<string, string>) =>
  [
    value.addressLine1,
    value.addressLine2,
    value.townOrCity,
    value.county,
    value.postcode,
  ]
    .filter(Boolean)
    .join(", ");
const nextStatus: Record<
  string,
  { status: string; label: string; icon: typeof FiTruck }
> = {
  ASSIGNED: { status: "ACCEPTED", label: "Accept pickup", icon: FiCheckCircle },
  ACCEPTED: { status: "EN_ROUTE", label: "Start journey", icon: FiNavigation },
  EN_ROUTE: { status: "ARRIVED", label: "I have arrived", icon: FiMapPin },
  ARRIVED: { status: "COLLECTING", label: "Start collection", icon: FiPackage },
};

function captureLocation() {
  return new Promise<PickupLocation | undefined>((resolve) => {
    if (!navigator.geolocation) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}

function attemptId(value: PickupAttempt) {
  return value.id || value._id;
}

export default function DriverPickupApp() {
  const [attempts, setAttempts] = useState<PickupAttempt[]>([]);
  const [selectedAttemptId, setSelectedAttemptId] = useState("");
  const [detail, setDetail] = useState<PickupDetail | null>(null);
  const [otp, setOtp] = useState("");
  const [otpException, setOtpException] = useState("");
  const [exception, setException] = useState({
    parcelNumber: "",
    status: "NOT_READY",
    reason: "",
  });
  const [busy, setBusy] = useState(false);

  async function load() {
    setAttempts((await listMyPickupAttempts()).attempts);
  }
  useEffect(() => {
    let active = true;
    void listMyPickupAttempts()
      .then((result) => {
        if (active) setAttempts(result.attempts);
      })
      .catch((caught) =>
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Unable to load pickup work.",
        ),
      );
    return () => {
      active = false;
    };
  }, []);

  async function open(id: string) {
    setBusy(true);
    try {
      setSelectedAttemptId(id);
      setDetail((await getMyPickupAttempt(id)).pickup);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Unable to open pickup.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshDetail() {
    if (selectedAttemptId)
      setDetail((await getMyPickupAttempt(selectedAttemptId)).pickup);
    await load();
  }

  const selectedAttempt = useMemo(
    () =>
      detail?.attempts.find((item) => item._id === selectedAttemptId) ?? null,
    [detail, selectedAttemptId],
  );
  const parcels = useMemo(
    () =>
      detail?.shipments.flatMap((shipment) =>
        shipment.parcels.map((parcel) => ({
          ...parcel,
          trackingNumber: shipment.trackingNumber,
        })),
      ) ?? [],
    [detail],
  );
  const collected = parcels.filter(
    (parcel) => parcel.status === "COLLECTED",
  ).length;
  const hasPhoto =
    selectedAttempt?.proofs?.some((proof) => proof.type === "PHOTO") ?? false;
  const hasSignature =
    selectedAttempt?.proofs?.some((proof) => proof.type === "SIGNATURE") ??
    false;
  const otpComplete = Boolean(
    selectedAttempt?.otpVerifiedAt || selectedAttempt?.otpExceptionApprovedAt,
  );

  async function advance(status: string) {
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      const location =
        status === "ARRIVED" ? await captureLocation() : undefined;
      setDetail(
        (await updateMyPickupStatus(selectedAttempt._id, status, location))
          .pickup,
      );
      toast.success(
        status === "ARRIVED" && !location
          ? "Arrival saved. GPS permission was unavailable."
          : "Pickup status updated.",
      );
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Unable to update pickup.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function scan(value: string) {
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      setDetail(
        (
          await scanMyPickupParcel(
            selectedAttempt._id,
            value,
            crypto.randomUUID(),
          )
        ).pickup,
      );
      toast.success(`${value} collected.`);
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Parcel could not be scanned.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function requestOtp() {
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      const result = await requestMyPickupOtp(selectedAttempt._id);
      toast.success(
        result.sent
          ? "OTP sent to the pickup requester’s account email."
          : "OTP queued for delivery.",
      );
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "OTP could not be sent.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(event: FormEvent) {
    event.preventDefault();
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      await verifyMyPickupOtp(selectedAttempt._id, otp);
      setOtp("");
      await refreshDetail();
      toast.success("Pickup requester verified.");
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "OTP could not be verified.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitOtpException(event: FormEvent) {
    event.preventDefault();
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      const result = await requestMyPickupOtpException(
        selectedAttempt._id,
        otpException,
      );
      setDetail(result.pickup);
      setOtpException("");
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Exception could not be requested.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !selectedAttempt) return;
    setBusy(true);
    try {
      const result = await uploadMyPickupProof(
        selectedAttempt._id,
        "PHOTO",
        file,
        file.name,
      );
      toast.success(result.message);
      await refreshDetail();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Photo could not be uploaded.",
      );
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  }

  async function uploadSignature(blob: Blob) {
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      const result = await uploadMyPickupProof(
        selectedAttempt._id,
        "SIGNATURE",
        blob,
        `pickup-signature-${Date.now()}.png`,
      );
      toast.success(result.message);
      await refreshDetail();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Signature could not be uploaded.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitException(event: FormEvent) {
    event.preventDefault();
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      setDetail(
        (await addMyPickupException(selectedAttempt._id, exception)).pickup,
      );
      setException({ parcelNumber: "", status: "NOT_READY", reason: "" });
      toast.success("Parcel exception recorded.");
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Exception could not be recorded.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!selectedAttempt) return;
    setBusy(true);
    try {
      const location = await captureLocation();
      setDetail((await completeMyPickup(selectedAttempt._id, location)).pickup);
      toast.success("Pickup completed and POP saved.");
      await load();
    } catch (caught) {
      toast.error(
        caught instanceof Error
          ? caught.message
          : "Pickup could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!detail || !selectedAttempt)
    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">My pickups</h1>
            <p className="mt-1 text-sm text-slate-500">
              Today and upcoming assignments.
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => void load()}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-sm"
          >
            <FiRefreshCw />
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {attempts.map((attempt) => (
            <button
              key={attemptId(attempt)}
              onClick={() => void open(attemptId(attempt))}
              className="rounded-3xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-200"
            >
              <div className="flex items-start justify-between gap-3">
                <strong>{attempt.pickup?.requestNumber ?? "Pickup"}</strong>
                <PickupStatusBadge status={attempt.status} />
              </div>
              <p className="mt-3 flex items-start gap-2 text-sm text-slate-600">
                <FiClock className="mt-0.5 shrink-0" />
                {format(attempt.scheduledWindow.startAt)}
              </p>
              {attempt.pickup ? (
                <>
                  <p className="mt-2 flex items-start gap-2 text-sm text-slate-600">
                    <FiMapPin className="mt-0.5 shrink-0" />
                    {address(attempt.pickup.pickupAddress)}
                  </p>
                  <div className="mt-3 flex gap-2 text-xs font-semibold text-slate-500">
                    <span>{attempt.pickup.shipmentCount} shipments</span>
                    <span>·</span>
                    <span>{attempt.pickup.parcelCount} parcels</span>
                  </div>
                </>
              ) : null}
            </button>
          ))}
        </div>
        {!attempts.length ? (
          <div className="rounded-3xl bg-white p-10 text-center shadow-sm">
            <FiTruck className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 font-semibold">No assigned pickups</p>
            <p className="mt-1 text-sm text-slate-500">
              New work will appear here after a supervisor assigns it.
            </p>
          </div>
        ) : null}
      </div>
    );

  const action = nextStatus[selectedAttempt.status];
  const ActionIcon = action?.icon;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address(detail.pickupAddress))}`;

  return (
    <div className="space-y-4">
      <button
        onClick={() => {
          setDetail(null);
          setSelectedAttemptId("");
        }}
        className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold shadow-sm"
      >
        <FiArrowLeft />
        My pickups
      </button>
      <section className="overflow-hidden rounded-3xl bg-white shadow-sm">
        <div className="bg-[#0D1282] p-5 text-white">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-100">
                Pickup
              </p>
              <h1 className="mt-1 text-xl font-bold">{detail.requestNumber}</h1>
            </div>
            <PickupStatusBadge status={selectedAttempt.status} />
          </div>
          <p className="mt-3 text-sm text-blue-100">
            {format(selectedAttempt.scheduledWindow.startAt)} -{" "}
            {format(selectedAttempt.scheduledWindow.endAt)}
          </p>
        </div>
        <div className="space-y-3 p-4">
          <p className="font-semibold">{detail.pickupContact.name}</p>
          <a
            href={`tel:${detail.pickupContact.phone}`}
            className="flex min-h-11 items-center gap-3 rounded-xl bg-slate-50 px-3 text-sm font-semibold text-[#0D1282]"
          >
            <FiPhone />
            {detail.pickupContact.phone}
          </a>
          <a
            href={mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-11 items-start gap-3 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-700"
          >
            <FiMapPin className="mt-0.5 shrink-0 text-[#0D1282]" />
            {address(detail.pickupAddress)}
          </a>
          {detail.instructions ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <strong>Instructions:</strong> {detail.instructions}
            </p>
          ) : null}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-slate-50 p-2">
              <strong>{detail.shipmentCount}</strong>
              <p className="text-[11px] text-slate-500">Shipments</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-2">
              <strong>{detail.parcelCount}</strong>
              <p className="text-[11px] text-slate-500">Parcels</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-2">
              <strong>
                {typeof detail.totalWeightKg === "number" &&
                Number.isFinite(detail.totalWeightKg)
                  ? detail.totalWeightKg.toFixed(1)
                  : "-"}
              </strong>
              <p className="text-[11px] text-slate-500">kg</p>
            </div>
          </div>
        </div>
      </section>
      {action && ActionIcon ? (
        <button
          disabled={busy}
          onClick={() => void advance(action.status)}
          className="inline-flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#F0DE36] text-base font-bold text-[#0D1282] shadow-sm disabled:bg-slate-300"
        >
          <ActionIcon />
          {action.label}
        </button>
      ) : null}
      {selectedAttempt.status === "COLLECTING" ? (
        <>
          <section className="rounded-3xl bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="font-bold">Parcel collection</h2>
                <p className="text-xs text-slate-500">
                  {collected} of {parcels.length} collected
                </p>
              </div>
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-[#0D1282]">
                {parcels.length
                  ? Math.round((collected / parcels.length) * 100)
                  : 0}
                %
              </span>
            </div>
            <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full bg-emerald-500"
                style={{
                  width: `${parcels.length ? (collected / parcels.length) * 100 : 0}%`,
                }}
              />
            </div>
            <ParcelScanner disabled={busy} onScan={scan} />
            <div className="mt-4 max-h-56 space-y-2 overflow-y-auto">
              {parcels.map((parcel) => (
                <div
                  key={parcel.parcelNumber}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {parcel.parcelNumber}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {parcel.trackingNumber}
                    </p>
                  </div>
                  <span
                    className={`text-[11px] font-bold ${parcel.status === "COLLECTED" ? "text-emerald-600" : parcel.status === "PENDING" ? "text-slate-500" : "text-amber-700"}`}
                  >
                    {parcel.status.replace(/_/g, " ")}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-3xl bg-white p-4 shadow-sm">
            <h2 className="font-bold">Parcel exception</h2>
            <p className="mt-1 text-xs text-slate-500">
              Use only when an expected parcel cannot be collected.
            </p>
            <form onSubmit={submitException} className="mt-3 space-y-3">
              <select
                required
                value={exception.parcelNumber}
                onChange={(event) =>
                  setException((current) => ({
                    ...current,
                    parcelNumber: event.target.value,
                  }))
                }
                className="h-12 w-full rounded-xl border border-slate-300 px-3"
              >
                <option value="">Select pending parcel</option>
                {parcels
                  .filter((parcel) => parcel.status === "PENDING")
                  .map((parcel) => (
                    <option key={parcel.parcelNumber}>
                      {parcel.parcelNumber}
                    </option>
                  ))}
              </select>
              <select
                value={exception.status}
                onChange={(event) =>
                  setException((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
                className="h-12 w-full rounded-xl border border-slate-300 px-3"
              >
                <option value="NOT_READY">Not ready</option>
                <option value="NOT_FOUND">Not found</option>
                <option value="DAMAGED_AT_HANDOVER">Damaged at handover</option>
                <option value="LABEL_INVALID">Label invalid</option>
                <option value="CUSTOMER_REFUSED">Customer refused</option>
              </select>
              <textarea
                required
                minLength={3}
                value={exception.reason}
                onChange={(event) =>
                  setException((current) => ({
                    ...current,
                    reason: event.target.value,
                  }))
                }
                placeholder="Reason"
                className="min-h-20 w-full rounded-xl border border-slate-300 p-3"
              />
              <button
                disabled={busy}
                className="h-11 w-full rounded-xl border border-amber-400 text-sm font-semibold text-amber-800"
              >
                Save exception
              </button>
            </form>
          </section>
          <section className="rounded-3xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold">Client email verification</h2>
                <p className="text-xs text-slate-500">
                  OTP is sent to the pickup requester’s account email.
                </p>
              </div>
              {otpComplete ? (
                <FiCheckCircle className="h-6 w-6 text-emerald-600" />
              ) : (
                <FiShield className="h-6 w-6 text-[#0D1282]" />
              )}
            </div>
            {!otpComplete ? (
              <>
                <button
                  disabled={busy}
                  onClick={() => void requestOtp()}
                  className="mt-3 h-11 w-full rounded-xl border border-[#0D1282] text-sm font-semibold text-[#0D1282]"
                >
                  Send OTP
                </button>
                <form onSubmit={verifyOtp} className="mt-3 flex gap-2">
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={otp}
                    onChange={(event) =>
                      setOtp(event.target.value.replace(/\D/g, ""))
                    }
                    placeholder="6-digit OTP"
                    className="h-12 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-center text-lg tracking-[0.25em]"
                  />
                  <button
                    disabled={busy || otp.length !== 6}
                    className="h-12 rounded-xl bg-[#0D1282] px-4 text-sm font-semibold text-white"
                  >
                    Verify
                  </button>
                </form>
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-semibold text-amber-800">
                    OTP is not possible
                  </summary>
                  <form onSubmit={submitOtpException} className="mt-3">
                    <textarea
                      required
                      minLength={5}
                      value={otpException}
                      onChange={(event) => setOtpException(event.target.value)}
                      placeholder="Explain why the client account cannot receive or provide the OTP"
                      className="min-h-24 w-full rounded-xl border border-amber-300 p-3 text-sm"
                    />
                    <button
                      disabled={busy}
                      className="mt-2 h-11 w-full rounded-xl bg-amber-400 text-sm font-bold text-slate-950"
                    >
                      Request supervisor exception
                    </button>
                  </form>
                </details>
                {selectedAttempt.otpExceptionRequestedAt &&
                !selectedAttempt.otpExceptionApprovedAt ? (
                  <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">
                    Exception awaiting supervisor review.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">
                {selectedAttempt.otpVerifiedAt
                  ? "Client email verified"
                  : "Supervisor exception approved"}
              </p>
            )}
          </section>
          <section className="rounded-3xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold">Pickup photo</h2>
                <p className="text-xs text-slate-500">
                  At least one parcel handover photo is required.
                </p>
              </div>
              {hasPhoto ? (
                <FiCheckCircle className="h-6 w-6 text-emerald-600" />
              ) : (
                <FiCamera className="h-6 w-6 text-[#0D1282]" />
              )}
            </div>
            <label className="mt-3 inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#0D1282] text-sm font-semibold text-[#0D1282]">
              <FiCamera />
              {hasPhoto ? "Add another photo" : "Take required photo"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                onChange={(event) => void uploadPhoto(event)}
                className="sr-only"
              />
            </label>
          </section>
          <section className="rounded-3xl bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="font-bold">Customer signature</h2>
                <p className="text-xs text-slate-500">
                  Required proof of handover.
                </p>
              </div>
              {hasSignature ? (
                <FiCheckCircle className="h-6 w-6 text-emerald-600" />
              ) : null}
            </div>
            <SignaturePad disabled={busy} onSave={uploadSignature} />
          </section>
          <section className="rounded-3xl border border-blue-100 bg-blue-50 p-4">
            <h2 className="font-bold text-[#0D1282]">Complete pickup</h2>
            <p className="mt-1 text-xs text-slate-600">
              Requires every parcel resolved, OTP or approved exception, one
              photo, and signature. GPS is captured when your phone permits it.
            </p>
            <button
              disabled={
                busy ||
                !otpComplete ||
                !hasPhoto ||
                !hasSignature ||
                parcels.some((parcel) => parcel.status === "PENDING")
              }
              onClick={() => void complete()}
              className="mt-4 h-14 w-full rounded-2xl bg-emerald-600 text-base font-bold text-white disabled:bg-slate-300"
            >
              Complete and save POP
            </button>
          </section>
        </>
      ) : null}
      {selectedAttempt.status === "COMPLETED" ? (
        <div className="rounded-3xl bg-emerald-50 p-8 text-center text-emerald-800">
          <FiCheckCircle className="mx-auto h-10 w-10" />
          <h2 className="mt-3 text-xl font-bold">Pickup completed</h2>
          <p className="mt-1 text-sm">
            Proof of pickup and parcel events have been saved.
          </p>
        </div>
      ) : null}
      {["COLLECTING", "COMPLETED"].includes(selectedAttempt.status) ? (
        <PickupProofGallery
          pickupId={detail.id}
          attempts={detail.attempts}
          audience="driver"
        />
      ) : null}
    </div>
  );
}
