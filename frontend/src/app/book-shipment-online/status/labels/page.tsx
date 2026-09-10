import type { Metadata } from "next";
import { Suspense } from "react";
import PublicBookingLabels from "@/components/public-shipment-booking/PublicBookingLabels";

export const metadata: Metadata = { title: "Swiftline Parcel Labels", robots: { index: false, follow: false, noarchive: true, nosnippet: true } };
export default function PublicBookingLabelsPage() { return <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8"><Suspense fallback={<p className="text-center text-sm text-slate-600">Loading labels…</p>}><PublicBookingLabels /></Suspense></div>; }
