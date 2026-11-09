"use client";

import { useEffect, useState } from "react";
import DriverPickupApp from "@/components/driver/DriverPickupApp";
import SupervisorPickupBoard from "@/components/driver/SupervisorPickupBoard";
import DeliveryPersonPodApp from "@/components/pods/DeliveryPersonPodApp";
import { getMyDriverProfile, type Driver } from "@/lib/drivers";

export default function DriverHomePage() {
  const [driver, setDriver] = useState<Driver | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void getMyDriverProfile().then((result) => setDriver(result.driver)).catch((caught) => setError(caught instanceof Error ? caught.message : "Delivery profile could not be loaded.")); }, []);
  if (error) return <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">{error}</div>;
  if (!driver) return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex min-h-[calc(100dvh-8rem)] items-center justify-center px-6 py-8 text-center md:min-h-[calc(100dvh-5rem)]">
      <p className="text-sm font-semibold text-[#0D1282]">Loading pickup work...</p>
    </div>
  );
  if (driver.status !== "ACTIVE") return <div className="rounded-3xl bg-white p-8 text-center shadow-sm"><h1 className="text-xl font-bold">Access awaiting approval</h1><p className="mt-2 text-sm text-slate-500">Your invitation is activated. A Swiftline administrator must approve your delivery profile before pickup work becomes available.</p><p className="mt-4 text-xs font-bold uppercase tracking-wide text-amber-700">{driver.status.replace(/_/g, " ")}</p></div>;
  if (driver.deliverySubrole === "SUPERVISOR") return <SupervisorPickupBoard />;
  if (driver.deliverySubrole === "DELIVERY_PERSON") return <DeliveryPersonPodApp />;
  return <DriverPickupApp />;
}
