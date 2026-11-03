"use client";

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FiLock } from "react-icons/fi";
import { getOperatorSession } from "@/lib/operatorDirectory";
import { clearOperatorSupportGrant, getOperatorSupportGrant, type OperatorSupportGrant } from "@/lib/operatorSupport";
import { endOperatorSupportSession } from "@/lib/operatorRegistry";

const OperatorSupportReadOnlyContext = createContext(false);

export function useOperatorSupportReadOnly() {
  return useContext(OperatorSupportReadOnlyContext);
}

export default function OperatorSupportBoundary({ operatorSlug, children }: { operatorSlug: string; children: ReactNode }) {
  const router = useRouter();
  const [grant, setGrant] = useState<OperatorSupportGrant | null>(null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = getOperatorSupportGrant();
    if (!stored) return;
    const expiresAt = Date.parse(stored.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearOperatorSupportGrant();
      router.replace("/dashboard/operators");
      return;
    }
    // sessionStorage is unavailable during SSR, so restore the grant after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGrant(stored);
    let active = true;
    const expirationTimer = window.setTimeout(() => {
      clearOperatorSupportGrant();
      setGrant(null);
      router.replace("/dashboard/operators");
    }, expiresAt - Date.now());
    getOperatorSession(operatorSlug).then((session) => {
      if (!active) return;
      if (session.access.mode !== "PLATFORM_SUPPORT" || !session.access.readOnly) {
        clearOperatorSupportGrant();
        setGrant(null);
      }
    }).catch((cause: unknown) => {
      if (!active) return;
      const status = cause && typeof cause === "object" ? (cause as { status?: unknown }).status : undefined;
      // A slug rename returns a checked canonical redirect while preserving the
      // same tenant-bound grant. Keep it through that one navigation.
      if (status === 409) return;
      clearOperatorSupportGrant();
      setGrant(null);
    });
    return () => {
      active = false;
      window.clearTimeout(expirationTimer);
    };
  }, [operatorSlug, router]);

  async function endSupportAccess() {
    if (!grant || ending) return;
    setEnding(true);
    setError("");
    try {
      await endOperatorSupportSession(grant);
      clearOperatorSupportGrant();
      setGrant(null);
      router.replace("/dashboard/operators");
    } catch (cause) {
      const status = cause && typeof cause === "object" ? (cause as { status?: unknown }).status : undefined;
      if (status === 404) {
        clearOperatorSupportGrant();
        router.replace("/dashboard/operators");
        return;
      }
      setError(cause instanceof Error ? cause.message : "Support access could not be ended. Try again.");
    } finally {
      setEnding(false);
    }
  }

  return (
    <OperatorSupportReadOnlyContext.Provider value={Boolean(grant)}>
      {grant ? (
        <div className="border-b border-amber-300 bg-amber-50 text-amber-950">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-start gap-2.5">
              <FiLock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">Swiftline support access · read only</p>
                <p className="mt-0.5 text-xs leading-5 text-amber-900">
                  {grant.companyName} · {grant.reason} · Expires {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(grant.expiresAt))}
                </p>
                {error ? <p role="alert" className="mt-1 text-xs font-medium text-red-800">{error}</p> : null}
              </div>
            </div>
            <button type="button" onClick={() => void endSupportAccess()} disabled={ending}
              className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border border-amber-500 bg-white px-3 text-sm font-semibold text-amber-950 transition hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800 disabled:cursor-wait disabled:opacity-60">
              {ending ? "Ending access…" : "End support access"}
            </button>
          </div>
        </div>
      ) : null}
      {children}
    </OperatorSupportReadOnlyContext.Provider>
  );
}
