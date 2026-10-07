"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FiAlertTriangle, FiCheckCircle, FiFileText, FiShield } from "react-icons/fi";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import { useClientUser } from "@/lib/useClientUser";

type CustomsKycOverview = {
  account: {
    businessAccountId: string;
    companyName: string;
    accountId: string;
    kycStatus: string;
    kycStatusLabel: string;
    checks: Array<{ key: string; label: string; status: string }>;
    gstin: string;
    gstExempt: boolean;
  } | null;
  shipments: Array<{
    shipmentDraftId: string;
    awb: string;
    consignee: string;
    destination: string;
    csbType: string;
    statusLabel: string;
    clearanceQuery: string;
    missingDocuments: string[];
    uploadedDocuments: string[];
  }>;
  summary: { shipmentsNeedingDocuments: number; shipmentsHeldAtCustoms: number };
};

async function loadOverview() {
  let token = getAccessToken() ?? await refreshAccessToken();
  const send = () => fetch(apiUrl("/api/v1/client/customs-kyc"), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (token) response = await send();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.message || "Customs and KYC could not be loaded.");
  return data.overview as CustomsKycOverview;
}

const checkTone: Record<string, string> = {
  verified: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-red-200 bg-red-50 text-red-700",
  under_review: "border-blue-200 bg-blue-50 text-blue-700",
  submitted: "border-slate-200 bg-slate-50 text-slate-700"
};

/**
 * Customs and compliance in one place, account level and shipment level.
 *
 * Both belong here because both can stop goods: lapsed account KYC blocks
 * future bookings, a customs query stops a parcel already in the air. A page
 * showing only the first would tell a customer everything is fine while a
 * shipment sits at the border.
 */
export default function CustomsKycPage() {
  const { user, loading } = useClientUser();
  const [overview, setOverview] = useState<CustomsKycOverview | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.resolve().then(async () => {
      try {
        const result = await loadOverview();
        if (active) setOverview(result);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Customs and KYC could not be loaded.");
      } finally {
        if (active) setDataLoading(false);
      }
    });
    return () => { active = false; };
  }, [user]);

  if (loading || !user) return <ClientDashboardLoading />;

  const account = overview?.account;
  const needsDocuments = overview?.summary.shipmentsNeedingDocuments ?? 0;
  const heldAtCustoms = overview?.summary.shipmentsHeldAtCustoms ?? 0;

  return (
    <div className="mx-auto max-w-8xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-950">Customs &amp; Compliance</h1>
        <p className="mt-1 text-sm text-slate-500">
          Your account verification, and the customs paperwork your shipments still need.
        </p>
      </div>

      {error ? (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>
      ) : null}

      {dataLoading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm font-semibold text-slate-500">
          Loading customs and compliance…
        </div>
      ) : (
        <div className="space-y-5">
          {/* Stated first and in plain numbers, because this is the whole
              reason a customer opens this page. */}
          {needsDocuments || heldAtCustoms ? (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <FiAlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
              <div className="text-sm text-amber-900">
                {heldAtCustoms ? (
                  <p className="font-semibold">
                    {heldAtCustoms} shipment{heldAtCustoms === 1 ? " is" : "s are"} held for a customs query.
                  </p>
                ) : null}
                {needsDocuments ? (
                  <p className={heldAtCustoms ? "mt-1" : "font-semibold"}>
                    {needsDocuments} shipment{needsDocuments === 1 ? "" : "s"} require customs documents.
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <FiCheckCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-700" />
              <p className="text-sm font-semibold text-emerald-900">
                No shipment is waiting on customs paperwork.
              </p>
            </div>
          )}

         <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
  <div className="flex flex-col gap-4">
    {/* Header */}
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <FiShield aria-hidden="true" className="h-4 w-4" />
        </span>

        <div>
          <h2 className="font-semibold text-slate-950">
            Account verification
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Business and verification details
          </p>
        </div>
      </div>

      {account ? (
        <span
          className={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-semibold uppercase ${
            checkTone[account.kycStatus] ??
            "border-slate-200 bg-slate-50 text-slate-700"
          }`}
        >
          {account.kycStatusLabel}
        </span>
      ) : null}
    </div>

    {account ? (
      <div className="grid gap-4 border-t border-slate-100 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        {/* Account information */}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Account
            </dt>
            <dd className="mt-1 flex-wrap-reversebreak-words text-sm font-medium text-slate-800">
              {account.companyName}
              <span className="ml-1 font-normal text-slate-500">
                ({account.accountId})
              </span>
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              GSTIN
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">
              {account.gstin || "Not provided"}
            </dd>
          </div>

          <div className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              GST status
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-800">
              {account.gstExempt ? "Exempt" : "Registered"}
            </dd>
          </div>
        </dl>

        {/* Verification checks */}
        <div className="lg:border-l lg:border-slate-100 lg:pl-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Verification checks
            </p>

            {account.checks.length ? (
              <span className="text-xs text-slate-400">
                {account.checks.length}
              </span>
            ) : null}
          </div>

          {account.checks.length ? (
            <div className="flex flex-wrap gap-2">
              {account.checks.map((check) => (
                <span
                  key={check.key}
                  className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${
                    checkTone[check.status] ??
                    "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  {check.label}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-5 text-slate-500">
              No verification documents have been submitted yet. Swiftline will
              request what is needed.
            </p>
          )}
        </div>
      </div>
    ) : (
      <div className="border-t border-slate-100 pt-4">
        <p className="text-sm text-slate-500">
          No business account is linked to your login.
        </p>
      </div>
    )}
  </div>
</section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="flex items-center gap-2 font-semibold text-slate-950">
                <FiFileText aria-hidden="true" className="h-4 w-4 text-slate-400" />
                Shipment customs status
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Only shipments waiting on paperwork or held by customs appear here.
              </p>
            </div>

            {!overview?.shipments.length ? (
              <div className="px-5 py-12 text-center">
                <FiCheckCircle aria-hidden="true" className="mx-auto h-8 w-8 text-emerald-500" />
                <p className="mt-3 text-sm font-semibold text-slate-800">Nothing outstanding</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                  Every booked shipment has the customs documents it needs. Anything Swiftline or customs asks for later will appear here.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-205 text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-3">AWB</th>
                      <th className="px-4 py-3">Consignee</th>
                      <th className="px-4 py-3">Customs route</th>
                      <th className="px-4 py-3">Outstanding</th>
                      <th className="px-4 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.shipments.map((shipment) => (
                      <tr key={shipment.shipmentDraftId} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-900">{shipment.awb || "AWB pending"}</p>
                          <p className="mt-1 text-xs text-slate-500">{shipment.statusLabel}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800">{shipment.consignee || "Not set"}</p>
                          <p className="mt-1 text-xs text-slate-500">{shipment.destination}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{shipment.csbType.replace("_", "-")}</td>
                        <td className="px-4 py-3">
                          {shipment.clearanceQuery ? (
                            <p className="font-medium text-red-700">{shipment.clearanceQuery}</p>
                          ) : null}
                          {shipment.missingDocuments.length ? (
                            <p className={shipment.clearanceQuery ? "mt-1 text-slate-700" : "text-slate-700"}>
                              {shipment.missingDocuments.join(", ")}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {/* Upload lives on the shipment, where the documents
                              attach- this points at it rather than making a
                              second place to send the same files. */}
                          <Link
                            href={`/client/shipments/${shipment.shipmentDraftId}`}
                            className="font-semibold text-blue-900 hover:text-blue-700"
                          >
                            Upload documents
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
