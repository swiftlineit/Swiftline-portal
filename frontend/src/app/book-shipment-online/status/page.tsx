import type { Metadata } from "next";
import { Suspense } from "react";
import PublicBookingStatus from "@/components/public-shipment-booking/PublicBookingStatus";

export const metadata: Metadata = {
  title: "Secure Booking Status | Swiftline Cargo",
  description:
    "View the status and documents for a Swiftline online shipment booking.",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nosnippet: true,
  },
};

export default function PublicBookingStatusPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <Suspense
        fallback={
          <p className="text-center text-sm text-slate-600">
            Loading secure booking…
          </p>
        }
      >
        <PublicBookingStatus />
      </Suspense>
    </div>
  );
}
