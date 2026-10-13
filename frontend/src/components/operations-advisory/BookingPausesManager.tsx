"use client";

import { FormEvent, useEffect, useState } from "react";
import { FiAlertCircle, FiEdit3, FiPlus, FiPower, FiSave, FiTrash2 } from "react-icons/fi";
import { toast } from "react-toastify";
import {
  bookingPauseCountryOptions,
  type BookingPause,
  type BookingPauseCountry,
  type BookingPauseInput,
  createBookingPause,
  deleteBookingPause,
  formatPauseWindow,
  listBookingPauses,
  toggleBookingPause,
  updateDpdBookingSetting,
  updateBookingPause
} from "@/lib/bookingPause";

type FormState = {
  countries: BookingPauseCountry[];
  startAt: string;
  endAt: string;
  reason: string;
  active: boolean;
};

const blankForm: FormState = {
  countries: [],
  startAt: "",
  endAt: "",
  reason: "",
  active: true
};

function statusTone(status: BookingPause["status"]) {
  if (status === "ACTIVE") return "bg-[#D71313]/10 text-[#D71313] border-[#D71313]/20";
  if (status === "UPCOMING") return "bg-amber-50 text-amber-800 border-amber-200";
  if (status === "DISABLED") return "bg-slate-100 text-slate-600 border-slate-200";
  return "bg-slate-50 text-slate-500 border-slate-200"; // EXPIRED
}

function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function BookingPausesManager() {
  const [pauses, setPauses] = useState<BookingPause[]>([]);
  const [dpdBookingEnabled, setDpdBookingEnabled] = useState(true);
  const [dpdBookingSettingState, setDpdBookingSettingState] = useState<"loading" | "ready" | "error">("loading");
  const [form, setForm] = useState<FormState>(blankForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dpdBookingSaving, setDpdBookingSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const data = await listBookingPauses();
        if (!active) return;
        setPauses(data.pauses);
        setDpdBookingEnabled(data.dpdBookingEnabled);
        setDpdBookingSettingState("ready");
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Unable to load booking pauses.");
        setDpdBookingSettingState("error");
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  function updateField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((c) => ({ ...c, [field]: value }));
    setMessage("");
  }

  async function handleDpdBookingToggle() {
    if (dpdBookingSettingState !== "ready" || dpdBookingSaving) return;
    setDpdBookingSaving(true);
    try {
      const data = await updateDpdBookingSetting(!dpdBookingEnabled);
      setDpdBookingEnabled(data.dpdBookingEnabled);
      toast.success(data.dpdBookingEnabled
        ? "Client DPD bookings enabled."
        : "Client DPD bookings disabled. Clients can still create shipments without DPD labels.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not update DPD booking availability.");
    } finally {
      setDpdBookingSaving(false);
    }
  }

  function handleCountryToggle(value: BookingPauseCountry) {
    setForm((current) => {
      const isAll = value === "ALL";
      if (isAll) {
        // Selecting ALL replaces everything, deselecting clears
        if (current.countries.includes("ALL")) return { ...current, countries: [] };
        return { ...current, countries: ["ALL"] };
      }
      // If ALL was active, remove it first
      let next = current.countries.includes("ALL") ? [] : [...current.countries];
      if (next.includes(value)) next = next.filter((v) => v !== value);
      else next = [...next, value];
      return { ...current, countries: next };
    });
    setMessage("");
  }

  function loadPause(pause: BookingPause) {
    setEditingId(pause.id);
    setForm({
      countries: [...pause.countries],
      startAt: toDateInput(pause.startAt),
      endAt: toDateInput(pause.endAt),
      reason: pause.reason,
      active: pause.active
    });
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetForm() {
    setEditingId(null);
    setForm(blankForm);
    setMessage("");
    setError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.countries.length) {
      setError("Select at least one destination.");
      return;
    }
    if (!form.startAt || !form.endAt) {
      setError("Start and end dates are required.");
      return;
    }
    if (!form.reason.trim()) {
      setError("Reason is required.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");

    const payload: BookingPauseInput = {
      countries: form.countries,
      startAt: form.startAt,
      endAt: form.endAt,
      reason: form.reason.trim(),
      active: form.active
    };

    try {
      if (editingId) await updateBookingPause(editingId, payload);
      else await createBookingPause(payload);
      const refreshed = await listBookingPauses();
      setPauses(refreshed.pauses);
      setMessage(editingId ? "Booking pause updated." : "Booking pause created. Bookings are now blocked for the selected destinations.");
      resetForm();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save booking pause.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(pause: BookingPause) {
    setBusy(true);
    setError("");
    try {
      await toggleBookingPause(pause.id);
      const refreshed = await listBookingPauses();
      setPauses(refreshed.pauses);
      setMessage(pause.active ? "Booking pause disabled." : "Booking pause enabled.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Toggle failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(pause: BookingPause) {
    if (!window.confirm(`Delete pause for "${pause.countryLabels.join(", ")}"? This cannot be undone.`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteBookingPause(pause.id);
      const refreshed = await listBookingPauses();
      setPauses(refreshed.pauses);
      if (editingId === pause.id) resetForm();
      setMessage("Booking pause deleted.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "mt-2 h-10 w-full border border-slate-300 bg-white rounded-xl px-3 text-sm outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100";
  const labelClass = "text-xs font-semibold uppercase text-slate-500";
  const clientDpdBookingEnabled = dpdBookingSettingState === "ready" && dpdBookingEnabled;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
      <form onSubmit={handleSubmit} className="h-fit border border-slate-200 bg-white rounded-2xl">
        <section aria-labelledby="client-dpd-booking-heading" className="flex flex-col gap-4 border-b border-slate-200 bg-slate-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors duration-200 motion-reduce:transition-none ${
                dpdBookingSettingState === "loading"
                  ? "bg-white text-slate-500"
                  : clientDpdBookingEnabled
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-white text-slate-500"
              }`}
            >
              <FiPower className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id="client-dpd-booking-heading" className="text-sm font-semibold text-slate-950">
                DPD bookings for clients
              </h2>
              <p
                id="client-dpd-booking-description"
                role="status"
                aria-live="polite"
                className="mt-1 max-w-2xl text-xs leading-5 text-slate-600"
              >
                {dpdBookingSettingState === "loading"
                  ? "Loading current booking setting…"
                  : dpdBookingSettingState === "error"
                    ? "Could not load the current setting. Refresh this page to try again."
                    : "When disabled, clients can create shipments without a DPD label. Staff booking actions remain available."}
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={clientDpdBookingEnabled}
            aria-labelledby="client-dpd-booking-heading"
            aria-describedby="client-dpd-booking-description"
            aria-busy={dpdBookingSaving || dpdBookingSettingState === "loading"}
            onClick={() => void handleDpdBookingToggle()}
            disabled={dpdBookingSaving || dpdBookingSettingState !== "ready"}
            className="inline-flex h-11 w-16 shrink-0 items-center justify-center rounded-full transition-transform duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
          >
            <span className={`relative h-7 w-12 rounded-full transition-colors duration-200 ease-out motion-reduce:transition-none ${clientDpdBookingEnabled ? "bg-emerald-600" : "bg-slate-300"}`}>
              <span
                aria-hidden="true"
                className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none ${clientDpdBookingEnabled ? "translate-x-5" : "translate-x-0"}`}
              />
            </span>
          </button>
        </section>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">
            {editingId ? "Edit Booking Pause" : "Pause Bookings"}
          </h2>
          {editingId ? (
            <button type="button" onClick={resetForm} className="text-xs font-semibold text-[#0D1282] hover:underline">
              Cancel edit
            </button>
          ) : null}
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Start date <span className="text-[#D71313]">*</span></span>
            <input type="date" required value={form.startAt} onChange={(e) => updateField("startAt", e.target.value)} className={inputClass} />
          </label>
          <label className="block">
            <span className={labelClass}>End date <span className="text-[#D71313]">*</span></span>
            <input type="date" required value={form.endAt} onChange={(e) => updateField("endAt", e.target.value)} className={inputClass} />
          </label>

          <div className="md:col-span-2">
            <span className={labelClass}>Destinations <span className="text-[#D71313]">*</span></span>
            <p className="mt-1 text-xs text-slate-500">Select one or more. All blocks every country. Europe covers all European countries.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {bookingPauseCountryOptions.map((opt) => {
                const checked = form.countries.includes(opt.value);
                const isAll = opt.value === "ALL";
                return (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                      checked ? "border-[#0D1282] bg-[#0D1282]/[0.06] text-[#0D1282]" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                    } ${isAll ? "sm:col-span-2" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleCountryToggle(opt.value)}
                      className="h-4 w-4 accent-[#0D1282]"
                    />
                    {opt.label}
                    {isAll ? <span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-slate-500">Every country</span> : null}
                  </label>
                );
              })}
            </div>
          </div>

          <label className="block md:col-span-2">
            <span className={labelClass}>Reason <span className="text-[#D71313]">*</span></span>
            <textarea
              required
              maxLength={500}
              rows={3}
              value={form.reason}
              onChange={(e) => updateField("reason", e.target.value)}
              placeholder="e.g. Bookings to UK, US, Canada and Europe closed for operational reasons - 29 Aug to 30 Aug 2026"
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
            />
            <span className="mt-1 block text-right text-[11px] text-slate-400">{form.reason.length}/500</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 p-4">
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
            <input type="checkbox" checked={form.active} onChange={(e) => updateField("active", e.target.checked)} className="h-4 w-4 accent-[#0D1282]" />
            Active (bookings blocked when on)
          </label>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            <FiSave aria-hidden="true" className="h-4 w-4" />
            {busy ? "Saving..." : editingId ? "Update Pause" : "Pause Bookings"}
          </button>
        </div>
      </form>

      <aside className="border border-slate-200 bg-white rounded-2xl overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">Booking Pauses</h2>
          <p className="mt-1 text-xs text-slate-500">Active pauses block bookings immediately. Toggle or edit anytime.</p>
        </div>

        <div className="divide-y divide-slate-100">
          {pauses.length === 0 ? (
            <div className="p-6 text-center">
              <FiAlertCircle aria-hidden="true" className="mx-auto h-8 w-8 text-slate-300" />
              <p className="mt-2 text-sm font-medium text-slate-600">No booking pauses yet.</p>
              <p className="mt-1 text-xs text-slate-500">Pauses you create here block bookings for the selected dates and countries.</p>
            </div>
          ) : (
            pauses.map((pause) => (
              <div key={pause.id} className="px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${statusTone(pause.status)}`}>
                    {pause.status}
                  </span>
                  {!pause.active ? <span className="text-[11px] font-semibold text-slate-500">· Disabled</span> : null}
                  <span className="ml-auto text-[11px] font-medium text-slate-400">{formatPauseWindow(pause)}</span>
                </div>
                <p className="mt-2 text-sm font-semibold leading-5 text-slate-900">{pause.countryLabels.join(", ")}</p>
                <p className="mt-1 text-sm leading-5 text-slate-600">{pause.reason}</p>
                <p className="mt-1 text-[11px] font-medium text-slate-400">
                  {pause.countries.join(" · ")} · {new Date(pause.startAt).toLocaleDateString("en-GB")} → {new Date(pause.endAt).toLocaleDateString("en-GB")}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => loadPause(pause)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:border-[#0D1282] hover:text-[#0D1282]"
                  >
                    <FiEdit3 aria-hidden="true" className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggle(pause)}
                    disabled={busy}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${
                      pause.active
                        ? "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300"
                        : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300"
                    } disabled:opacity-50`}
                  >
                    <FiPower aria-hidden="true" className="h-3.5 w-3.5" /> {pause.active ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(pause)}
                    disabled={busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:border-[#D71313] hover:text-[#D71313] disabled:opacity-50"
                  >
                    <FiTrash2 aria-hidden="true" className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={() => { resetForm(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          className="flex w-full items-center justify-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-[#0D1282] hover:bg-[#0D1282]/5"
        >
          <FiPlus aria-hidden="true" className="h-4 w-4" /> New pause
        </button>
      </aside>

      {error ? <div className="xl:col-span-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div> : null}
      {message ? <div className="xl:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{message}</div> : null}
    </div>
  );
}
