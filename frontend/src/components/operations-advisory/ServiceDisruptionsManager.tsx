"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { FiChevronDown, FiEdit3, FiPlus, FiSave, FiTrash2 } from "react-icons/fi";
import { listBranches, type Branch } from "@/lib/branches";
import {
  createServiceDisruption,
  deleteServiceDisruption,
  listServiceDisruptions,
  serviceDisruptionSeverities,
  serviceDisruptionTypeLabels,
  serviceDisruptionTypes,
  updateServiceDisruption,
  type ServiceDisruption,
  type ServiceDisruptionInput,
  type ServiceDisruptionSeverity,
  type ServiceDisruptionType
} from "@/lib/operationsAdvisory";

/**
 * The Service Disruption Centre tab. Publishes the advisories that run on the
 * header marquee and notify clients. The form is always on screen- blank for
 * a new disruption, populated when the staff click Edit on a listed one.
 */

type FormState = {
  type: ServiceDisruptionType;
  severity: ServiceDisruptionSeverity;
  title: string;
  message: string;
  startAtLocal: string;
  endAtLocal: string;
  affectedBranches: string[];
  active: boolean;
};

const blankForm: FormState = {
  type: "WEATHER_DISRUPTION",
  severity: "INFO",
  title: "",
  message: "",
  startAtLocal: "",
  endAtLocal: "",
  affectedBranches: [],
  active: true
};

function toDateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocal(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function severityTone(severity: ServiceDisruptionSeverity) {
  if (severity === "CRITICAL") return "bg-[#D71313]/10 text-[#D71313]";
  if (severity === "WARNING") return "bg-amber-100 text-amber-800";
  return "bg-sky-100 text-sky-800";
}

export default function ServiceDisruptionsManager() {
  const [disruptions, setDisruptions] = useState<ServiceDisruption[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState<FormState>(blankForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setError("");
      try {
        const [branchData, disruptionData] = await Promise.all([
          listBranches("", "ACTIVE"),
          listServiceDisruptions()
        ]);
        if (!active) return;
        setBranches(branchData.branches);
        setDisruptions(disruptionData.disruptions);
      } catch (caughtError) {
        if (!active) return;
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load service disruptions.");
      }
    }

    void load();
    return () => { active = false; };
  }, []);

  function updateField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setMessage("");
  }

  function handleTextChange(field: keyof FormState) {
    return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      updateField(field, event.target.value as FormState[keyof FormState]);
    };
  }

  function toggleBranch(branchId: string) {
    setForm((current) => {
      const selected = new Set(current.affectedBranches);
      if (selected.has(branchId)) selected.delete(branchId);
      else selected.add(branchId);
      return { ...current, affectedBranches: [...selected] };
    });
    setMessage("");
  }

  function loadDisruption(disruption: ServiceDisruption) {
    setEditingId(disruption.id);
    setForm({
      type: disruption.type,
      severity: disruption.severity,
      title: disruption.title,
      message: disruption.message,
      startAtLocal: toDateTimeLocal(disruption.startAt),
      endAtLocal: toDateTimeLocal(disruption.endAt),
      affectedBranches: disruption.affectedBranches,
      active: disruption.active
    });
    setMessage("");
    setError("");
  }

  function resetForm() {
    setEditingId(null);
    setForm(blankForm);
    setMessage("");
    setError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    const payload: ServiceDisruptionInput = {
      type: form.type,
      severity: form.severity,
      title: form.title.trim(),
      message: form.message.trim(),
      startAt: fromDateTimeLocal(form.startAtLocal) ?? new Date().toISOString(),
      endAt: fromDateTimeLocal(form.endAtLocal),
      affectedBranches: form.affectedBranches,
      active: form.active
    };

    try {
      if (editingId) {
        await updateServiceDisruption(editingId, payload);
      } else {
        await createServiceDisruption(payload);
      }

      const refreshed = await listServiceDisruptions();
      setDisruptions(refreshed.disruptions);
      setMessage(editingId ? "Disruption updated." : "Disruption published.");
      resetForm();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Disruption could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(disruption: ServiceDisruption) {
    if (!window.confirm(`Delete "${disruption.title}"? This cannot be undone.`)) return;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await deleteServiceDisruption(disruption.id);
      const refreshed = await listServiceDisruptions();
      setDisruptions(refreshed.disruptions);
      if (editingId === disruption.id) resetForm();
      setMessage("Disruption deleted.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Disruption could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  const controlBaseClass = "h-10 w-full border border-slate-300 bg-white rounded-xl px-3 text-sm outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100";
  const inputClass = `mt-2 ${controlBaseClass}`;
  const selectClass = `${controlBaseClass} appearance-none pr-9`;
  const labelClass = "text-xs font-semibold uppercase text-slate-500";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
      <form onSubmit={handleSubmit} className="h-fit border border-slate-200 bg-white rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">
            {editingId ? "Edit Disruption" : "Publish a Disruption"}
          </h2>
          {editingId ? (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs font-semibold text-[#0D1282] hover:underline"
            >
              Cancel edit
            </button>
          ) : null}
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Type</span>
            <div className="relative mt-2">
              <select value={form.type} onChange={handleTextChange("type")} className={selectClass}>
                {serviceDisruptionTypes.map((type) => (
                  <option key={type} value={type}>{serviceDisruptionTypeLabels[type]}</option>
                ))}
              </select>
              <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
          </label>

          <label className="block">
            <span className={labelClass}>Severity</span>
            <div className="relative mt-2">
              <select
                value={form.severity}
                onChange={(event) => updateField("severity", event.target.value as ServiceDisruptionSeverity)}
                className={selectClass}
              >
                {serviceDisruptionSeverities.map((severity) => (
                  <option key={severity} value={severity}>{severity}</option>
                ))}
              </select>
              <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            </div>
          </label>

          <label className="block md:col-span-2">
            <span className={labelClass}>Title</span>
            <input required maxLength={120} value={form.title} onChange={handleTextChange("title")} className={inputClass} placeholder="e.g. Customs strike at Heathrow" />
          </label>

          <label className="block md:col-span-2">
            <span className={labelClass}>Message</span>
            <textarea
              required
              maxLength={500}
              rows={3}
              value={form.message}
              onChange={handleTextChange("message")}
              className="mt-2 w-full border rounded-xl border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
              placeholder="What clients need to know about this disruption"
            />
          </label>

          <label className="block">
            <span className={labelClass}>Starts</span>
            <input required type="datetime-local" value={form.startAtLocal} onChange={handleTextChange("startAtLocal")} className={inputClass} />
          </label>

          <label className="block">
            <span className={labelClass}>Ends (optional)</span>
            <input type="datetime-local" value={form.endAtLocal} onChange={handleTextChange("endAtLocal")} className={inputClass} />
          </label>

          <div className="md:col-span-2">
            <span className={labelClass}>Affected branches</span>
            <p className="mt-1 text-xs text-slate-500">Leave none selected to target every branch.</p>
            <div className="mt-2 grid max-h-40 grid-cols-1 gap-1 rounded overflow-y-auto border border-slate-200 p-2 sm:grid-cols-2">
              {branches.length === 0 ? (
                <p className="col-span-full p-2 text-xs text-slate-400">No active branches.</p>
              ) : branches.map((branch) => {
                const selected = form.affectedBranches.includes(branch._id);
                return (
                  <label
                    key={branch._id}
                    className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition ${
                      selected ? "bg-[#0D1282]/[0.08] text-slate-900" : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleBranch(branch._id)}
                      className="h-4 w-4 accent-[#0D1282]"
                    />
                    <span className="truncate">{branch.code} · {branch.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 p-4">
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(event) => updateField("active", event.target.checked)}
              className="h-4 w-4 accent-[#0D1282]"
            />
            Active
          </label>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 bg-blue-900 rounded-4xl px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            <FiSave aria-hidden="true" className="h-4 w-4" />
            {busy ? "Saving..." : editingId ? "Update Disruption" : "Publish Disruption"}
          </button>
        </div>
      </form>

      <aside className="border border-slate-200 bg-white rounded-xl">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">Published Disruptions</h2>
        </div>

        <div className="divide-y divide-slate-100">
          {disruptions.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No disruptions yet.</div>
          ) : disruptions.map((disruption) => (
            <div key={disruption.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-950">{disruption.title}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${severityTone(disruption.severity)}`}>
                      {disruption.severity}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{serviceDisruptionTypeLabels[disruption.type]}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{disruption.message}</p>
                  <p className="mt-1 text-[11px] font-medium text-slate-400">
                    {new Date(disruption.startAt).toLocaleString()} {disruption.endAt ? `→ ${new Date(disruption.endAt).toLocaleString()}` : "(open-ended)"}
                    {" · "}{disruption.active ? "Active" : "Inactive"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => loadDisruption(disruption)}
                    aria-label={`Edit ${disruption.title}`}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 transition hover:border-[#0D1282] hover:text-[#0D1282]"
                  >
                    <FiEdit3 aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(disruption)}
                    aria-label={`Delete ${disruption.title}`}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 transition hover:border-[#D71313] hover:text-[#D71313]"
                  >
                    <FiTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => { resetForm(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          className="flex w-full items-center justify-center gap-2 border-t border-slate-200 px-4 py-3 text-sm font-semibold text-[#0D1282] hover:bg-[#0D1282]/5"
        >
          <FiPlus aria-hidden="true" className="h-4 w-4" />
          New disruption
        </button>
      </aside>

      {error ? <div className="xl:col-span-2 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div> : null}
      {message ? <div className="xl:col-span-2 border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{message}</div> : null}
    </div>
  );
}
