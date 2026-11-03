"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useOperatorSupportReadOnly } from "@/components/operators/OperatorSupportBoundary";
import ManifestsListPage from "@/components/shipments/ManifestsListPage";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";

export default function OperatorManifestWorkspace({ operatorSlug }: { operatorSlug: string }) {
  const supportReadOnly = useOperatorSupportReadOnly();
  const router = useRouter();
  const [session, setSession] = useState<OperatorSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorSession(operatorSlug, controller.signal).then((result) => {
      if (active) setSession(result);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      const requestError = cause && typeof cause === "object" ? cause as { status?: unknown; canonicalSlug?: unknown } : null;
      if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/manifests`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Unable to load manifests for this operator.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, router]);

  const role = session?.membership.role;
  const audience = role === "CLIENT" ? "client" : "admin";
  const canManage = !supportReadOnly && (role === "OPERATOR_ADMIN" || role === "OPERATIONS");

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {loading ? <div aria-label="Loading operator manifests" className="animate-pulse space-y-3 rounded-lg border border-slate-200 bg-white p-5"><div className="h-7 w-48 rounded bg-slate-100" /><div className="h-12 rounded bg-slate-100" /><div className="h-12 rounded bg-slate-100" /></div> : null}
        {!loading && error ? <div role="alert" className="rounded-lg border border-rose-200 bg-white p-5 text-sm text-rose-800">{error}</div> : null}
        {!loading && session ? <ManifestsListPage audience={audience} operatorSlug={operatorSlug} canManage={canManage} /> : null}
      </main>
    </div>
  );
}
