"use client";

import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { FiAlertTriangle } from "react-icons/fi";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import { OperatorLoadingIndicator } from "@/components/operators/OperatorLoadingState";

const OperatorWorkspaceSessionContext = createContext<OperatorSession | null>(null);
const ReportWorkspaceIssueContext = createContext<((status?: number) => void) | null>(null);

export function useOperatorWorkspaceSession() {
  return useContext(OperatorWorkspaceSessionContext);
}

export function useReportOperatorWorkspaceIssue() {
  return useContext(ReportWorkspaceIssueContext);
}

type AvailabilityState =
  | { operatorSlug: string; status: "available"; session: OperatorSession }
  | { operatorSlug: string; status: "unavailable" }
  | { operatorSlug: string; status: "session-ended" }
  | { operatorSlug: string; status: "request-failed" }
  | { operatorSlug: string; status: "unverified" };

function requestStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function WorkspaceNoticePage({
  operatorSlug,
  status,
  onRetry
}: {
  operatorSlug: string;
  status: "unavailable" | "session-ended" | "request-failed";
  onRetry: () => void;
}) {
  const title = status === "unavailable"
    ? "This workspace is unavailable right now"
    : status === "session-ended"
      ? "Your session has ended"
      : "Workspace overview unavailable";
  const description = status === "unavailable"
    ? "We are taking a short maintenance break. Please try again later."
    : status === "session-ended"
      ? "Please sign in again to continue."
      : "We could not load this workspace. Try again or sign in.";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#EEEDED] px-4 py-8">
      <section
        role="alert"
        aria-labelledby="workspace-notice-title"
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white px-6 py-8 text-center shadow-sm sm:px-10 sm:py-10"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <FiAlertTriangle aria-hidden="true" className="h-5 w-5" />
        </div>
        <h1 id="workspace-notice-title" className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">
          {title}
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-600 sm:text-base">
          {description}
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href={`/?next=${encodeURIComponent(`/portal/${operatorSlug}`)}`}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#0D1282] px-5 text-sm font-semibold text-white transition hover:bg-[#11199f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            Sign in
          </Link>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            Try again
          </button>
        </div>
      </section>
    </main>
  );
}

export default function OperatorWorkspaceAvailabilityBoundary({
  operatorSlug,
  children
}: {
  operatorSlug: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<AvailabilityState | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const currentState = state?.operatorSlug === operatorSlug ? state : null;
  const reportWorkspaceIssue = useCallback((status?: number) => {
    setState({
      operatorSlug,
      status: status === 401 ? "session-ended" : status === 404 ? "unavailable" : "request-failed"
    });
  }, [operatorSlug]);
  const retryWorkspace = useCallback(() => {
    setState(null);
    setRetryKey((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void getOperatorSession(operatorSlug, controller.signal).then((session) => {
      if (active) setState({ operatorSlug, status: "available", session });
    }).catch((error: unknown) => {
      if (!active) return;
      const status = requestStatus(error);
      setState({
        operatorSlug,
        status: status === 404 ? "unavailable" : status === 401 ? "session-ended" : "unverified"
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [operatorSlug, retryKey]);

  if (!currentState) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#EEEDED] px-4 py-10">
        <OperatorLoadingIndicator label="Checking workspace availability..." className="min-h-[12rem] w-full" />
      </main>
    );
  }

  if (currentState.status === "unavailable" || currentState.status === "session-ended" || currentState.status === "request-failed") {
    return <WorkspaceNoticePage operatorSlug={operatorSlug} status={currentState.status} onRetry={retryWorkspace} />;
  }

  if (currentState.status === "available") {
    return (
      <OperatorWorkspaceSessionContext.Provider value={currentState.session}>
        <ReportWorkspaceIssueContext.Provider value={reportWorkspaceIssue}>{children}</ReportWorkspaceIssueContext.Provider>
      </OperatorWorkspaceSessionContext.Provider>
    );
  }

  return <ReportWorkspaceIssueContext.Provider value={reportWorkspaceIssue}>{children}</ReportWorkspaceIssueContext.Provider>;
}
