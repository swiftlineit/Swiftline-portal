"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { loadPublicBooking, type PublicBooking } from "@/lib/publicShipmentBooking";
import BookingSuccess from "./BookingSuccess";

const stateMessages: Partial<Record<PublicBooking["state"], string>> = {
  PAYMENT_PENDING: "Checkout was started but payment is not yet confirmed. You can safely resume the same Razorpay order.",
  FULFILLING: "Payment received. Your AWB, invoice and Swiftline labels are being created.",
  REVIEW_REQUIRED: "Payment received. Swiftline Operations is reviewing the shipment documents; do not pay or book again.",
  PAYMENT_REVIEW_REQUIRED: "Your payment needs gateway reconciliation. Swiftline has been notified; do not pay again.",
  REFUND_PENDING: "The shipment could not be completed and a refund has been started. Swiftline has been notified.",
  REFUNDED: "The payment was refunded because the shipment could not be created.",
};

export function PublicBookingStateCard({
  booking,
  message = "",
  onResumePayment,
  busy = false,
}: {
  booking: PublicBooking;
  message?: string;
  onResumePayment?: () => void;
  busy?: boolean;
}) {
  if (booking.state === "BOOKED") return <BookingSuccess booking={booking} />;
  return (
    <section className="mx-auto max-w-xl rounded-xl border border-amber-200 bg-white p-6 text-center shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-700">Booking {booking.reference}</p>
      <h1 className="mt-2 text-2xl font-bold text-slate-950">We are handling your booking</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">{stateMessages[booking.state] || "This booking has not been paid yet."}</p>
      {message ? <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">{message}</p> : null}
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        {onResumePayment ? (
          <button type="button" onClick={onResumePayment} disabled={busy} className="inline-flex h-11 items-center rounded-lg bg-[#0D1282] px-5 text-sm font-bold text-white disabled:opacity-50">
            {busy ? "Opening secure payment…" : "Resume secure payment"}
          </button>
        ) : null}
        <a href="mailto:Info@swiftlinefreight.com" className="inline-flex h-11 items-center rounded-lg border border-slate-300 px-5 text-sm font-bold text-slate-800">Get help</a>
      </div>
    </section>
  );
}

export default function PublicBookingStatus() {
  const params = useSearchParams();
  const [booking, setBooking] = useState<PublicBooking | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadPublicBooking(params.get("token") || "")
      .then((result) => setBooking(result.booking))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Booking status could not be loaded."));
  }, [params]);
  if (error) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border border-red-200 bg-white p-6 text-center">
        <h1 className="text-xl font-bold text-slate-950">Booking link unavailable</h1>
        <p className="mt-3 text-sm text-slate-600">{error}</p>
        <a href="mailto:Info@swiftlinefreight.com" className="mt-5 inline-flex h-11 items-center rounded-lg bg-[#0D1282] px-5 text-sm font-bold text-white">Get help</a>
      </section>
    );
  }
  if (!booking) return <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600" role="status">Loading your secure booking…</div>;
  if (booking.state === "BOOKED") return <BookingSuccess booking={booking} token={params.get("token") || ""} />;
  return <PublicBookingStateCard booking={booking} />;
}
