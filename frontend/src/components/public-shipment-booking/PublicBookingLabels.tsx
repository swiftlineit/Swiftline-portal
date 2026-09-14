"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiUrl } from "@/lib/api";

type Label = { id: string; parcelNumber: string; parcelCount: number; format: string; downloadUrl: string };
export default function PublicBookingLabels() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [labels, setLabels] = useState<Label[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(apiUrl(`/api/v1/public/shipment-bookings/status/labels${token ? `?token=${encodeURIComponent(token)}` : ""}`), { credentials: "include" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.message || "Labels could not be loaded.");
        return payload;
      })
      .then((payload) => setLabels(payload.labels))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Labels could not be loaded."));
  }, [token]);
  return (
    <section className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0D1282]">Swiftline parcel labels</p>
      <h1 className="mt-2 text-2xl font-bold text-slate-950">Download shipment labels</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">Print the PDF at actual size and attach each label to the matching parcel.</p>
      {error ? <p role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <div className="mt-6 space-y-3">
        {labels.map((label) => (
          <a key={label.id} href={apiUrl(label.downloadUrl)} className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm font-bold text-slate-800 hover:border-[#0D1282] hover:text-[#0D1282]">
            <span>{label.parcelCount > 1 ? `${label.parcelCount} parcel labels` : label.parcelNumber}</span>
            <span>Download {label.format}</span>
          </a>
        ))}
      </div>
      {!error && !labels.length ? <p className="mt-5 text-sm text-slate-500" role="status">Loading labels…</p> : null}
    </section>
  );
}
