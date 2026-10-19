"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { toast } from "react-toastify";
import { FiChevronRight, FiDownload, FiSearch, FiShare2, FiTrash2, FiUploadCloud, FiPlus } from "react-icons/fi";
import { MdOutlineKeyboardDoubleArrowRight } from "react-icons/md";

import { DashboardLoading } from "@/components/DashboardShell";
import { BiSolidEdit } from "react-icons/bi";
import ShareRateCardDialog from "@/components/rate-cards/ShareRateCardDialog";
import RateCardImportDialog from "@/components/rate-cards/RateCardImportDialog";
import RateCardCountryPicker from "@/components/rate-cards/RateCardCountryPicker";
import CountryFlag from "@/components/CountryFlag";
import RouteChargesForm from "@/components/rate-cards/RouteChargesForm";
import RateCardSelect from "@/components/rate-cards/RateCardSelect";
import { requestLeave, useUnsavedChanges } from "@/lib/useUnsavedChanges";
import { countryName } from "@/lib/countries";
import { resolveCountry } from "@/lib/countryLookup";
import {
  buildCountryRateCardCsv,
  CountryRateCard,
  CountryRateCardInput,
  CountryRouteCharge,
  CountryRateService,
  RateCardTarget,
  rateCardDisplay,
  RateCardGstTreatment,
  countryRateServices,
  deleteCountryRateCard,
  formatCountryRateService,
  listCountryRateCards,
  listCountryRouteCharges,
  saveCountryRateCard,
} from "@/lib/countryRateCards";
import { RATE_CARD_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

type FormState = {
  /** The text in the country field. The ISO code is derived from it. */
  countryQuery: string;
  service: CountryRateService;
  fromKg: string;
  toKg: string;
  chargesPerKg: string;
  maxBoxKg: string;
  gstTreatment: RateCardGstTreatment;
  gstRatePercent: string;
  gstApplyToAllRates: boolean;
};

// The country field starts empty. It used to default to the United Kingdom,
// which made the quickest way to use the form also the quickest way to save a
// UK rate by accident.
const defaultForm: FormState = {
  countryQuery: "",
  service: "COURIER",
  fromKg: "",
  toKg: "",
  chargesPerKg: "",
  maxBoxKg: "",
  gstTreatment: "EXCLUDED",
  gstRatePercent: "",
  gstApplyToAllRates: false,
};

/** One country and service, with its weight slabs. How the table is grouped. */
type RateGroup = {
  key: string;
  countryCode: string;
  countryName: string;
  service: CountryRateService;
  rates: CountryRateCard[];
};

function toPayload(form: FormState, countryCode: string, target: RateCardTarget, expectedVersion: number): CountryRateCardInput {
  return {
    ...target,
    expectedVersion,
    countryCode,
    countryName: countryName(countryCode),
    service: form.service,
    fromKg: Number(form.fromKg),
    toKg: Number(form.toKg),
    chargesPerKg: Number(form.chargesPerKg),
    maxBoxKg: Number(form.maxBoxKg),
    gstTreatment: form.gstTreatment,
    gstRatePercent: form.gstTreatment === "INCLUDED" ? Number(form.gstRatePercent || 0) : 0,
    gstApplyToAllRates: form.gstApplyToAllRates,
  };
}

export default function RateCardWorkspace({ businessAccountId, cardName, accountSelector }: { businessAccountId?: string; cardName: string; accountSelector?: ReactNode }) {
  const target = useMemo<RateCardTarget>(() => businessAccountId ? { businessAccountId } : { band: "BAND_D" }, [businessAccountId]);
  const { user, loading } = useAdminUser(RATE_CARD_AREA);
  const [rates, setRates] = useState<CountryRateCard[]>([]);
  const [routeCharges, setRouteCharges] = useState<CountryRouteCharge[]>([]);
  const [version, setVersion] = useState(0);
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [section, setSection] = useState<"rates" | "charges">("rates");
  const [showForm, setShowForm] = useState(false);
  const [chargeCountryQuery, setChargeCountryQuery] = useState("");
  const [chargeCountryCode, setChargeCountryCode] = useState("");
  const [chargeService, setChargeService] = useState<CountryRateService>("COURIER");
  const [chargeResetKey, setChargeResetKey] = useState(0);
  const [baseline, setBaseline] = useState<FormState>(defaultForm);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [editingRateId, setEditingRateId] = useState("");
  const [countryError, setCountryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [sharing, setSharing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [serviceFilter, setServiceFilter] = useState<CountryRateService | "">("");
  // Only the groups the operator has opened or closed by hand; everything else
  // follows the default for the current list length.
  const [overriddenGroups, setOverriddenGroups] = useState<Record<string, boolean>>({});

  // Derived rather than stored beside the text: holding the code and the text
  // as two pieces of state is what makes this kind of field drift, where the
  // box says one country and the rate is saved against another.
  const selectedCountry = useMemo(
    () => resolveCountry(form.countryQuery),
    [form.countryQuery],
  );
  const countryCode = selectedCountry?.iso2.toUpperCase() ?? "";

  const resolvedChargeCountryCode = resolveCountry(chargeCountryQuery)?.iso2.toUpperCase() ?? "";
  useUnsavedChanges(showForm && JSON.stringify(form) !== JSON.stringify(baseline), { label: `${cardName} rate card` });

  const visibleRates = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return rates.filter((rate) => {
      if (serviceFilter && rate.service !== serviceFilter) return false;
      if (!needle) return true;
      return rate.countryName.toLowerCase().includes(needle)
        || rate.countryCode.toLowerCase().includes(needle);
    });
  }, [rates, search, serviceFilter]);

  // Grouped by destination and service: a full rate list runs to nine hundred
  // slabs on one band, and a flat table of that length cannot be read.
  const groups = useMemo(() => {
    const byKey = new Map<string, RateGroup>();

    for (const rate of visibleRates) {
      const key = `${rate.countryCode}:${rate.service}`;
      const group = byKey.get(key);
      if (group) {
        group.rates.push(rate);
        continue;
      }

      byKey.set(key, {
        key,
        countryCode: rate.countryCode,
        countryName: rate.countryName,
        service: rate.service,
        rates: [rate],
      });
    }

    return [...byKey.values()]
      .map((group) => ({
        ...group,
        rates: [...group.rates].sort((a, b) => a.fromKg - b.fromKg),
      }))
      .sort((a, b) => a.countryName.localeCompare(b.countryName) || a.service.localeCompare(b.service));
  }, [visibleRates]);

  // A short list is easier to read open; a long one is unusable open. A search
  // that narrows to a handful therefore opens them without a second click.
  //
  // Only groups the operator has actually clicked are remembered, and they are
  // remembered as a state rather than as membership of a list. Storing "these
  // are open" instead would invert every one of them the moment a search
  // changed what the default is.
  const expandedByDefault = groups.length <= 8;
  function isExpanded(key: string) {
    return overriddenGroups[key] ?? expandedByDefault;
  }

  function toggleGroup(key: string) {
    setOverriddenGroups((current) => ({
      ...current,
      [key]: !(current[key] ?? expandedByDefault),
    }));
  }

  const gstPreview = form.chargesPerKg && form.gstTreatment === "INCLUDED" && form.gstRatePercent
    ? rateCardDisplay({
      chargesPerKg: Number(form.chargesPerKg),
      gstTreatment: form.gstTreatment,
      gstRatePercent: Number(form.gstRatePercent)
    })
    : null;

  useEffect(() => {
    if (!user) return;

    let active = true;
    async function loadRates() {
      setDataLoading(true);
      setError("");

      try {
        const [rateResult, routeChargeResult] = await Promise.all([
          listCountryRateCards(target),
          listCountryRouteCharges(target)
        ]);
        if (!active) return;
        setRates(rateResult.rates);
        setVersion(rateResult.version ?? 0);
        setMigrationRequired(Boolean(rateResult.migrationRequired));
        setRouteCharges(routeChargeResult.routeCharges);
      } catch (caughtError) {
        if (!active) return;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load country rate cards.",
        );
      } finally {
        if (active) setDataLoading(false);
      }
    }

    void loadRates();
    return () => { active = false; };
  }, [user, target]);

  // Debounced so a long rate card is not regrouped on every keystroke, matching
  // the shipments list.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function updateField<K extends keyof FormState>(
    field: K,
    value: FormState[K],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setMessage("");
  }

  function handleInput(field: keyof FormState) {
    return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      updateField(field, event.target.value as FormState[keyof FormState]);
    };
  }

  function resetForm() {
    setForm(defaultForm);
    setBaseline(defaultForm);
    setShowForm(false);
    setEditingRateId("");
    setCountryError("");
    setMessage("");
  }

  function editRate(rate: CountryRateCard) {
    setEditingRateId(rate._id);
    const nextForm: FormState = {
      countryQuery: countryName(rate.countryCode),
      service: rate.service,
      fromKg: String(rate.fromKg),
      toKg: String(rate.toKg),
      chargesPerKg: String(rate.chargesPerKg),
      maxBoxKg: String(rate.maxBoxKg),
      gstTreatment: rate.gstTreatment ?? "EXCLUDED",
      gstRatePercent: String(rate.gstRatePercent ?? 0),
      gstApplyToAllRates: rate.gstApplyToAllRates ?? false,
    };
    setForm(nextForm);
    setBaseline(nextForm);
    setShowForm(true);
    setCountryError("");
    setMessage("");
  }

  async function selectChargeCountry(value: string, service = chargeService) {
    const nextCode = resolveCountry(value)?.iso2.toUpperCase() ?? "";
    if (nextCode === chargeCountryCode && service === chargeService) {
      setChargeCountryQuery(value);
      return;
    }
    if (!await requestLeave()) {
      setChargeCountryQuery(chargeCountryCode ? countryName(chargeCountryCode) : "");
      return;
    }
    setChargeCountryQuery(value);
    setChargeCountryCode(nextCode);
    setChargeService(service);
    setChargeResetKey((current) => current + 1);
  }

  function handleChargeCountryInput(value: string) {
    const resolved = resolveCountry(value)?.iso2.toUpperCase() ?? "";
    if (resolved && resolved !== chargeCountryCode) {
      void selectChargeCountry(value);
      return;
    }
    if (!value.trim() && chargeCountryCode) {
      void selectChargeCountry("");
      return;
    }
    setChargeCountryQuery(value);
  }

  async function openRateCardDialog(dialog: "share" | "import") {
    if (!await requestLeave()) return;
    resetForm();
    setChargeResetKey((current) => current + 1);
    if (dialog === "share") setSharing(true);
    else setImporting(true);
  }

  async function switchSection(next: "rates" | "charges") {
    if (next === section || busy || !await requestLeave()) return;
    resetForm();
    setSection(next);
  }

  async function startNewRate() {
    if (!await requestLeave()) return;
    resetForm();
    setShowForm(true);
  }

  async function refreshRates() {
    const [rateResult, { routeCharges: nextRouteCharges }] = await Promise.all([
      listCountryRateCards(target),
      listCountryRouteCharges(target)
    ]);
    setRates(rateResult.rates);
    setVersion(rateResult.version ?? 0);
    setMigrationRequired(Boolean(rateResult.migrationRequired));
    setRouteCharges(nextRouteCharges);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // A rate is keyed by ISO-3166 alpha-2, so there is nothing to submit until
    // the typed text resolves to a country.
    if (!countryCode) {
      setCountryError(
        form.countryQuery.trim()
          ? `We could not match "${form.countryQuery.trim()}" to a country. Pick one from the list.`
          : "Pick a country from the list.",
      );
      return;
    }

    setBusy(true);
    setCountryError("");
    setError("");
    setMessage("");

    try {
      await saveCountryRateCard(toPayload(form, countryCode, target, version), editingRateId || undefined);
      await refreshRates();
      resetForm();
      toast.success(editingRateId ? "Rate card updated." : "Rate card added.");
    } catch (caughtError) {
      toast.error(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to save rate card.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeRate(rateId: string) {
    if (!window.confirm("Remove this rate? This card will lose coverage for this weight range.")) return;

    setBusy(true);
    setError("");
    setMessage("");

    try {
      await deleteCountryRateCard(rateId, version);
      await refreshRates();
      if (editingRateId === rateId) resetForm();
      setMessage("Rate card removed.");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to remove rate card.",
      );
    } finally {
      setBusy(false);
    }
  }

  function exportRates() {
    const csv = buildCountryRateCardCsv(visibleRates, cardName);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `swiftline-${(businessAccountId || "individual-clients")}-rate-card.csv`;
    anchor.click();
    window.URL.revokeObjectURL(url);
  }

  if (loading || !user) return <DashboardLoading />;

  return (
    <>
      <section aria-label={`${cardName} rate card`} className="mb-6">
        <div className={`grid gap-4 ${accountSelector ? "lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end" : ""}`}>
          {accountSelector ? <div className="min-w-0 max-w-xl">{accountSelector}</div> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={() => void openRateCardDialog("import")} disabled={migrationRequired || dataLoading || busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"><FiUploadCloud aria-hidden="true" />Import Excel</button>
            <button type="button" onClick={exportRates} disabled={!rates.length || dataLoading} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"><FiDownload aria-hidden="true" />Export CSV</button>
            <button type="button" onClick={() => void openRateCardDialog("share")} disabled={!rates.length || migrationRequired || dataLoading || busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"><FiShare2 aria-hidden="true" />Share</button>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-3 border-b border-slate-200 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-5" role="tablist" aria-label="Rate card sections">
            {(["rates", "charges"] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={section === key} aria-controls={`card-${businessAccountId || "individual"}-${key}`} onClick={() => void switchSection(key)} disabled={busy} className={`border-b-2 px-1 pb-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0D1282] ${section === key ? "border-[#0D1282] text-[#0D1282]" : "border-transparent text-slate-600 hover:text-slate-900"}`}>{key === "rates" ? "Rates" : "Route Charges"}</button>)}
          </div>
          {section === "rates" && !showForm ? <button type="button" disabled={migrationRequired || dataLoading || busy} onClick={() => void startNewRate()} className="mb-2 ml-auto inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0a0e66] disabled:opacity-50"><FiPlus aria-hidden="true" />Add rate</button> : null}
        </div>
        {migrationRequired ? <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Your existing rates are available to view. Editing will be enabled after this business account&apos;s private card has been migrated.</p> : null}
      </section>

      {sharing ? (
        <ShareRateCardDialog rates={rates} target={target} cardName={cardName} version={version} onClose={() => setSharing(false)} />
      ) : null}

      {importing ? (
        <RateCardImportDialog
          target={target}
          cardName={cardName}
          version={version}
          existingRates={rates}
          onClose={() => setImporting(false)}
          onImported={() => void refreshRates()}
        />
      ) : null}

      {error ? (
        <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mb-4 border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          {message}
        </div>
      ) : null}



      {section === "rates" && showForm ? <form
        onSubmit={handleSubmit}
        className="mb-6 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"
      >
        <div className="mb-5">
          <h3 className="text-base font-semibold text-slate-900">{editingRateId ? "Edit rate" : "Add rate"}</h3>
          <p className="mt-1 text-sm text-slate-600">
            {editingRateId ? "Update this country, service, and weight slab." : "Add a country, service, and weight slab."} Enter the final commercial rate per kilogram.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <RateCardCountryPicker
            value={form.countryQuery}
            onChange={(value) => {
              updateField("countryQuery", value);
              setCountryError("");
            }}
            invalid={Boolean(countryError)}
          />

          <label>
            <span className="text-xs font-semibold uppercase text-slate-500">
              Service
            </span>

            <div className="relative mt-2">
              <RateCardSelect
                value={form.service}
                onChange={handleInput("service")}
                className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm font-semibold text-slate-900 outline-none focus:border-blue-900"
              >
                {countryRateServices.map((service) => (
                  <option key={service} value={service}>
                    {formatCountryRateService(service)}
                  </option>
                ))}
              </RateCardSelect>
            </div>
          </label>

          <RateInput
            label="From KG"
            value={form.fromKg}
            onChange={handleInput("fromKg")}
          />

          <RateInput
            label="To KG"
            value={form.toKg}
            onChange={handleInput("toKg")}
          />

          <RateInput
            label="Charges / KG"
            value={form.chargesPerKg}
            onChange={handleInput("chargesPerKg")}
          />

          <RateInput
            label="Max Box KG"
            value={form.maxBoxKg}
            onChange={handleInput("maxBoxKg")}
          />

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">GST</span>
            <RateCardSelect
              value={form.gstTreatment}
              onChange={handleInput("gstTreatment")}
              className="mt-2 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-900"
            >
              <option value="EXCLUDED">GST excluded</option>
              <option value="INCLUDED">GST included</option>
            </RateCardSelect>
          </label>

          {form.gstTreatment === "INCLUDED" ? (
            <RateInput
              label="GST %"
              value={form.gstRatePercent}
              onChange={handleInput("gstRatePercent")}
            />
          ) : null}

        </div>

        <div className="mt-5 flex flex-col gap-4 border-t border-slate-100 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 space-y-2">
            <label className="flex max-w-2xl items-start gap-2.5 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={form.gstApplyToAllRates}
                onChange={(event) => updateField("gstApplyToAllRates", event.target.checked)}
                disabled={!countryCode}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-900 focus:ring-blue-900"
              />
              <span>
                <span className="block font-semibold">Use this GST for all {countryCode ? countryName(countryCode) : "country"} rates</span>
                <span className="mt-0.5 block text-xs leading-5 text-slate-600">Applies the same GST treatment and percentage to every slab for this country in this rate card.</span>
              </span>
            </label>
            {gstPreview ? (
              <p className="text-xs leading-5 text-slate-600">
                Rate-card display preview: <span className="font-semibold text-slate-900">{gstPreview.amount} {gstPreview.label}</span>. The entered amount stays unchanged; GST is not added on top.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => void requestLeave().then((canLeave) => { if (canLeave) resetForm(); })}
              className="h-10 min-w-[9rem] rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="h-10 min-w-[9rem] rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0a0e66] disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {busy ? "Saving…" : editingRateId ? "Update rate" : "Add rate"}
            </button>
          </div>
        </div>

        {countryError ? (
          <p className="mt-3 text-xs font-semibold text-red-600">{countryError}</p>
        ) : null}
      </form> : null}

      {/* Keyed to the country selected above; service targeting is handled inside
          the route-charge section so it can update Courier and Cargo together. */}
      {section === "charges" ? <div id={`card-${businessAccountId || "individual"}-charges`} role="tabpanel">
        <RouteChargesForm
          key={chargeResetKey}
          target={target}
          countryCode={resolvedChargeCountryCode === chargeCountryCode ? chargeCountryCode : ""}
          countryName={resolvedChargeCountryCode === chargeCountryCode && chargeCountryCode ? countryName(chargeCountryCode) : ""}
          initialService={chargeService}
          countryPicker={<RateCardCountryPicker value={chargeCountryQuery} onChange={handleChargeCountryInput} />}
          disabled={migrationRequired}
          onSaved={() => void refreshRates()}
        />
        {routeCharges.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-3">Country</th>
                  <th className="px-4 py-3">Service</th>
                  <th className="px-4 py-3">Configured charges</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {routeCharges.map((charge) => (
                  <tr key={charge._id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-medium">{countryName(charge.countryCode)}</td>
                    <td className="px-4 py-3">{formatCountryRateService(charge.service)}</td>
                    <td className="px-4 py-3 text-slate-600">{formatRouteChargeSummary(charge)}</td>
                    <td className="px-4 py-3">
                      <button type="button" disabled={migrationRequired} onClick={() => void selectChargeCountry(countryName(charge.countryCode), charge.service)} className="font-semibold text-[#0D1282] hover:underline disabled:opacity-50">Edit charges</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div> : null}
      <div hidden={section !== "rates"} id={`card-${businessAccountId || "individual"}-rates`} role="tabpanel">

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 basis-full sm:flex-1 sm:basis-auto sm:max-w-sm">
          <FiSearch
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search a country or code"
            aria-label="Search rate card countries"
            className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-900"
          />
        </div>

        <RateCardSelect
          value={serviceFilter}
          onChange={(event) => setServiceFilter(event.target.value as CountryRateService | "")}
          aria-label="Filter by service"
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-900"
        >
          <option value="">All services</option>
          {countryRateServices.map((service) => (
            <option key={service} value={service}>{formatCountryRateService(service)}</option>
          ))}
        </RateCardSelect>

        <p className="text-xs font-semibold text-slate-500">
          {visibleRates.length === rates.length
            ? `${rates.length} slab${rates.length === 1 ? "" : "s"}`
            : `${visibleRates.length} of ${rates.length} slabs`}
          {groups.length ? ` · ${groups.length} destination${groups.length === 1 ? "" : "s"}` : ""}
        </p>
      </div>

      <div className="overflow-x-auto border border-slate-200 bg-white rounded-2xl ">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Country</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3">Weight (KG)</th>
              <th className="px-4 py-3">Charges / KG</th>
              <th className="px-4 py-3">Max Box KG</th>
              <th className="px-4 py-3">Route Charges</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {dataLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  Loading rate cards...
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  {rates.length ? "No rates match this search." : "No rates yet. Add a rate or import an Excel file to configure this card."}
                </td>
              </tr>
            ) : (
              groups.map((group) => {
                const open = isExpanded(group.key);
                const routeCharge = routeCharges.find((charge) =>
                  charge.countryCode === group.countryCode
                  && charge.service === group.service
                );
                const cheapest = Math.min(...group.rates.map((rate) => rateCardDisplay(rate).amount));
                const dearest = Math.max(...group.rates.map((rate) => rateCardDisplay(rate).amount));

                return (
                  <GroupRows
                    key={group.key}
                    group={group}
                    open={open}
                    onToggle={() => toggleGroup(group.key)}
                    routeChargeSummary={formatRouteChargeSummary(routeCharge)}
                    cheapest={cheapest}
                    dearest={dearest}
                    busy={busy || migrationRequired}
                    onEdit={(rate) => { void requestLeave().then((canLeave) => { if (canLeave) editRate(rate); }); }}
                    onRemove={(rateId) => void removeRate(rateId)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
      </div>
    </>
  );
}

function GroupRows({
  group,
  open,
  onToggle,
  routeChargeSummary,
  cheapest,
  dearest,
  busy,
  onEdit,
  onRemove,
}: {
  group: RateGroup;
  open: boolean;
  onToggle: () => void;
  routeChargeSummary: string;
  cheapest: number;
  dearest: number;
  busy: boolean;
  onEdit: (rate: CountryRateCard) => void;
  onRemove: (rateId: string) => void;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 bg-slate-50/70">
        <td colSpan={7} className="p-0">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <FiChevronRight
              aria-hidden="true"
              className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
            />
            <CountryFlag code={group.countryCode} size={20} />
            <span className="font-semibold text-slate-950">{group.countryName}</span>
            <span className="rounded-full border border-slate-300 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">
              {formatCountryRateService(group.service)}
            </span>
            <span className="text-xs text-slate-500">
              {group.rates.length} slab{group.rates.length === 1 ? "" : "s"}
              {" · "}
              {dearest === cheapest ? `${cheapest} / kg` : `${dearest} to ${cheapest} / kg`}
            </span>
            <span className="ml-auto hidden max-w-80 truncate text-xs text-slate-500 sm:block">
              {routeChargeSummary === "-" ? "No route charges" : routeChargeSummary}
            </span>
          </button>
        </td>
      </tr>

      {open
        ? group.rates.map((rate) => (
            <tr key={rate._id} className="border-b border-slate-100">
              <td className="px-4 py-3 pl-11 text-slate-500">{rate.countryCode}</td>
              <td className="px-4 py-3">{formatCountryRateService(rate.service)}</td>
              <td className="px-4 py-3">
                {rate.fromKg}
                <span>
                  <MdOutlineKeyboardDoubleArrowRight className="mx-1 mb-1 inline h-4 w-4 text-green-800" />
                </span>
                {rate.toKg}
              </td>
              <td className="px-4 py-3 font-semibold">
                <span>{rateCardDisplay(rate).amount}</span>
                <span className="ml-2 text-[11px] font-medium text-slate-500">{rateCardDisplay(rate).label}</span>
              </td>
              <td className="px-4 py-3">{rate.maxBoxKg}</td>
              <td className="px-4 py-3 max-w-5 text-xs text-slate-600">{routeChargeSummary}</td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onEdit(rate)}
                    className="inline-flex items-center gap-1 font-semibold text-blue-900 hover:text-blue-700"
                  >
                    <BiSolidEdit aria-hidden="true" className="h-4 w-4" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(rate._id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 font-semibold text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    <FiTrash2 aria-hidden="true" className="h-4 w-4" />
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))
        : null}
    </>
  );
}

function formatRouteChargeSummary(routeCharge: CountryRouteCharge | undefined) {
  if (!routeCharge) return "-";

  const details: string[] = [];
  if (routeCharge.fuelSurchargePercent > 0) details.push(`Fuel ${routeCharge.fuelSurchargePercent}%`);
  if (routeCharge.remoteAreaCharge > 0) {
    const postcodes = routeCharge.remoteAreaPostcodes.length
      ? ` (${routeCharge.remoteAreaPostcodes.join(", ")})`
      : "";
    details.push(`Remote ₹${routeCharge.remoteAreaCharge.toFixed(2)}${postcodes}`);
  } else if (routeCharge.remoteAreaPostcodes.length) {
    details.push(`Remote areas (${routeCharge.remoteAreaPostcodes.join(", ")})`);
  }
  if (routeCharge.handlingCharge > 0) details.push(`Handling ₹${routeCharge.handlingCharge.toFixed(2)}`);
  // Insurance is omitted while cover is switched off portal-wide. A stored
  // percentage is kept on the route but is never priced, so summarising it here
  // would describe a charge no shipment can incur.
  if (routeCharge.discountPercent > 0) details.push(`Discount ${routeCharge.discountPercent}%`);

  return details.length ? details.join(" · ") : "-";
}

function RateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label>
      <span className="text-xs font-semibold uppercase text-slate-500">
        {label}
      </span>
      <input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={onChange}
        required
        className="mt-2 h-10 w-full border rounded-lg border-slate-300 px-3 text-sm font-semibold text-slate-900 outline-none focus:border-blue-900"
      />
    </label>
  );
}
