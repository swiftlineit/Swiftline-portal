"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BusinessAccountForm from "@/components/business-accounts/BusinessAccountForm";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import OperatorPageLoading from "@/components/operators/OperatorLoadingState";

function isAccountManager(role: OperatorSession["membership"]["role"]): boolean {
  return role === "OPERATOR_ADMIN" || role === "OPERATIONS";
}

export default function OperatorBusinessAccountCreate({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signInRequired, setSignInRequired] = useState(false);

  useEffect(() => {
    let active = true;
    getOperatorSession(operatorSlug).then((session) => {
      if (active) setOperator(session);
    }).catch((cause: unknown) => {
      if (!active) return;
      const requestError = cause && typeof cause === "object"
        ? cause as { status?: unknown; canonicalSlug?: unknown }
        : null;
      if (
        requestError?.status === 409 &&
        typeof requestError.canonicalSlug === "string" &&
        requestError.canonicalSlug.length > 0 &&
        requestError.canonicalSlug !== operatorSlug
      ) {
        router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/business-accounts/new`);
        return;
      }
      setSignInRequired(requestError?.status === 401);
      setError(cause instanceof Error ? cause.message : "Unable to open business account setup.");
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => { active = false; };
  }, [operatorSlug, router]);

  const workspaceHref = `/portal/${encodeURIComponent(operatorSlug)}`;
  const signInHref = `/?next=${encodeURIComponent(`${workspaceHref}/business-accounts/new`)}`;

  if (loading) return <OperatorPageLoading label="Checking operator access…" />;

  return (
    <div className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] text-slate-900">
      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {error ? (
          <section role="alert" className="rounded-lg border border-rose-200 bg-white p-5">
            <h1 className="text-lg font-semibold text-slate-950">Business account setup unavailable</h1>
            <p className="mt-2 text-sm leading-5 text-slate-700">{error}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {signInRequired ? <Link href={signInHref} className="inline-flex min-h-10 items-center rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white">Sign in</Link> : null}
              <Link href={workspaceHref} className="inline-flex min-h-10 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700">Return to workspace</Link>
            </div>
          </section>
        ) : !operator || operator.access?.mode !== "MEMBER" || operator.access.readOnly || !isAccountManager(operator.membership.role) ? (
          <section role="alert" className="rounded-lg border border-amber-200 bg-white p-5">
            <h1 className="text-lg font-semibold text-slate-950">You can’t create business accounts</h1>
            <p className="mt-2 text-sm leading-5 text-slate-700">Ask an operator administrator or operations teammate to create the account.</p>
            <Link href={workspaceHref} className="mt-4 inline-flex min-h-10 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700">Return to workspace</Link>
          </section>
        ) : (
          <>
            {/* <div className="mb-6">
              <p className="text-sm font-medium text-slate-600"><Link href={workspaceHref} className="underline underline-offset-2">Workspace</Link> / New business account</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-slate-950">Add a client business</h1>
              <p className="mt-2 max-w-2xl text-sm leading-5 text-slate-600">The account will be saved as a draft in {operator.operator.companyName}&apos;s workspace.</p>
            </div> */}
            <BusinessAccountForm operatorSlug={operatorSlug} operatorName={operator.operator.companyName} />
          </>
        )}
      </main>
    </div>
  );
}
