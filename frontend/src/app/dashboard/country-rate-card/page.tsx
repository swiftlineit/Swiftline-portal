"use client";
import { useState } from "react";
import { DashboardLoading } from "@/components/DashboardShell";
import RateCardWorkspace from "@/components/rate-cards/RateCardWorkspace";
import RateCardAccountPicker from "@/components/rate-cards/RateCardAccountPicker";
import { RATE_CARD_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { requestLeave } from "@/lib/useUnsavedChanges";

export default function CountryRateCardPage() {
  const { user, loading } = useAdminUser(RATE_CARD_AREA);
  const [selected, setSelected] = useState({ id: "", name: "Individual Clients", accountId: "" });
  if (loading || !user) return <DashboardLoading />;
  return <div className="mx-auto max-w-7xl">
    <div className="mb-6"><h1 className="text-2xl font-semibold text-slate-950">Rate Cards</h1><p className="mt-1 text-sm text-slate-600">Manage each business account&apos;s private rates and the individual client tariff.</p></div>
    <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <RateCardWorkspace key={selected.id || "individual"} businessAccountId={selected.id || undefined} cardName={selected.name} accountSelector={<RateCardAccountPicker selected={selected} onSelect={(next) => { void requestLeave().then((canLeave) => { if (canLeave) setSelected(next); }); }} />} />
    </div>
  </div>;
}
