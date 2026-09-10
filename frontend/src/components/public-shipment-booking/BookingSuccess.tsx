"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "react-toastify";
import { apiUrl } from "@/lib/api";
import {
  startPublicBooking,
  type PublicBooking,
} from "@/lib/publicShipmentBooking";

export default function BookingSuccess({
  booking,
  token = "",
}: {
  booking: PublicBooking;
  token?: string;
}) {
  const shipment = booking.shipment;
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  const [startingNewBooking, setStartingNewBooking] = useState(false);

  async function startAnotherBooking() {
    if (startingNewBooking) return;
    setStartingNewBooking(true);
    try {
      // A completed booking deliberately keeps its secure cookie so invoice and
      // label downloads remain available. Replace that cookie with a fresh
      // server-side session before returning to the form.
      await startPublicBooking();
      window.location.replace("/book-shipment-online");
    } catch {
      toast.error("A new booking could not be started. Please try again.");
      setStartingNewBooking(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl rounded-2xl border border-emerald-200 bg-white p-6 text-center shadow-sm sm:p-10">
      <div
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700"
        aria-hidden="true"
      >
        ✓
      </div>
      <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
        Payment received · Shipment booked
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
        Your shipment is ready
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        We sent the invoice, payment receipt, tracking link and Swiftline parcel
        labels to your sender email.
      </p>
      <div className="mx-auto mt-6 max-w-md rounded-xl bg-slate-50 p-5 text-center">
        <p className="text-xs font-semibold text-slate-500">
          AWB / tracking number
        </p>
        <p className="mt-1 text-xl font-bold text-slate-950">
          {shipment?.trackingNumber || "Being finalised"}
        </p>
        <p className="mt-3 text-xs text-slate-500">
          Booking reference {booking.reference}
        </p>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link
          href={
            shipment?.trackingNumber
              ? `/track/${encodeURIComponent(shipment.trackingNumber)}`
              : "/track"
          }
          className="inline-flex h-11 items-center justify-center rounded-lg bg-[#0D1282] px-4 text-sm font-bold text-white hover:bg-[#080d64]"
        >
          Track shipment
        </Link>
        <a
          href={apiUrl(
            `/api/v1/public/shipment-bookings/status/invoice${tokenQuery}`,
          )}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800 hover:bg-slate-50"
        >
          Download invoice
        </a>
        <Link
          href={`/book-shipment-online/status/labels${tokenQuery}`}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800 hover:bg-slate-50"
        >
          Download Swiftline labels
        </Link>
        <button
          type="button"
          onClick={startAnotherBooking}
          disabled={startingNewBooking}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-800 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
        >
          {startingNewBooking
            ? "Starting new booking…"
            : "Back to book shipment"}
        </button>
      </div>
      <p className="mt-5 text-xs leading-5 text-slate-500">
        Changes, cancellations and rebooking are handled by Swiftline staff. Do
        not create another payment for the same booking.
      </p>
    </section>
  );
}
