"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getOperatorUserProfile, type OperatorUserProfile } from "@/lib/operatorDirectory";
import OperatorReadOnlyUserProfileView, { OperatorUserProfilePageHeader } from "@/components/operators/OperatorReadOnlyUserProfileView";
import { OperatorLoadingIndicator } from "@/components/operators/OperatorLoadingState";

export default function OperatorUserProfilePage({
  operatorSlug,
  audience,
  membershipId
}: {
  operatorSlug: string;
  audience: "team" | "clients";
  membershipId: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<OperatorUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorUserProfile(operatorSlug, audience, membershipId, controller.signal)
      .then((response) => { if (active) setResult(response); })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        const requestError = cause && typeof cause === "object" ? cause as { status?: unknown; canonicalSlug?: unknown } : null;
        if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug) {
          router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/users/${audience}/${encodeURIComponent(membershipId)}`);
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to load this user profile.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [audience, membershipId, operatorSlug, retryKey, router]);

  const base = `/portal/${encodeURIComponent(operatorSlug)}`;
  const anchor = audience === "team" ? "operator-team-users" : "operator-client-users";
  const backHref = `${base}/users#${anchor}`;
  const backLabel = audience === "team" ? "Back to operator team" : "Back to business account users";
  const description = audience === "team"
    ? "Read-only operator team member details and workspace access."
    : "Read-only client user details and business account access.";
  const profile = result?.profile;

  if (loading || error || !profile) {
    return (
      <main className="bg-[#EEEDED]">
        <div className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[1440px] flex-col gap-5 px-3 py-6 sm:px-6 sm:py-8 lg:px-8">
          <OperatorUserProfilePageHeader backHref={backHref} backLabel={backLabel} description={description} />
          {loading ? <OperatorLoadingIndicator label="Loading user profile…" className="flex-1" /> : (
            <section role="alert" className="flex flex-col gap-3 rounded-xl border border-rose-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-rose-900">{error || "User profile not found."}</p>
              {error ? <button type="button" onClick={() => { setLoading(true); setError(""); setRetryKey((current) => current + 1); }} className="min-h-9 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Try again</button> : null}
            </section>
          )}
        </div>
      </main>
    );
  }

  return (
    <OperatorReadOnlyUserProfileView
      backHref={backHref}
      backLabel={backLabel}
      description={description}
      profile={{
        name: profile.user.name || [profile.user.firstName, profile.user.lastName].filter(Boolean).join(" "),
        firstName: profile.user.firstName,
        lastName: profile.user.lastName,
        email: profile.user.email,
        phone: profile.user.phone,
        designation: profile.user.designation,
        userStatus: profile.user.userStatus,
        role: profile.membership.role,
        accessStatus: profile.membership.status,
        createdAt: profile.membership.createdAt,
        lastLogin: profile.user.lastLogin,
        account: profile.account,
        branches: profile.branches,
        allBranchesAccess: profile.allBranchesAccess
      }}
    />
  );
}
