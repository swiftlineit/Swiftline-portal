"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import RateCardWorkspace from "@/components/rate-cards/RateCardWorkspace";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";
import { getOperatorSession } from "@/lib/operatorDirectory";

export default function OperatorIndividualRateCardPage({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const session = await getOperatorSession(operatorSlug);
        if (!active) return;

        if (session.operator.slug !== operatorSlug) {
          router.replace(`/portal/${encodeURIComponent(session.operator.slug)}/rate-card/individual`);
          return;
        }
        if (session.membership.role !== "OPERATOR_ADMIN") {
          setError("Only operator administrators can manage individual client rates.");
          return;
        }

        setAuthorized(true);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Unable to open individual client rates.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, [operatorSlug, router]);

  const workspaceHref = `/portal/${encodeURIComponent(operatorSlug)}`;
  if (loading) return <OperatorPageLoading label="Loading individual client rates…" />;

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
      <main className="mx-auto w-full max-w-[1440px] space-y-5 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-slate-600">
              <Link href={workspaceHref} className="underline underline-offset-2 hover:text-slate-950">Workspace</Link>
              <span aria-hidden="true"> / </span>
              Individual rates
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Individual client rates</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              Set the rates used when your staff book shipments for customers without a business account. This card belongs to this operator workspace; it does not change Swiftline or another operator’s rates.
            </p>
          </div>
          <Link href={workspaceHref} className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50">
            Back to workspace
          </Link>
        </header>

        {error ? <div role="alert" className="rounded-lg border border-rose-200 bg-white px-4 py-3 text-sm text-rose-700">{error}</div> : null}

        {authorized ? (
          <section aria-label="Operator individual client rate card" className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
            <RateCardWorkspace key={operatorSlug} cardName="Individual Clients" operatorSlug={operatorSlug} />
          </section>
        ) : null}
      </main>
    </div>
  );
}
