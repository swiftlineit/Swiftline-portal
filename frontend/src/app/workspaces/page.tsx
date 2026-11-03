"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowRight, FiBriefcase, FiLogOut, FiRefreshCw } from "react-icons/fi";
import { getClientWorkspaceAccess, type ClientWorkspaceAccess } from "@/lib/clientWorkspaceAccess";
import { logout } from "@/lib/auth";
import type { OperatorWorkspace } from "@/lib/operatorWorkspaces";

function operatorRoleLabel(role: OperatorWorkspace["role"]) {
  switch (role) {
    case "OPERATOR_ADMIN": return "Operator administrator";
    case "FINANCE": return "Finance";
    case "OPERATIONS": return "Operations";
    case "CLIENT": return "Operator client";
  }
}

function WorkspaceLink({ href, name, description }: { href: string; name: string; description: string }) {
  return (
    <Link href={href} className="group flex min-h-24 items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-[#0D1282]/40 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] sm:p-5">
      <span className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#0D1282]/[0.06] text-[#0D1282]">
          <FiBriefcase aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block break-words font-semibold text-slate-900">{name}</span>
          <span className="mt-1 block text-sm text-slate-600">{description}</span>
        </span>
      </span>
      <FiArrowRight aria-hidden="true" className="h-5 w-5 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-[#0D1282]" />
    </Link>
  );
}

export default function WorkspacesPage() {
  const router = useRouter();
  const [access, setAccess] = useState<ClientWorkspaceAccess | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setAccess(await getClientWorkspaceAccess());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workspace access could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getClientWorkspaceAccess()
      .then((result) => { if (active) setAccess(result); })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Workspace access could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function handleSignOut() {
    await logout();
    router.replace("/");
  }

  return (
    <main className="min-h-dvh bg-[#F6F8FC] px-4 py-8 text-slate-900 sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex items-center justify-between gap-4">
          <Link href="/" className="text-sm font-bold uppercase tracking-[0.12em] text-[#0D1282]">Swiftline Portal</Link>
          <button type="button" onClick={() => void handleSignOut()} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
            <FiLogOut aria-hidden="true" className="h-4 w-4" /> Sign out
          </button>
        </header>

        <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:mt-14 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#0D1282]">Separate workspaces</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Choose a workspace</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Each workspace has its own business accounts, shipments, invoices, and credit records.
          </p>

          {loading ? (
            <p role="status" className="mt-7 rounded-lg bg-slate-50 px-4 py-5 text-sm text-slate-600">Checking your workspace access…</p>
          ) : error ? (
            <div className="mt-7 rounded-lg border border-rose-200 bg-rose-50 p-4" role="alert">
              <p className="text-sm font-medium text-rose-900">{error}</p>
              <button type="button" onClick={() => void load()} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-md border border-rose-300 bg-white px-3 text-sm font-semibold text-rose-900 hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700">
                <FiRefreshCw aria-hidden="true" className="h-4 w-4" /> Try again
              </button>
            </div>
          ) : access ? (
            <div className="mt-7 space-y-3">
              {access.swiftline ? (
                <WorkspaceLink href="/client/dashboard" name="Swiftline client portal" description="Your Swiftline business account and shipments" />
              ) : null}
              {access.operators.map((workspace) => workspace.status === "ACTIVE" ? (
                <WorkspaceLink
                  key={workspace.slug}
                  href={`/portal/${encodeURIComponent(workspace.slug)}`}
                  name={workspace.companyName}
                  description={operatorRoleLabel(workspace.role)}
                />
              ) : (
                <div key={workspace.slug} className="flex min-h-24 items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 sm:p-5">
                  <span className="min-w-0">
                    <span className="block break-words font-semibold text-slate-900">{workspace.companyName}</span>
                    <span className="mt-1 block text-sm text-slate-600">{operatorRoleLabel(workspace.role)}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">Awaiting activation</span>
                </div>
              ))}
              {!access.swiftline && access.operators.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 sm:p-6">
                  <h2 className="font-semibold text-slate-900">No workspace access is connected</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">If you accepted an invitation, check that you signed in with the invited email. Otherwise, ask the business account administrator to confirm your access.</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
