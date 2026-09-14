"use client";

import { ReactNode } from "react";
import Link from "next/link";
import {
  FiCalendar,
  FiCreditCard,
  FiPlus,
  FiSearch,
} from "react-icons/fi";
import type { ClientShellUser } from "@/components/client/ClientDashboardShell";
import { panelSurface } from "@/components/dashboard/DashboardWidgets";
import DashboardBanner from "@/components/dashboard/DashboardBanner";
import type { ClientDashboardAccount } from "@/lib/clientDashboard";
import { formatDashboardDate } from "@/lib/dateFormat";
import {
  canCreateShipment,
  canMakePayment,
  getBranchLabel,
} from "@/components/client/dashboard/clientDashboardPermissions";

function getDisplayName(user: ClientShellUser) {
  const name = user.name?.trim();

  if (name) return name.split(/\s+/)[0];

  return user.email.split("@")[0] || "Customer";
}

function greeting() {
  const hour = new Date().getHours();

  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";

  return "Good evening";
}

export default function ClientDashboardHeader({
  user,
  accounts,
  selectedAccount,
  selectedBranchId,
  selectedBranch,
  onAccountChange,
  onBranchChange,
}: {
  user: ClientShellUser;
  accounts: ClientDashboardAccount[];
  selectedAccount: ClientDashboardAccount | null;
  selectedBranchId: string;
  selectedBranch:
    | ClientDashboardAccount["assignedBranches"][number]
    | null;
  onAccountChange: (accountId: string) => void;
  onBranchChange: (branchId: string) => void;
}) {
  const hasMultipleAccounts = accounts.length > 1;
  const branches = selectedAccount?.assignedBranches ?? [];
  const hasMultipleBranches = branches.length > 1;

  const canCreate = selectedAccount
    ? canCreateShipment(selectedAccount)
    : false;

  const canPay = selectedAccount
    ? canMakePayment(selectedAccount)
    : false;

  return (
    <section
      id="business-accounts"
      className={`relative overflow-hidden ${panelSurface} !bg-[linear-gradient(135deg,#fbfcff_0%,#f6f8ff_52%,#eef2ff_100%)]`}
    >
      {/* Shared background across the complete client hero */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[240px] overflow-hidden"
      >
        <div className="absolute -left-24 -top-28 h-64 w-64 rounded-full bg-[#0D1282]/[0.045] blur-3xl" />

        <div className="absolute left-[38%] -top-24 h-56 w-56 rounded-full bg-[#0D1282]/[0.025] blur-3xl" />

        <div className="absolute -bottom-32 right-[12%] h-64 w-64 rounded-full bg-[#0D1282]/[0.035] blur-3xl" />
      </div>

      {/* Greeting + banner share one continuous background */}
      <div className="relative grid overflow-hidden lg:grid-cols-[minmax(0,0.9fr)_minmax(440px,1.1fr)] lg:items-stretch xl:grid-cols-[minmax(0,0.88fr)_minmax(520px,1.12fr)]">
        {/* Greeting */}
        <div className="relative flex min-w-0 flex-col justify-center px-5 py-6 sm:px-6 sm:py-7 lg:min-h-[240px] lg:px-7 lg:py-7 xl:px-8">
          <div className="relative z-10">
            {/* Client + date */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="inline-flex items-center rounded-full border border-[#0D1282]/[0.06] bg-[#0D1282]/[0.07] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[#0D1282]">
                Client
              </span>

              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                <FiCalendar
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-[#0D1282]/55"
                />

                {formatDashboardDate(new Date().toISOString())}
              </span>
            </div>

            {/* Greeting */}
            <h1 className="mt-3.5 text-[27px] font-semibold leading-[1.12] tracking-[-0.03em] text-slate-700 sm:text-[30px] xl:text-[32px]">
              {greeting()},
              <span className="capitalize text-slate-950">
                {" "}
                {getDisplayName(user)}
              </span>
            </h1>

            {/* Account context */}
            <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] font-medium text-slate-500">
              <span className="max-w-[320px] truncate font-semibold text-slate-700">
                {selectedAccount?.account.company.companyName ||
                  "Customer Dashboard"}
              </span>

              <span
                aria-hidden="true"
                className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block"
              />

              <span className="whitespace-nowrap">
                Code{" "}
                <strong className="font-semibold text-slate-700">
                  {selectedAccount?.account.accountId || "Not available"}
                </strong>
              </span>

              <span
                aria-hidden="true"
                className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block"
              />

              <span className="whitespace-nowrap">
                Branch{" "}
                <strong className="font-semibold text-slate-700">
                  {getBranchLabel(selectedBranch)}
                </strong>
              </span>
            </div>

            {/* Primary quick actions */}
            <div className="mt-5 flex flex-wrap items-center gap-2 sm:gap-2.5">
              {canCreate ? (
                <Link
                  href="/client/dpd-labels"
                  className="inline-flex min-h-10 border border-gray-300 items-center justify-center gap-2 rounded-xl bg-[#F0DE36] px-4 py-2.5 text-sm font-semibold text-[#0D1282] shadow-sm transition-colors duration-200 hover:bg-[#e5d331] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 focus-visible:ring-offset-2 sm:min-h-11"
                >
                  <FiPlus
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0"
                  />

                  Create Shipment
                </Link>
              ) : null}

              <Link
                href="/client/tracking"
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-slate-200/90 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.02)] transition-colors duration-200 hover:border-[#0D1282]/25 hover:bg-white hover:text-[#0D1282] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 focus-visible:ring-offset-2 sm:min-h-11"
              >
                <FiSearch
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0"
                />

                Track Shipment
              </Link>

              {canPay ? (
                <Link
                  href="/client/payments"
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-slate-200/90 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.02)] transition-colors duration-200 hover:border-[#0D1282]/25 hover:bg-white hover:text-[#0D1282] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 focus-visible:ring-offset-2 sm:min-h-11"
                >
                  <FiCreditCard
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0"
                  />

                  Make Payment
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        {/* Banner / transparent empty-state area */}
        <div className="relative min-h-[210px] min-w-0 sm:min-h-[220px] lg:min-h-[240px]">
          <div className="absolute inset-0">
            <DashboardBanner />
          </div>
        </div>
      </div>

      {/* Account / branch switchers */}
      {hasMultipleAccounts || hasMultipleBranches ? (
        <div className="relative border-t border-slate-200/80 bg-white/55 px-4 py-4 backdrop-blur-[2px] sm:px-5 lg:px-6">
          <div
            className={`grid gap-3 ${
              hasMultipleAccounts && hasMultipleBranches
                ? "md:grid-cols-2"
                : "md:grid-cols-1"
            }`}
          >
            {hasMultipleAccounts ? (
              <Field label="Business Account">
                <select
                  value={selectedAccount?.account.id ?? ""}
                  onChange={(event) =>
                    onAccountChange(event.target.value)
                  }
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 pr-9 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#0D1282]/60 focus:ring-2 focus:ring-[#0D1282]/10"
                >
                  {accounts.map((item) => (
                    <option
                      key={item.account.id}
                      value={item.account.id}
                    >
                      {item.account.company.companyName ||
                        item.account.accountId}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {hasMultipleBranches ? (
              <Field label="Branch">
                <select
                  value={selectedBranchId}
                  onChange={(event) =>
                    onBranchChange(event.target.value)
                  }
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 pr-9 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-[#0D1282]/60 focus:ring-2 focus:ring-[#0D1282]/10"
                >
                  {branches.map((branch) => (
                    <option
                      key={branch._id}
                      value={branch._id}
                    >
                      {getBranchLabel(branch)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-xs font-semibold text-slate-600">
        {label}
      </span>

      {children}
    </label>
  );
}