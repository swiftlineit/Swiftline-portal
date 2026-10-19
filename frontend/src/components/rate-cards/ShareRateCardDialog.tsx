"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { BsWhatsapp } from "react-icons/bs";
import { FiCheck, FiMail, FiSend, FiX } from "react-icons/fi";

import type { CountryRateCard, RateCardTarget } from "@/lib/countryRateCards";
import {
  createRateCardShare,
  type RateCardShareChannel,
  type RateCardShareResult,
} from "@/lib/rateCardShares";

type ShareChannel = Extract<RateCardShareChannel, "EMAIL" | "WHATSAPP">;

const DEFAULT_VALIDITY_DAYS = 90;
const inputClass =
  "mt-2 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15";

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateAfterDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateInputValue(date);
}

export default function ShareRateCardDialog({
  rates,
  target,
  cardName,
  version,
  onClose,
}: {
  rates: CountryRateCard[];
  target: RateCardTarget;
  cardName: string;
  version: number;
  onClose: () => void;
}) {
  const [validUntil, setValidUntil] = useState(() => dateAfterDays(DEFAULT_VALIDITY_DAYS));
  const [terms, setTerms] = useState("");
  const [channels, setChannels] = useState<ShareChannel[]>(["EMAIL"]);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RateCardShareResult | null>(null);
  const [whatsappOpened, setWhatsappOpened] = useState(false);

  const countryCount = new Set(rates.map((rate) => rate.countryCode)).size;
  const minimumValidityDate = dateAfterDays(1);

  function toggleChannel(channel: ShareChannel) {
    setChannels((current) =>
      current.includes(channel)
        ? current.filter((item) => item !== channel)
        : [...current, channel],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channels.length) return;

    // Open the user-initiated WhatsApp tab before awaiting the API, then send it
    // to the prepared message when the secure share link comes back.
    const whatsappWindow = channels.includes("WHATSAPP")
      ? window.open("about:blank", "_blank")
      : null;
    if (whatsappWindow) whatsappWindow.opener = null;

    setBusy(true);
    setError("");

    try {
      const today = dateInputValue(new Date());
      const response = await createRateCardShare({
        ...target,
        expectedVersion: version,
        title: `${cardName.trim() || "Swiftline"} - Rate Card`.slice(0, 120),
        channels,
        // Empty filters mean all rates in this card; no service, country, or
        // price adjustment is applied by the simplified share flow.
        selection: { countryCodes: [], services: [], rateIds: [] },
        adjustmentMode: "NONE",
        adjustmentValue: 0,
        terms: {
          validFrom: today,
          validUntil,
          fuelSurchargePercent: 0,
          gstPercent: 0,
          minChargeableWeightKg: 0,
          volumetricDivisor: 0,
          remarks: terms.trim(),
          customTerms: [],
        },
        recipientAccountIds: [],
        recipientEmails: channels.includes("EMAIL")
          ? [{ email: email.trim(), name: "" }]
          : [],
        recipientPhones: channels.includes("WHATSAPP")
          ? [{ phone: phone.trim(), name: "" }]
          : [],
      });

      const whatsappLink = response.whatsappLinks[0];
      if (whatsappWindow && whatsappLink) {
        whatsappWindow.location.replace(whatsappLink.url);
        setWhatsappOpened(true);
      } else {
        whatsappWindow?.close();
        setWhatsappOpened(false);
      }
      setResult(response);
    } catch (caught) {
      whatsappWindow?.close();
      setError(caught instanceof Error ? caught.message : "The rate card could not be shared.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell onClose={onClose} title={result ? "Rate card ready" : "Share rate card"}>
      {result ? (
        <ShareResult result={result} whatsappOpened={whatsappOpened} onClose={onClose} />
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <p className="text-sm leading-5 text-slate-600">
            Share all <span className="font-semibold text-slate-900">{rates.length} rate {rates.length === 1 ? "slab" : "slabs"}</span> across {countryCount} {countryCount === 1 ? "destination" : "destinations"} for{" "}
            <span className="font-semibold text-slate-900">{cardName}</span>, including configured route charges.
          </p>

          <div className="grid gap-4 min-[380px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <label className="block min-w-0">
              <span className="text-sm font-semibold text-slate-800">Valid until</span>
              <input
                type="date"
                value={validUntil}
                min={minimumValidityDate}
                onChange={(event) => setValidUntil(event.target.value)}
                required
                aria-label="Valid until"
                className={inputClass}
              />
              <span className="mt-1 block text-xs leading-4 text-slate-500">The share link expires on this date.</span>
            </label>

            <label className="block min-w-0">
              <span className="text-sm font-semibold text-slate-800">Terms (optional)</span>
              <textarea
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
                maxLength={1000}
                rows={2}
                aria-label="Terms"
                placeholder="Add any terms to include with the rate card"
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
              />
            </label>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-slate-800">Share by</legend>
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <ChannelOption
                label="Email"
                description="Full rate card by email"
                checked={channels.includes("EMAIL")}
                onChange={() => toggleChannel("EMAIL")}
                icon={<FiMail aria-hidden="true" className="h-4 w-4" />}
              />
              <ChannelOption
                label="WhatsApp"
                description="Prepared full-card link"
                checked={channels.includes("WHATSAPP")}
                onChange={() => toggleChannel("WHATSAPP")}
                icon={<BsWhatsapp aria-hidden="true" className="h-4 w-4" />}
              />
            </div>
            {!channels.length ? (
              <p className="mt-2 text-xs text-amber-700">Choose Email, WhatsApp, or both.</p>
            ) : null}
          </fieldset>

          <div className={`grid gap-4 ${channels.length === 2 ? "sm:grid-cols-2" : ""}`}>
            {channels.includes("EMAIL") ? (
              <label className="block min-w-0">
                <span className="text-sm font-semibold text-slate-800">Email address</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  maxLength={320}
                  required
                  aria-label="Email address"
                  placeholder="name@company.com"
                  className={inputClass}
                />
              </label>
            ) : null}

            {channels.includes("WHATSAPP") ? (
              <label className="block min-w-0">
                <span className="text-sm font-semibold text-slate-800">WhatsApp number</span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  autoComplete="tel"
                  maxLength={20}
                  pattern="[+]?[1-9][0-9]{7,14}"
                  title="Enter the number in international format, such as +919876543210."
                  required
                  aria-label="WhatsApp number"
                  placeholder="+919876543210"
                  className={inputClass}
                />
                <span className="mt-1 block text-xs leading-4 text-slate-500">Use international format, e.g. +919876543210.</span>
              </label>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !channels.length}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0a0e66] disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              <FiSend aria-hidden="true" />
              {busy ? "Sharing..." : "Share rate card"}
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}

function ChannelOption({
  label,
  description,
  checked,
  onChange,
  icon,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
  icon: ReactNode;
}) {
  return (
    <label className={`relative flex min-h-[76px] cursor-pointer items-start gap-2.5 rounded-xl border px-2.5 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-[#0D1282]/20 sm:gap-3 sm:px-3 ${
      checked ? "border-[#0D1282] bg-[#0D1282]/5" : "border-slate-200 hover:border-slate-300"
    }`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
      />
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
        checked ? "bg-[#0D1282]/10 text-[#0D1282]" : "bg-slate-100 text-slate-600"
      }`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-h-5 items-center justify-between gap-1.5">
          <span className="text-[13px] font-semibold leading-5 text-slate-900">{label}</span>
          <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
            checked ? "border-[#0D1282] bg-[#0D1282] text-white" : "border-slate-300 bg-white text-white"
          }`}>
            {checked ? <FiCheck aria-hidden="true" className="h-3 w-3" /> : null}
          </span>
        </span>
        <span className="mt-1 block text-[11px] leading-4 text-slate-600">{description}</span>
      </span>
    </label>
  );
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();

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
      className="fixed inset-0 z-70 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-3 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3 sm:px-6 sm:py-4">
          <h2 id={titleId} className="text-lg font-semibold text-slate-950">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <FiX aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <div className="px-4 py-4 sm:px-6 sm:py-5">{children}</div>
      </div>
    </div>
  );
}

function ShareResult({
  result,
  whatsappOpened,
  onClose,
}: {
  result: RateCardShareResult;
  whatsappOpened: boolean;
  onClose: () => void;
}) {
  const whatsappLink = result.whatsappLinks[0];

  return (
    <div className="space-y-4">
      <div role="status" className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <FiCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
        <div>
          <p className="text-sm font-semibold text-emerald-900">Rate card prepared</p>
          <p className="mt-1 text-sm text-emerald-800">{result.share.shareNumber} includes the complete rate card.</p>
        </div>
      </div>

      <div className="space-y-2 text-sm text-slate-700">
        {result.share.channels.includes("EMAIL") ? (
          <p>
            {result.emailsQueued
              ? `${result.emailsQueued} ${result.emailsQueued === 1 ? "email" : "emails"} queued.`
              : "No email was queued."}
          </p>
        ) : null}
        {result.share.channels.includes("WHATSAPP") ? (
          <p>
            {whatsappOpened
              ? "WhatsApp opened with the message ready. Review it and tap Send."
              : "Open the prepared WhatsApp message below and tap Send."}
          </p>
        ) : null}
      </div>

      {!whatsappOpened && whatsappLink ? (
        <a
          href={whatsappLink.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#25D366] px-4 text-sm font-semibold text-white transition hover:bg-[#1ea952]"
        >
          <BsWhatsapp aria-hidden="true" className="h-4 w-4" />
          Continue to WhatsApp
        </a>
      ) : null}

      <div className="flex justify-end border-t border-slate-200 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 items-center rounded-lg bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#0a0e66]"
        >
          Done
        </button>
      </div>
    </div>
  );
}
