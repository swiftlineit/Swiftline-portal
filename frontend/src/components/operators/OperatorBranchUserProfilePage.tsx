"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getOperatorBranchUser, type OperatorBranchUserProfile } from "@/lib/operatorDirectory";
import OperatorReadOnlyUserProfileView, { OperatorUserProfilePageHeader } from "@/components/operators/OperatorReadOnlyUserProfileView";
import { OperatorLoadingIndicator } from "@/components/operators/OperatorLoadingState";

export default function OperatorBranchUserProfilePage({ operatorSlug, branchId, membershipId }: {
  operatorSlug: string;
  branchId: string;
  membershipId: string;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<OperatorBranchUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getOperatorBranchUser(operatorSlug, branchId, membershipId, controller.signal)
      .then((result) => { if (active) setProfile(result); })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        const requestError = cause && typeof cause === "object" ? cause as { status?: unknown; canonicalSlug?: unknown } : null;
        if (requestError?.status === 409 && typeof requestError.canonicalSlug === "string" && requestError.canonicalSlug) {
          router.replace(`/portal/${encodeURIComponent(requestError.canonicalSlug)}/branches/${encodeURIComponent(branchId)}/users/${encodeURIComponent(membershipId)}`);
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to load this user profile.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [operatorSlug, branchId, membershipId, retryKey, router]);

  const base = `/portal/${encodeURIComponent(operatorSlug)}`;
  const backHref = `${base}/branches/${encodeURIComponent(branchId)}?tab=users`;
  const user = profile?.user;

  if (loading || error || !profile || !user) {
    return (
      <main className="bg-[#EEEDED]">
        <div className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[1440px] flex-col gap-5 px-3 py-6 sm:px-6 sm:py-8 lg:px-8">
          <OperatorUserProfilePageHeader
            backHref={backHref}
            backLabel="Back to branch users"
            description="Read-only details for a user assigned to this branch."
          />
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

  const account = user.account ?? null;
  return (
    <OperatorReadOnlyUserProfileView
      backHref={backHref}
      backLabel="Back to branch users"
      description="Read-only details for a user assigned to this branch."
      profile={{
        name: user.user?.name || [user.user?.firstName, user.user?.lastName].filter(Boolean).join(" "),
        firstName: user.user?.firstName ?? "",
        lastName: user.user?.lastName ?? "",
        email: user.user?.email ?? "",
        phone: user.user?.phone ?? "",
        designation: user.user?.designation ?? "",
        userStatus: user.user?.userStatus ?? "unavailable",
        role: user.role,
        accessStatus: user.membershipStatus,
        createdAt: user.createdAt,
        lastLogin: user.user?.lastLogin ?? null,
        account,
        branches: [{ id: profile.branch._id, name: profile.branch.name }],
        allBranchesAccess: user.role === "OPERATOR_ADMIN"
      }}
    />
  );
}
