"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  FiAlertTriangle,
  FiCheckCircle,
  FiUploadCloud,
  FiX
} from "react-icons/fi";
import CountryFlag from "@/components/CountryFlag";
import RateCardCountryPicker from "@/components/rate-cards/RateCardCountryPicker";
import { resolveCountry } from "@/lib/countryLookup";
import {
  resolveImportedCountryNames,
  type ImportMatchConfidence
} from "@/lib/rateCardImportMatch";
import {
  commitRateCardImport,
  countryRateServices,
  formatCountryRateService,
  formatRateCardBand,
  previewRateCardImport,
  type CountryRateCard,
  type CountryRateService,
  type RateCardTarget,
  type RateCardImportPreview,
  type RateCardImportResult,
  type RateCardImportRoute
} from "@/lib/countryRateCards";

/**
 * Loads a rate-list workbook onto a band.
 *
 * A rate list prices a zone of countries with one column of numbers, so a
 * single file routinely carries nine hundred weight slabs- more than anyone
 * will type into the form one row at a time. This reads the grid, matches the
 * country names, shows what will change, and writes it in one request.
 *
 * Country matching happens here rather than on the server so it can use the
 * same catalogue the country picker uses, and so an operator can correct a
 * match before anything is stored.
 */

/** One destination the file will write, after matching and operator review. */
type ReviewRow = {
  id: string;
  /** The cell text, repeated on every row a split cell produced. */
  raw: string;
  /** The part of the cell this row came from. */
  part: string;
  countryCode: string;
  countryName: string;
  confidence: ImportMatchConfidence | null;
  /** The text in the correction picker, when the operator opens one. */
  query: string;
  rates: (number | null)[];
};

const confidenceLabels: Record<ImportMatchConfidence, string> = {
  exact: "Matched",
  alias: "Matched",
  prefix: "Matched",
  fuzzy: "Spelling corrected"
};

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-70 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-4xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <FiX aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * Turns the workbook grid into one review row per destination.
 *
 * Each zone is resolved as a group so the spelling of its neighbours can settle
 * an ambiguous name- see `resolveImportedCountryNames`.
 */
function buildReviewRows(preview: RateCardImportPreview): ReviewRow[] {
  return preview.zones.flatMap((zone, zoneIndex) =>
    resolveImportedCountryNames(zone.rawNames).flatMap((match, matchIndex) =>
      match.parts.map((part, partIndex) => ({
        id: `${zoneIndex}-${matchIndex}-${partIndex}`,
        raw: match.raw,
        part: part.raw,
        countryCode: part.country?.iso2.toUpperCase() ?? "",
        countryName: part.country?.name ?? "",
        confidence: part.confidence,
        query: part.country?.name ?? "",
        rates: zone.rates
      }))
    )
  );
}

/**
 * Weight rows to weight slabs, laid end to end from zero.
 *
 * Mirrors `buildSlabs` on the server. Pricing rounds chargeable weight up to a
 * whole kilogram before looking a slab up, so ranges of `0-1`, `1.01-2` leave
 * no reachable gap between them.
 */
function buildSlabs(weights: number[], rates: (number | null)[], maxBoxKg: number) {
  const slabs: RateCardImportRoute["slabs"] = [];

  weights.forEach((weight, index) => {
    const chargesPerKg = rates[index];
    if (chargesPerKg === null || chargesPerKg === undefined) return;

    const previous = weights[index - 1] ?? 0;
    slabs.push({
      fromKg: index === 0 ? 0 : Number((previous + 0.01).toFixed(2)),
      toKg: weight,
      chargesPerKg,
      maxBoxKg
    });
  });

  return slabs;
}

export default function RateCardImportDialog({
  target,
  cardName,
  version,
  existingRates,
  onClose,
  onImported
}: {
  target: RateCardTarget;
  cardName: string;
  version: number;
  /** Every rate already stored, so the review can say what will be replaced. */
  existingRates: CountryRateCard[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [services, setServices] = useState<CountryRateService[]>(["COURIER"]);
  const [maxBoxKg, setMaxBoxKg] = useState("");
  const [preview, setPreview] = useState<RateCardImportPreview | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [result, setResult] = useState<RateCardImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const heaviestWeight = preview?.weights.at(-1) ?? 0;

  async function handleFile(file: File) {
    setBusy(true);
    setError("");

    try {
      const parsed = await previewRateCardImport(file);
      setPreview(parsed);
      setRows(buildReviewRows(parsed));
      setMaxBoxKg(String(parsed.weights.at(-1) ?? ""));
      setConfirmReplace(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rate list could not be read.");
    } finally {
      setBusy(false);
    }
  }

  // What each destination already has on this band, so the review can tell a
  // new country from one whose rates are about to be replaced.
  const existingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rate of existingRates) {
      if (!services.includes(rate.service)) continue;
      counts.set(rate.countryCode, (counts.get(rate.countryCode) ?? 0) + 1);
    }
    return counts;
  }, [existingRates, services]);

  const unresolvedCount = rows.filter((row) => !row.countryCode).length;
  const duplicateCodes = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const row of rows) {
      if (!row.countryCode) continue;
      if (seen.has(row.countryCode)) duplicates.add(row.countryCode);
      seen.add(row.countryCode);
    }
    return duplicates;
  }, [rows]);

  const replacements = rows.filter((row) => row.countryCode && existingCounts.has(row.countryCode));
  const boxWeight = Number(maxBoxKg);
  const boxWeightValid = Number.isFinite(boxWeight) && boxWeight > 0;

  const blocked = Boolean(
    unresolvedCount
    || duplicateCodes.size
    || !services.length
    || !boxWeightValid
    || (replacements.length && !confirmReplace)
  );

  function updateRow(id: string, query: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row;
        const resolved = resolveCountry(query);
        return {
          ...row,
          query,
          countryCode: resolved?.iso2.toUpperCase() ?? "",
          countryName: resolved?.name ?? "",
          confidence: resolved ? "exact" : null
        };
      })
    );
    setConfirmReplace(false);
  }

  async function handleImport() {
    if (!preview || blocked) return;

    setBusy(true);
    setError("");

    try {
      const written = await commitRateCardImport({
        ...target,
        expectedVersion: version,
        services,
        confirmReplace,
        fileName: preview.fileName,
        routes: rows.map((row) => ({
          countryCode: row.countryCode,
          countryName: row.countryName,
          slabs: buildSlabs(preview.weights, row.rates, boxWeight)
        }))
      });

      setResult(written);
      onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rate list could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Shell title="Rate list imported" onClose={onClose}>
        <ImportResult result={result} onClose={onClose} />
      </Shell>
    );
  }

  return (
    <Shell title={`Import rates — ${cardName}`} onClose={onClose}>
      {error ? (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}

      {!preview ? (
        <ChooseStep
          services={services}
          setServices={setServices}
          busy={busy}
          onFile={handleFile}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-3">

            <Field label="Service">
              <div className="flex flex-wrap gap-2">
                {countryRateServices.map((service) => {
                  const selected = services.includes(service);
                  return (
                    <button
                      key={service}
                      type="button"
                      onClick={() => {
                        setServices((current) =>
                          current.includes(service)
                            ? current.filter((entry) => entry !== service)
                            : [...current, service]
                        );
                        setConfirmReplace(false);
                      }}
                      className={`inline-flex h-10 items-center rounded-full border px-4 text-xs font-semibold transition ${
                        selected
                          ? "border-[#0D1282] bg-[#0D1282]/10 text-[#0D1282]"
                          : "border-slate-300 text-slate-600 hover:border-slate-400"
                      }`}
                    >
                      {formatCountryRateService(service)}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Max box KG">
              <input
                type="number"
                min="0"
                step="0.01"
                value={maxBoxKg}
                onChange={(event) => setMaxBoxKg(event.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-900"
              />
              <p className="mt-1 text-[11px] leading-4 text-slate-500">
                {heaviestWeight
                  ? `Taken from the heaviest weight in the file (${heaviestWeight} kg).`
                  : "Not given in the file."}
              </p>
            </Field>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 text-sm text-slate-700">
            <span className="font-semibold text-slate-900">{preview.fileName}</span>
            {" · "}
            {preview.zones.length} zone{preview.zones.length === 1 ? "" : "s"}
            {" · "}
            {preview.weights.length} weight row{preview.weights.length === 1 ? "" : "s"}
            {" · "}
            {rows.length} destination{rows.length === 1 ? "" : "s"}
          </div>

          <ReviewTable
            rows={rows}
            existingCounts={existingCounts}
            duplicateCodes={duplicateCodes}
            weightCount={preview.weights.length}
            onCorrect={updateRow}
          />

          {unresolvedCount ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {unresolvedCount} name{unresolvedCount === 1 ? "" : "s"} could not be matched to a country. Pick each one to continue.
            </p>
          ) : null}

          {duplicateCodes.size ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              The same destination is listed more than once ({[...duplicateCodes].join(", ")}). Each country can appear once per import.
            </p>
          ) : null}

          {replacements.length ? (
            <label className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <input
                type="checkbox"
                checked={confirmReplace}
                onChange={(event) => setConfirmReplace(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#0D1282]"
              />
              <span>
                <span className="font-semibold">
                  I understand {replacements.length} destination{replacements.length === 1 ? "" : "s"} will have
                  {" "}{replacements.length === 1 ? "its" : "their"} current rates replaced.
                </span>
                <span className="mt-0.5 block text-xs leading-5">
                  Their existing weight slabs on {cardName} are deleted and rewritten from this file.
                  Destinations not in the file are left alone.
                </span>
              </span>
            </label>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setPreview(null);
                setRows([]);
                setError("");
              }}
              className="h-10 rounded-4xl border border-slate-300 px-5 text-sm font-semibold text-slate-700 hover:border-slate-500"
            >
              Choose another file
            </button>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={busy || blocked}
              className="h-10 rounded-4xl bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0a0e66] disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {busy ? "Importing..." : `Import ${rows.length} destination${rows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="text-xs font-semibold uppercase text-slate-500">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
  );
}

function ChooseStep({
  services,
  setServices,
  busy,
  onFile
}: {
  services: CountryRateService[];
  setServices: (services: CountryRateService[]) => void;
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-slate-600">
        Upload a rate list with a <span className="font-semibold text-slate-900">Weight</span> column and one column per
        zone, each headed by the countries it prices. Nothing is written until you have reviewed the matches.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">

        <Field label="Service">
          <div className="flex flex-wrap gap-2">
            {countryRateServices.map((service) => {
              const selected = services.includes(service);
              return (
                <button
                  key={service}
                  type="button"
                  onClick={() =>
                    setServices(
                      selected ? services.filter((entry) => entry !== service) : [...services, service]
                    )
                  }
                  className={`inline-flex h-10 items-center rounded-full border px-4 text-xs font-semibold transition ${
                    selected
                      ? "border-[#0D1282] bg-[#0D1282]/10 text-[#0D1282]"
                      : "border-slate-300 text-slate-600 hover:border-slate-400"
                  }`}
                >
                  {formatCountryRateService(service)}
                </button>
              );
            })}
          </div>
        </Field>
      </div>

      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition ${
          dragging ? "border-[#0D1282] bg-[#0D1282]/5" : "border-slate-300 bg-slate-50/60 hover:border-slate-400"
        }`}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#0D1282] shadow-sm">
          <FiUploadCloud aria-hidden="true" className="h-6 w-6" />
        </span>
        <span className="text-sm font-semibold text-slate-900">
          {busy ? "Reading the file..." : "Drop the rate list here, or browse"}
        </span>
        <span className="text-xs text-slate-500">.xlsx, .xls or .csv, up to 5 MB</span>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
            event.target.value = "";
          }}
          className="hidden"
        />
      </label>
    </div>
  );
}

function ReviewTable({
  rows,
  existingCounts,
  duplicateCodes,
  weightCount,
  onCorrect
}: {
  rows: ReviewRow[];
  existingCounts: Map<string, number>;
  duplicateCodes: Set<string>;
  weightCount: number;
  onCorrect: (id: string, query: string) => void;
}) {
  return (
    <div className="max-h-96 overflow-y-auto rounded-2xl border border-slate-200">
      <table className="min-w-full text-left text-sm">
        <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">In the file</th>
            <th className="px-4 py-3">Destination</th>
            <th className="px-4 py-3">Effect</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const existing = row.countryCode ? existingCounts.get(row.countryCode) ?? 0 : 0;
            const duplicated = row.countryCode ? duplicateCodes.has(row.countryCode) : false;
            const slabCount = row.rates.filter((rate) => rate !== null).length;
            const needsAttention = !row.countryCode || duplicated;

            return (
              <tr
                key={row.id}
                className={`border-b border-slate-100 last:border-b-0 ${needsAttention ? "bg-amber-50/60" : ""}`}
              >
                <td className="px-4 py-3 align-top">
                  <p className="font-semibold text-slate-900">{row.part}</p>
                  {row.part !== row.raw ? (
                    <p className="mt-0.5 text-[11px] text-slate-500">from &ldquo;{row.raw}&rdquo;</p>
                  ) : null}
                </td>

                <td className="px-4 py-3 align-top">
                  {row.countryCode && row.confidence !== "fuzzy" && !duplicated ? (
                    <span className="flex items-center gap-2 font-semibold text-slate-900">
                      <CountryFlag code={row.countryCode} size={16} />
                      {row.countryName}
                      <span className="text-xs font-bold text-slate-500">{row.countryCode}</span>
                    </span>
                  ) : (
                    <div className="max-w-64">
                      <RateCardCountryPicker
                        label=""
                        value={row.query}
                        onChange={(value) => onCorrect(row.id, value)}
                        placeholder="Pick a country"
                        invalid={needsAttention}
                        inputClassName="h-9 rounded-lg"
                      />
                      {row.confidence === "fuzzy" ? (
                        <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                          <FiAlertTriangle aria-hidden="true" className="h-3 w-3" />
                          {confidenceLabels.fuzzy} from a misspelling. Check it.
                        </p>
                      ) : null}
                    </div>
                  )}
                </td>

                <td className="px-4 py-3 align-top text-xs">
                  {!row.countryCode ? (
                    <span className="font-semibold text-amber-700">Needs a country</span>
                  ) : duplicated ? (
                    <span className="font-semibold text-amber-700">Listed twice</span>
                  ) : existing ? (
                    <span className="font-semibold text-amber-700">
                      {existing} existing slab{existing === 1 ? "" : "s"} replaced by {slabCount}
                    </span>
                  ) : (
                    <span className="text-slate-600">
                      New destination · {slabCount} slab{slabCount === 1 ? "" : "s"}
                      {slabCount < weightCount ? ` (${weightCount - slabCount} blank)` : ""}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ImportResult({ result, onClose }: { result: RateCardImportResult; onClose: () => void }) {
  const replaced = result.summary.filter((entry) => entry.removed > 0);
  const countries = new Set(result.summary.map((entry) => entry.countryCode));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-emerald-900">
        <FiCheckCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-semibold">
            {countries.size} destination{countries.size === 1 ? "" : "s"} written to {(result.businessAccountId ? "this business account" : formatRateCardBand(result.band ?? "BAND_D"))}.
          </p>
          <p className="mt-1 text-sm">
            {result.slabsWritten} weight slab{result.slabsWritten === 1 ? "" : "s"} added
            {result.slabsRemoved ? `, ${result.slabsRemoved} replaced` : ""} across
            {" "}{result.services.map(formatCountryRateService).join(" and ")}.
          </p>
        </div>
      </div>

      {replaced.length ? (
        <div className="rounded-2xl border border-slate-200 px-4 py-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Rates replaced</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-700">
            {replaced.map((entry) => (
              <li key={`${entry.countryCode}:${entry.service}`} className="flex items-center gap-2">
                <CountryFlag code={entry.countryCode} size={14} />
                <span className="font-semibold text-slate-900">{entry.countryName}</span>
                <span className="text-xs text-slate-500">
                  {formatCountryRateService(entry.service)} · {entry.removed} removed, {entry.added} added
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-semibold">Two things this import did not do.</p>
        <ul className="mt-1.5 list-disc pl-5 text-xs leading-5">
          <li>
            Route charges - fuel surcharge, remote area, handling - were not imported. A rate list states them as prose,
            in a different form every time, so they stay a deliberate entry under Route Charges.
          </li>
          <li>
            New destinations are not bookable until a Swiftline route exists for them. Serviceability will report
            &ldquo;No route is configured&rdquo; until one is added.
          </li>
        </ul>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="h-10 rounded-4xl bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0a0e66]"
        >
          Done
        </button>
      </div>
    </div>
  );
}
