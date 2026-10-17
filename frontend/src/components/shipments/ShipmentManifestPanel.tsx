"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiDownload, FiFileText, FiPlus, FiX } from "react-icons/fi";
import { toast } from "react-toastify";
import { formatDashboardDate } from "@/lib/dateFormat";
import {
  createShipmentManifest,
  downloadShipmentManifest,
  getShipmentManifestContext,
  type ManifestEligibleShipment,
  type ShipmentManifestAudience,
  type ShipmentManifestContext,
  type ShipmentManifestSummary
} from "@/lib/shipmentManifests";

function formatMoneyMinor(valueMinor: number) {
  if (valueMinor <= 0) return "Unavailable";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2
  }).format(valueMinor / 100);
}

type LineState = { selected: boolean; bagNumber: string };

type ManifestHeaderState = {
  destinationAgent: string;
  flightNumber: string;
  departureDate: string;
  mawbNumber: string;
  originIataCode: string;
  destinationIataCode: string;
  valueType: string;
};

export default function ShipmentManifestPanel({
  draftId,
  audience
}: {
  draftId: string;
  audience: ShipmentManifestAudience;
}) {
  const [context, setContext] = useState<ShipmentManifestContext | null>(null);
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [header, setHeader] = useState<ManifestHeaderState>({
    destinationAgent: "",
    flightNumber: "",
    departureDate: "",
    mawbNumber: "",
    originIataCode: "",
    destinationIataCode: "",
    valueType: "LV"
  });

  const loadContext = useCallback(async () => {
    try {
      const data = await getShipmentManifestContext(draftId, audience);
      setContext(data);
      setLines(
        Object.fromEntries(
          data.eligibleShipments.map((shipment) => [
            shipment.shipmentDraftId,
            {
              selected: shipment.shipmentDraftId === data.currentShipmentDraftId,
              bagNumber: ""
            }
          ])
        )
      );
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Manifest information could not be loaded.");
    }
  }, [audience, draftId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadContext(), 0);
    return () => window.clearTimeout(timer);
  }, [loadContext]);

  const selectedShipments = useMemo(
    () => context?.eligibleShipments.filter((shipment) => lines[shipment.shipmentDraftId]?.selected) ?? [],
    [context, lines]
  );
  const currentShipment = context?.eligibleShipments.find((shipment) => shipment.shipmentDraftId === draftId);
  const currentShipmentEligible = Boolean(currentShipment);
  const selectedPieces = selectedShipments.reduce((sum, shipment) => sum + shipment.pieces, 0);
  const selectedWeight = selectedShipments.reduce((sum, shipment) => sum + shipment.weightKg, 0);
  const ownManifestExists = Boolean(context?.existingManifests.some((manifest) => manifest.actorRole === audience));

  function updateHeader(field: keyof typeof header, value: string) {
    setHeader((current) => ({
      ...current,
      [field]: field.endsWith("IataCode") ? value.toUpperCase().slice(0, 3) : value
    }));
  }

  function updateLine(shipmentDraftId: string, patch: Partial<LineState>) {
    setLines((current) => ({
      ...current,
      [shipmentDraftId]: { ...current[shipmentDraftId], ...patch }
    }));
  }

  async function handleCreate() {
    if (!context || !selectedShipments.length) return;

    if (audience === "client") {
      setBusy(true);
      setError("");
      try {
        const result = await createShipmentManifest(
          {
            currentShipmentDraftId: draftId
          },
          audience
        );
        toast.success(`${result.manifest.manifestNumber} created successfully.`);
        await downloadShipmentManifest(result.manifest, audience);
        setShowForm(false);
        await loadContext();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Manifest could not be created.");
      } finally {
        setBusy(false);
      }
      return;
    }

    const invalidLine = selectedShipments.find((shipment) => {
      const line = lines[shipment.shipmentDraftId];
      return !line?.bagNumber.trim();
    });
    if (invalidLine) {
      setError(`Enter a bag number for ${invalidLine.consignmentNumber}.`);
      return;
    }
    if (
      (header.originIataCode && header.originIataCode.length !== 3) ||
      (header.destinationIataCode && header.destinationIataCode.length !== 3)
    ) {
      setError("IATA codes must contain exactly three letters.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const result = await createShipmentManifest(
        {
          currentShipmentDraftId: draftId,
          ...header,
          lines: selectedShipments.map((shipment) => ({
            shipmentDraftId: shipment.shipmentDraftId,
            bagNumber: lines[shipment.shipmentDraftId].bagNumber.trim()
          }))
        },
        audience
      );
      toast.success(`${result.manifest.manifestNumber} created successfully.`);
      await downloadShipmentManifest(result.manifest, audience);
      setShowForm(false);
      await loadContext();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Manifest could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(manifest: ShipmentManifestSummary) {
    setBusy(true);
    setError("");
    try {
      await downloadShipmentManifest(manifest, audience);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Manifest could not be downloaded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border rounded-2xl border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Shipment Manifest</h2>
          <p className="mt-1 text-sm text-slate-600">Create and download dispatch manifests from booked shipments.</p>
        </div>
        {context?.canCreate && !ownManifestExists && currentShipmentEligible ? (
          <button
            type="button"
            onClick={() => setShowForm((value) => !value)}
            className="inline-flex h-10 rounded-4xl items-center justify-center gap-2 bg-blue-950 px-4 text-sm font-semibold text-white hover:bg-blue-900"
          >
            {showForm ? <FiX aria-hidden="true" /> : <FiPlus aria-hidden="true" />}
            {showForm ? "Close" : "Create Manifest"}
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-medium text-red-700">{error}</div>
      ) : null}

      {context?.existingManifests.length ? (
        <div className="divide-y divide-slate-100">
          {context.existingManifests.map((manifest) => (
            <div key={manifest.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="flex min-w-0 items-start gap-3">
                <FiFileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-blue-900" />
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-950">{manifest.manifestNumber}</p>
                    {audience === "admin" ? (
                      <span className="border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold uppercase text-slate-600">
                        {manifest.manifestType === "COMBINED"
                          ? "Staff Combined Manifest"
                          : manifest.actorRole === "client" ? "Client Account Manifest" : "Staff Account Manifest"}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-500">
                    {formatDashboardDate(manifest.generatedAt)} | {manifest.shipmentCount} shipment(s) | {manifest.totalWeightKg.toFixed(2)} kg
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleDownload(manifest)}
                disabled={busy}
                className="inline-flex h-9 items-center rounded-4xl justify-center gap-2 border border-slate-300 px-3 text-sm font-semibold text-blue-900 hover:border-blue-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FiDownload aria-hidden="true" /> Download
              </button>
            </div>
          ))}
        </div>
      ) : !showForm ? (
        <p className="px-5 py-4 text-sm text-slate-500">
          {context?.currentShipmentAlreadyManifested && audience === "client"
            ? "This shipment is already included in a manifest and cannot be added to another client manifest."
            : context?.canCreate
            ? currentShipmentEligible
              ? "No manifest has been generated for this shipment."
              : "Manifest creation becomes available after shipment booking and label generation are complete."
            : "Manifest creation is available to account owners, account admins, and operations users."}
        </p>
      ) : null}

      {showForm && context && audience === "client" && currentShipment ? (
        <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(240px,360px)] md:items-end">
          <div className="grid gap-4 border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
            <ManifestSummaryItem label="AWB / Tracking No." value={currentShipment.consignmentNumber} />
            <ManifestSummaryItem label="Pieces" value={String(currentShipment.pieces)} />
            <ManifestSummaryItem label="Weight" value={`${currentShipment.weightKg.toFixed(2)} kg`} />
            <ManifestSummaryItem label="Goods Value" value={formatMoneyMinor(currentShipment.declaredValueMinor)} />
          </div>
          <div>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={busy}
              className="mt-3 inline-flex h-10 w-full rounded-xl mr-6 items-center justify-center gap-2 bg-blue-950 px-4 text-sm font-semibold text-white hover:bg-blue-900 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              <FiFileText aria-hidden="true" /> {busy ? "Creating..." : "Create And Download Manifest"}
            </button>
          </div>
        </div>
      ) : showForm && context && audience === "admin" ? (
        <div className="space-y-5 p-5">
          <ManifestHeaderFields values={header} onChange={updateHeader} />
          <div className="overflow-x-auto border border-slate-200 rounded-2xl">
            <table className="min-w-[980px] w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-3">Include</th>
                  <th className="px-3 py-3">Consignment</th>
                  <th className="px-3 py-3">Consignee</th>
                  <th className="px-3 py-3">Pieces</th>
                  <th className="px-3 py-3">Weight</th>
                  <th className="px-3 py-3">Bag No.</th>
                  <th className="px-3 py-3">Goods Value (INR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {context.eligibleShipments.map((shipment) => (
                    <ManifestShipmentRow
                    key={shipment.shipmentDraftId}
                    shipment={shipment}
                    current={shipment.shipmentDraftId === draftId}
                    state={lines[shipment.shipmentDraftId]}
                    onChange={(patch) => updateLine(shipment.shipmentDraftId, patch)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-4">
            <p className="text-sm text-slate-600">
              <strong className="text-slate-950">{selectedShipments.length}</strong> shipments |{" "}
              <strong className="text-slate-950">{selectedPieces}</strong> pieces |{" "}
              <strong className="text-slate-950">{selectedWeight.toFixed(2)} kg</strong>
            </p>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={busy || !selectedShipments.length}
              className="inline-flex h-10 items-center justify-center rounded-xl gap-2 mr-6 bg-blue-950 px-4 text-sm font-semibold text-white hover:bg-blue-900 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              <FiFileText aria-hidden="true" /> {busy ? "Creating..." : "Create And Download Manifest"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ManifestHeaderFields({
  values,
  onChange
}: {
  values: ManifestHeaderState;
  onChange: (field: keyof ManifestHeaderState, value: string) => void;
}) {
  const fields = [
    ["flightNumber", "Flight Number"],
    ["departureDate", "Departure Date"],
    ["mawbNumber", "MAWB Number"],
    ["originIataCode", "Origin IATA"],
    ["destinationIataCode", "Destination IATA"],
    ["valueType", "Value Type"]
  ] as const;

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <label className="block md:col-span-2 xl:col-span-4">
        <span className="text-xs font-semibold uppercase text-slate-500">To / Destination Agent Details</span>
        <textarea
          rows={5}
          maxLength={1000}
          value={values.destinationAgent}
          onChange={(event) => onChange("destinationAgent", event.target.value)}
          placeholder={"Company or agent name\nAddress line 1\nCity and postcode\nCountry"}
          className="mt-2 w-full resize-y border rounded-2xl border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
        />
      </label>
      {fields.map(([field, label]) => (
        <label key={field} className="block">
          <span className="text-xs font-semibold uppercase text-slate-500">{label}</span>
          <input
            type={field === "departureDate" ? "date" : "text"}
            value={values[field]}
            onChange={(event) => onChange(field, event.target.value)}
            className="mt-2 h-10 w-full border rounded-xl border-slate-300 px-3 text-sm outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
          />
        </label>
      ))}
    </div>
  );
}

function ManifestSummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-slate-950">{value}</p>
    </div>
  );
}

function ManifestShipmentRow({
  shipment,
  current,
  state,
  onChange
}: {
  shipment: ManifestEligibleShipment;
  current: boolean;
  state?: LineState;
  onChange: (patch: Partial<LineState>) => void;
}) {
  return (
    <tr>
      <td className="px-3 py-3">
        <input
          type="checkbox"
          checked={Boolean(state?.selected)}
          disabled={current}
          onChange={(event) => onChange({ selected: event.target.checked })}
          aria-label={`Include ${shipment.consignmentNumber}`}
        />
      </td>
      <td className="px-3 py-3">
        <p className="font-semibold text-slate-950">{shipment.consignmentNumber}</p>
        {shipment.shipmentReference ? (
          <p className="mt-1 text-xs text-slate-500">Customer Ref: {shipment.shipmentReference}</p>
        ) : null}
      </td>
      <td className="px-3 py-3">
        <p className="font-medium text-slate-800">{shipment.consignee}</p>
        <p className="mt-1 text-xs text-slate-500">{shipment.destination}</p>
      </td>
      <td className="px-3 py-3">{shipment.pieces}</td>
      <td className="px-3 py-3">{shipment.weightKg.toFixed(2)} kg</td>
      <td className="px-3 py-3">
        <input
          value={state?.bagNumber ?? ""}
          disabled={!state?.selected}
          onChange={(event) => onChange({ bagNumber: event.target.value })}
          className="h-9 w-28 border border-slate-300 px-2 rounded-xl disabled:bg-slate-100"
        />
      </td>
      <td className="px-3 py-3">
        <span className="font-semibold text-slate-800">{formatMoneyMinor(shipment.declaredValueMinor)}</span>
      </td>
    </tr>
  );
}
