"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AuthRecoveryIssue } from "@/lib/authRecovery";

function recoveryCopy(issue: AuthRecoveryIssue) {
  switch (issue.kind) {
    case "session":
      return {
        title: "Your session may have expired",
        description: issue.message || "Sign in again to continue. If you are already signed in, try the access check again."
      };
    case "permission":
      return {
        title: "This account cannot access this page",
        description: "Sign in with an account that has access, or contact your Swiftline administrator."
      };
    case "network":
      return {
        title: "We could not reach Swiftline",
        description: "Check your internet connection, then try again. You can also sign in again."
      };
    case "service":
      return {
        title: "We could not verify your access",
        description: issue.status
          ? `The access check failed with HTTP ${issue.status}. Swiftline may be temporarily unavailable. Try again shortly or sign in.`
          : "Swiftline could not complete the access check. Try again shortly or sign in again."
      };
  }
}

export default function AuthRecoveryPage({
  issue,
  onRetry
}: {
  issue: AuthRecoveryIssue;
  onRetry: () => void;
}) {
  const pathname = usePathname() || "/";
  const signInHref = pathname === "/" ? "/" : `/?next=${encodeURIComponent(pathname)}`;
  const copy = recoveryCopy(issue);

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12 text-slate-950">
      <section role="alert" aria-live="assertive" aria-labelledby="auth-recovery-title" className="w-full max-w-xl text-center">
        <h1 id="auth-recovery-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {copy.title}
        </h1>
        <p className="mx-auto mt-3 max-w-prose text-base leading-7 text-slate-700">
          {copy.description}
        </p>
        <div className="mt-7 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <Link
            href={signInHref}
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-[#0D1282] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#151c9a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            Sign in
          </Link>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-semibold text-[#0D1282] underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            Try again
          </button>
        </div>
      </section>
    </main>
  );
}
