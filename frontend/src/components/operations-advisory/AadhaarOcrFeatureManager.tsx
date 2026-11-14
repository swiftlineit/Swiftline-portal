"use client";

import { useEffect, useState } from "react";
import { FiAlertCircle } from "react-icons/fi";
import { toast } from "react-toastify";
import {
  getAadhaarOcrFeatureStatus,
  updateAadhaarOcrFeature,
  type AadhaarOcrFeatureStatus,
} from "@/lib/operationsAdvisory";

type LoadState = "loading" | "ready" | "error";

export default function AadhaarOcrFeatureManager() {
  const [status, setStatus] = useState<AadhaarOcrFeatureStatus | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getAadhaarOcrFeatureStatus()
      .then((result) => {
        if (!active) return;
        setStatus(result);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Could not load Aadhaar OCR settings.");
        setLoadState("error");
      });
    return () => { active = false; };
  }, []);

  async function handleToggle() {
    if (!status || loadState !== "ready" || saving) return;
    const nextEnabled = !status.enabled;
    setSaving(true);
    setError("");
    try {
      const updated = await updateAadhaarOcrFeature(nextEnabled);
      setStatus(updated);
      toast.success(nextEnabled ? "Aadhaar OCR is enabled for staff and clients." : "Aadhaar OCR is disabled.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not update Aadhaar OCR settings.";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  const unavailable = loadState !== "ready" || saving || (!status?.enabled && !status?.providerConfigured);

  return (
    <section className="max-w-3xl rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Aadhaar OCR uploads</h2>
          <p className="mt-1 max-w-xl text-sm text-slate-600">
            Control the Surepass scan and prefill panel in Swiftline staff and client booking forms.
            Standard KYC document uploads remain available when OCR is off.
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
        <div className="text-sm text-slate-600">
          <p>
            Provider: <span className="font-medium capitalize text-slate-800">{status?.providerEnvironment ?? "-"}</span>
            <span className="mx-2 text-slate-300">·</span>
            Configuration: <span className={`font-medium ${status?.providerConfigured ? "text-emerald-700" : "text-amber-700"}`}>
              {loadState === "loading" ? "Checking" : status?.providerConfigured ? "Ready" : "Incomplete"}
            </span>
          </p>
          {!status?.providerConfigured && loadState === "ready" ? (
            <p className="mt-1 max-w-xl text-xs text-amber-800">
              {status?.enabled
                ? "The setting is on, but provider configuration is incomplete; scans are blocked until it is fixed."
                : "Add the backend Surepass token and, for production, the live Aadhaar Full endpoint before enabling."}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Aadhaar OCR uploads"
          aria-checked={status?.enabled ?? false}
          aria-busy={saving}
          title={status?.enabled ? "Turn off Aadhaar OCR" : "Turn on Aadhaar OCR"}
          disabled={unavailable}
          onClick={() => void handleToggle()}
          className="inline-flex min-h-9 shrink-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span
            aria-hidden="true"
            className={`relative block h-7 w-12 rounded-full transition-colors duration-500 ease-in-out motion-reduce:transition-none ${status?.enabled ? "bg-green-600" : "bg-red-600"}`}
          >
            <span
              className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-500 ease-in-out motion-reduce:transition-none ${status?.enabled ? "translate-x-5" : "translate-x-0"}`}
            />
          </span>
        </button>
      </div>

      {loadState === "error" || error ? (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <FiAlertCircle aria-hidden="true" className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
