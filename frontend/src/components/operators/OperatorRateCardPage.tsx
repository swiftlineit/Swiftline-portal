"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import RateCardWorkspace from "@/components/rate-cards/RateCardWorkspace";
import { getBusinessAccount, type BusinessAccount } from "@/lib/businessAccounts";
import { getOperatorSession } from "@/lib/operatorDirectory";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";

export default function OperatorRateCardPage({ operatorSlug, accountId }: { operatorSlug: string; accountId: string }) {
  const router = useRouter();
  const [account, setAccount] = useState<BusinessAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const session = await getOperatorSession(operatorSlug);
        if (session.membership.role !== "OPERATOR_ADMIN") {
          throw new Error("Only the operator administrator can manage rate cards.");
        }
        const result = await getBusinessAccount(accountId, operatorSlug);
        if (!active) return;
        setAccount(result.account);
      } catch (cause) {
        if (!active) return;
        const requestError = cause && typeof cause === "object" ? cause as { canonicalSlug?: unknown } : null;
        if (typeof requestError?.canonicalSlug === "string" && requestError.canonicalSlug !== operatorSlug) {
          router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/business-accounts/${encodeURIComponent(accountId)}/rate-card`);
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to open this rate card.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, operatorSlug, router]);

  const workspaceHref = `/portal/${encodeURIComponent(operatorSlug)}`;
  if (loading) {
    return <OperatorPageLoading label="Loading operator rate card…" />;
  }

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
      <main className="mx-auto w-full max-w-[1440px] space-y-5 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div>
          <p className="text-sm text-slate-600"><Link href={workspaceHref} className="underline underline-offset-2">Workspace</Link> / <Link href={`${workspaceHref}/business-accounts/${encodeURIComponent(accountId)}`} className="underline underline-offset-2">Business account</Link> / Rate card</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{account?.company.companyName || "Business account rate card"}</h1>
          {account ? <p className="mt-1 text-sm text-slate-600">{account.accountId} · Configure the rates and route charges used for this account’s shipment pricing.</p> : null}
        </div>
        {error ? <div role="alert" className="rounded-lg border border-rose-200 bg-white px-4 py-3 text-sm text-rose-700">{error}</div> : null}
        {account ? <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
          <RateCardWorkspace key={account._id} businessAccountId={account._id} cardName={`${account.company.companyName} Rate Card`} operatorSlug={operatorSlug} />
        </section> : null}
      </main>
    </div>
  );
}
