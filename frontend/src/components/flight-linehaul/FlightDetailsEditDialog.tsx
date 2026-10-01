"use client";

import { FormEvent, useState } from "react";
import { toast } from "react-toastify";
import { updateFlight, type FlightListItem } from "@/lib/flightLinehaul";
import { indiaDateTimeLocalToIso, isoToIndiaDateTimeLocal } from "@/lib/indiaDateTime";
import { useDialog } from "@/lib/useDialog";

type FlightForm = {
  flightNumber: string;
  airlineName: string;
  mawbNumber: string;
  originIataCode: string;
  destinationIataCode: string;
  transitIataCode: string;
  scheduledDepartureLocal: string;
  scheduledArrivalLocal: string;
  capacityKg: string;
  destinationAgent: string;
  finalMileCarrier: string;
};

function formFromFlight(flight: FlightListItem): FlightForm {
  return {
    flightNumber: flight.flightNumber,
    airlineName: flight.airlineName,
    mawbNumber: flight.mawbNumber,
    originIataCode: flight.originIataCode,
    destinationIataCode: flight.destinationIataCode,
    transitIataCode: flight.transitIataCode,
    scheduledDepartureLocal: isoToIndiaDateTimeLocal(flight.scheduledDepartureAt),
    scheduledArrivalLocal: isoToIndiaDateTimeLocal(flight.scheduledArrivalAt),
    capacityKg: String(flight.capacityKg),
    destinationAgent: flight.destinationAgent,
    finalMileCarrier: flight.finalMileCarrier
  };
}

export default function FlightDetailsEditDialog({
  flight,
  onClose,
  onSaved
}: {
  flight: FlightListItem;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState(() => formFromFlight(flight));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useDialog<HTMLFormElement>(true, () => {
    if (!saving) onClose();
  });
  const field = (key: keyof FlightForm, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason.trim().length < 5) return toast.error("Enter a clear correction reason of at least 5 characters.");
    const scheduledDepartureAt = indiaDateTimeLocalToIso(form.scheduledDepartureLocal);
    const scheduledArrivalAt = indiaDateTimeLocalToIso(form.scheduledArrivalLocal);
    if (!scheduledDepartureAt || !scheduledArrivalAt) return toast.error("Enter valid scheduled departure and arrival times in IST.");
    setSaving(true);
    try {
      await updateFlight(flight.id || flight._id, {
        flightNumber: form.flightNumber.trim(),
        airlineName: form.airlineName.trim(),
        mawbNumber: form.mawbNumber.trim(),
        originIataCode: form.originIataCode.trim().toUpperCase(),
        destinationIataCode: form.destinationIataCode.trim().toUpperCase(),
        transitIataCode: form.transitIataCode.trim().toUpperCase(),
        scheduledDepartureAt,
        scheduledArrivalAt,
        capacityKg: Number(form.capacityKg),
        destinationAgent: form.destinationAgent.trim(),
        finalMileCarrier: form.finalMileCarrier.trim(),
        reason: reason.trim()
      });
      toast.success("Flight and linked manifest details updated.");
      onClose();
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Flight details could not be updated.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-3 sm:p-5">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-flight-details-title"
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none"
      >
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4 sm:px-6">
          <h2 id="edit-flight-details-title" className="text-lg font-semibold text-slate-950">Edit flight details</h2>
          <p className="mt-1 text-sm leading-5 text-slate-600">The change is audited and shared manifest fields stay synchronized. Archived manifests remain read-only.</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
          <Field label="Flight number" value={form.flightNumber} maxLength={20} required onChange={(value) => field("flightNumber", value.toUpperCase())} />
          <Field label="Airline" value={form.airlineName} maxLength={120} required onChange={(value) => field("airlineName", value)} />
          <Field label="MAWB number" value={form.mawbNumber} maxLength={40} required onChange={(value) => field("mawbNumber", value)} />
          <Field label="Origin IATA" value={form.originIataCode} maxLength={3} required onChange={(value) => field("originIataCode", value.toUpperCase())} />
          <Field label="Destination IATA" value={form.destinationIataCode} maxLength={3} required onChange={(value) => field("destinationIataCode", value.toUpperCase())} />
          <Field label="Transit IATA" value={form.transitIataCode} maxLength={3} onChange={(value) => field("transitIataCode", value.toUpperCase())} />
          <Field label="Scheduled departure (IST)" value={form.scheduledDepartureLocal} type="datetime-local" required onChange={(value) => field("scheduledDepartureLocal", value)} />
          <Field label="Scheduled arrival (IST)" value={form.scheduledArrivalLocal} type="datetime-local" required onChange={(value) => field("scheduledArrivalLocal", value)} />
          <Field label="Flight capacity (kg)" value={form.capacityKg} type="number" required onChange={(value) => field("capacityKg", value)} />
          <Field label="Final-mile carrier" value={form.finalMileCarrier} maxLength={200} onChange={(value) => field("finalMileCarrier", value)} />
          <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
            Destination agent details
            <textarea maxLength={1000} rows={3} value={form.destinationAgent} onChange={(event) => field("destinationAgent", event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15" />
          </label>
          <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600 sm:col-span-2">Departure date and time use IST. If the flight has not departed, changing the schedule also changes its automatic-departure time. The printed manifest uses the date only; actual flight times and shipment events are not rewritten.</p>
          <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
            Correction reason
            <textarea required minLength={5} maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain why the flight details need correction" className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15" />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 sm:px-6">
          <button type="button" disabled={saving} onClick={onClose} className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={saving} className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0A0F6D] disabled:cursor-not-allowed disabled:opacity-60">{saving ? "Saving..." : "Save flight details"}</button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  type = "text",
  required = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  type?: "text" | "datetime-local" | "number";
  required?: boolean;
}) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <input required={required} maxLength={maxLength} min={type === "number" ? "0.1" : undefined} step={type === "number" ? "0.1" : undefined} type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15" />
    </label>
  );
}
