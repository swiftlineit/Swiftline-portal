"use client";

import { useEffect, useState } from "react";
import { FiActivity, FiShield, FiUser } from "react-icons/fi";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { useClientUser } from "@/lib/useClientUser";

type ActivityEntry = {
  id: string;
  action: string;
  description: string;
  reference: string;
  actorName: string;
  actorSide: "ACCOUNT" | "SWIFTLINE";
  performedAt: string;
};

async function loadActivity() {
  let token = getAccessToken() ?? await refreshAccessToken();
  const send = () => fetch(apiUrl("/api/v1/client/activity?limit=100"), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (token) response = await send();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.message || "Account activity could not be loaded.");
  return data.entries as ActivityEntry[];
}

/**
 * Who did what on this account.
 *
 * Deliberately a curated feed rather than the raw audit trail: the log also
 * records carrier failures and validation calls, which are Swiftline's
 * diagnostics and would bury the handful of entries a customer cares about.
 */
export default function ClientActivityPage() {
  const { user, loading } = useClientUser();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.resolve().then(async () => {
      try {
        const result = await loadActivity();
        if (active) setEntries(result);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Account activity could not be loaded.");
      } finally {
        if (active) setDataLoading(false);
      }
    });
    return () => { active = false; };
  }, [user]);

  if (loading || !user) return <ClientDashboardLoading />;

  return (
    <div className=" max-w-8xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-950">Account Activity</h1>
        <p className="mt-1 text-sm text-slate-500">
          What your team and Swiftline have done on this account.
        </p>
      </div>

      {error ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          {error}
        </div>
      ) : dataLoading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm font-semibold text-slate-500">
          Loading activity…
        </div>
      ) : !entries.length ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <FiActivity aria-hidden="true" className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 font-semibold text-slate-900">No activity yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Shipments created, invoices downloaded, claims raised and payments received will appear here as your team uses the portal.
          </p>
        </div>
      ) : (
        <ol className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0">
              {/* Swiftline and the customer's own team read differently, so the
                  icon says which before the sentence does. */}
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                entry.actorSide === "SWIFTLINE" ? "bg-blue-50 text-blue-900" : "bg-slate-100 text-slate-600"
              }`}>
                {entry.actorSide === "SWIFTLINE"
                  ? <FiShield aria-hidden="true" className="h-4 w-4" />
                  : <FiUser aria-hidden="true" className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-800">
                  <span className="font-semibold text-slate-950">{entry.actorName}</span>{" "}
                  {entry.description}
                  {entry.reference ? <span className="font-semibold text-slate-950"> {entry.reference}</span> : null}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{formatDashboardDateTime(entry.performedAt)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
