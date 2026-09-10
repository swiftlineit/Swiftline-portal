import Link from "next/link";
import type {
  PublicBooking,
  PublicQuote,
  PublicShipmentFormData,
} from "@/lib/publicShipmentBooking";
import { formatRupees } from "@/lib/publicShipmentBooking";

function publicQuoteLineLabel(line: PublicQuote["lines"][number]) {
  if (line.code === "FREIGHT") return "Freight cost";
  if (line.code === "GST") {
    const rate = line.label.match(/\d+(?:\.\d+)?%/)?.[0];
    return rate ? `GST (${rate})` : "GST";
  }
  return line.label;
}

function AddressSummary({
  title,
  address,
}: {
  title: string;
  address:
    | PublicShipmentFormData["sender"]
    | PublicShipmentFormData["consignee"];
}) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
        {title}
      </p>
      <p className="mt-2 font-bold text-slate-950">
        {address.companyName || address.contactName}
      </p>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        {[
          address.addressLine1,
          address.addressLine2,
          address.townOrCity,
          address.county,
          address.postcode,
          address.countryName,
        ]
          .filter(Boolean)
          .join(", ")}
      </p>
      <p className="mt-1 text-sm text-slate-600">
        {address.email} · {address.mobileCountryCode} {address.mobileNumber}
      </p>
    </div>
  );
}

export default function ReviewPaymentStep({
  data,
  booking,
  quote,
  consent,
  onConsent,
  onQuote,
  onPay,
  busy,
  error,
}: {
  data: PublicShipmentFormData;
  booking: PublicBooking | null;
  quote: PublicQuote | null;
  consent: { terms: boolean; cancellation: boolean; prohibited: boolean };
  onConsent: (key: keyof typeof consent, value: boolean) => void;
  onQuote: () => void;
  onPay: () => void;
  busy: boolean;
  error: string;
}) {
  const allAccepted =
    consent.terms && consent.cancellation && consent.prohibited;
  const actual = data.parcels.reduce((sum, parcel) => sum + parcel.weightKg, 0);
  const divisor = data.serviceType === "CARGO" ? 6000 : 5000;
  const volumetric = data.parcels.reduce(
    (sum, parcel) =>
      sum + (parcel.lengthCm * parcel.widthCm * parcel.heightCm) / divisor,
    0,
  );
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <AddressSummary title="From" address={data.sender} />
            <AddressSummary title="To" address={data.consignee} />
          </div>
          <div className="mt-6 border-t border-slate-200 pt-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
              Shipment
            </p>
            <div className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <span className="text-slate-500">Service</span>
                <p className="mt-1 font-bold text-slate-900">
                  {data.serviceType === "CARGO" ? "Cargo" : "Courier"}
                </p>
              </div>
              <div>
                <span className="text-slate-500">Customs</span>
                <p className="mt-1 font-bold text-slate-900">
                  {data.csbType === "CSB_V" ? "CSB-V" : "CSB-IV"}
                </p>
              </div>
              <div>
                <span className="text-slate-500">Parcels</span>
                <p className="mt-1 font-bold text-slate-900">
                  {data.parcels.length}
                </p>
              </div>
              <div>
                <span className="text-slate-500">Weight</span>
                <p className="mt-1 font-bold text-slate-900">
                  {actual.toFixed(2)} kg
                </p>
              </div>
            </div>
          </div>
          <div className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
            <span className="font-semibold">Aadhaar:</span> XXXX XXXX{" "}
            {data.sender.aadhaarNumber.slice(-4)}{" "}
            <span className="mx-2 text-slate-300">·</span>{" "}
            <span className="font-semibold">Volumetric:</span>{" "}
            {volumetric.toFixed(2)} kg
          </div>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-bold text-slate-950">
            Confirm before pricing
          </h2>
          <div className="mt-4 space-y-3">
            <label className="flex items-start gap-3 text-sm leading-6 text-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[#0D1282]"
                checked={consent.terms}
                onChange={(event) => onConsent("terms", event.target.checked)}
              />
              <span>
                I accept the{" "}
                <Link
                  href="/terms-and-conditions"
                  target="_blank"
                  className="font-semibold text-[#0D1282] underline"
                >
                  online booking terms
                </Link>{" "}
                and confirm the shipment details are accurate.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm leading-6 text-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[#0D1282]"
                checked={consent.cancellation}
                onChange={(event) =>
                  onConsent("cancellation", event.target.checked)
                }
              />
              <span>
                I have read the{" "}
                <Link
                  href="/cancellation-and-refund-policy"
                  target="_blank"
                  className="font-semibold text-[#0D1282] underline"
                >
                  cancellation and refund policy
                </Link>
                . Public users cannot amend or cancel online.
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm leading-6 text-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[#0D1282]"
                checked={consent.prohibited}
                onChange={(event) =>
                  onConsent("prohibited", event.target.checked)
                }
              />
              <span>
                I confirm the shipment contains no{" "}
                <Link
                  href="/prohibited-and-restricted-goods"
                  target="_blank"
                  className="font-semibold text-[#0D1282] underline"
                >
                  prohibited or restricted goods
                </Link>
                .
              </span>
            </label>
          </div>
        </section>
      </div>
      <aside className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#0D1282]">
          Final quote
        </p>
        {quote ? (
          <>
            <p className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              {formatRupees(quote.amountMinor)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              GST and configured route charges included. Valid until{" "}
              {new Date(quote.expiresAt).toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
              .
            </p>
            <dl className="mt-5 space-y-3 border-t border-slate-200 pt-4">
              {quote.lines.map((line) => (
                <div
                  key={line.code}
                  className="flex justify-between gap-4 text-sm"
                >
                  <dt className="text-slate-600">{publicQuoteLineLabel(line)}</dt>
                  <dd className="font-semibold text-slate-900">
                    {line.kind === "DEDUCTION" ? "−" : ""}
                    {formatRupees(line.amountMinor)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center text-xs">
              <div>
                <span className="text-slate-500">Actual</span>
                <p className="mt-1 font-bold">
                  {quote.totalWeightKg.toFixed(2)} kg
                </p>
              </div>
              <div>
                <span className="text-slate-500">Volumetric</span>
                <p className="mt-1 font-bold">
                  {quote.totalVolumetricWeightKg.toFixed(2)} kg
                </p>
              </div>
              <div>
                <span className="text-slate-500">Chargeable</span>
                <p className="mt-1 font-bold">
                  {quote.totalChargeableWeightKg.toFixed(2)} kg
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onPay}
              disabled={busy}
              className="mt-5 h-12 w-full rounded-lg bg-[#0D1282] px-4 text-sm font-bold text-white shadow-sm transition hover:bg-[#080d64] disabled:opacity-50"
            >
              {busy
                ? "Securing payment…"
                : `Pay ${formatRupees(quote.amountMinor)}`}
            </button>
            <p className="mt-3 text-center text-xs leading-5 text-slate-500">
              Secure payment by Razorpay. Do not refresh after completing
              payment.
            </p>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Accept the policies to calculate the exact server-approved price.
              Your quote remains valid for 30 minutes.
            </p>
            <button
              type="button"
              onClick={onQuote}
              disabled={!allAccepted || busy}
              className="mt-5 h-11 w-full rounded-lg bg-[#0D1282] px-4 text-sm font-bold text-white transition hover:bg-[#080d64] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Calculating…" : "Calculate final quote"}
            </button>
          </>
        )}
        {booking ? (
          <p className="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-500">
            Booking reference{" "}
            <span className="font-semibold text-slate-700">
              {booking.reference}
            </span>
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
      </aside>
    </div>
  );
}
