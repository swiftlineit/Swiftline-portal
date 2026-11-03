"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiArrowLeft } from "react-icons/fi";
import BranchForm from "@/components/branches/BranchForm";
import { Branch, branchToFormData, getBranch } from "@/lib/branches";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";

export default function OperatorBranchFormPage({ operatorSlug, branchId }: { operatorSlug: string; branchId?: string }) {
  const router = useRouter();
  const supportReadOnly = useOperatorSupportReadOnly();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [branch, setBranch] = useState<Branch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      try {
        const session = await getOperatorSession(operatorSlug, controller.signal);
        if (!active) return;
        setOperator(session);

        if (session.membership.role !== "OPERATOR_ADMIN" || session.access.readOnly || supportReadOnly) return;
        if (!branchId) return;

        const result = await getBranch(branchId, operatorSlug, controller.signal);
        if (active) setBranch(result.branch);
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        const requestError = cause && typeof cause === "object"
          ? cause as { status?: unknown; canonicalSlug?: unknown }
          : null;
        if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug) {
          const route = branchId ? `/branches/${encodeURIComponent(branchId)}/edit` : "/branches/new";
          router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}${route}`);
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to load branch details.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [operatorSlug, branchId, refreshKey, router, supportReadOnly]);

  const branchesPath = `/portal/${encodeURIComponent(operatorSlug)}/branches`;
  const canManage = Boolean(operator?.membership.role === "OPERATOR_ADMIN" && !operator.access.readOnly && !supportReadOnly);

  if (loading) {
    return <OperatorPageLoading label={branchId ? "Loading branch details…" : "Checking operator access…"} backgroundClassName="bg-slate-50" />;
  }

  return (
    <main className="min-h-[calc(100dvh-5rem)] bg-slate-50 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <Link href={branchesPath} className="inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-[#0D1282] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"><FiArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to branches</Link>
        <header className="mt-5 border-b border-slate-200 pb-5">
          <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{branchId ? "Edit branch" : "Create branch"}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{branch ? `${branch.name} · ${branch.code}` : "Set up an operating location for your business accounts and shipments."}</p>
        </header>

        {error ? (
          <section role="alert" className="mt-5 rounded-lg border border-rose-200 bg-white p-4">
            <p className="text-sm text-rose-900">{error}</p>
            <button type="button" onClick={() => { setLoading(true); setError(""); setRefreshKey((current) => current + 1); }} className="mt-3 min-h-9 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Try again</button>
          </section>
        ) : null}

        {operator?.access.readOnly || supportReadOnly ? (
          <p className="mt-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Swiftline support access is read only. Branch changes are disabled.</p>
        ) : null}

        {!canManage && operator && !operator.access.readOnly && !supportReadOnly ? (
          <p className="mt-5 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">Only this operator’s administrator can create or edit branches.</p>
        ) : null}

        {canManage && !error && (!branchId || branch) ? (
          <div className="mt-5">
            <BranchForm
              operatorSlug={operatorSlug}
              branchId={branch?._id}
              initialData={branch ? branchToFormData(branch) : undefined}
              initialStatus={branch?.status ?? "DRAFT"}
              identityLocked={Boolean(branch?.activatedAt)}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}
