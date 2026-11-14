"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState, type ReactNode } from "react";
import { FiEye, FiEyeOff } from "react-icons/fi";
import { activateInvitation, getInvitation, logout } from "@/lib/auth";
import { acceptOperatorClientInvitation, acceptOperatorInvitation } from "@/lib/operatorRegistry";

type InvitationDetails = {
  kind?: "BUSINESS" | "DRIVER" | "OPERATOR";
  email: string;
  name: string;
  businessAccountId?: string;
  companyName: string;
  expiresAt: string;
  operatorSlug?: string;
  role?: "OPERATOR_ADMIN";
  requiresSignIn?: boolean;
  deliverySubrole?: string;
  engagementType?: string;
};

export default function ActivateClientAccountPage() {
  return (
    <Suspense fallback={<ActivationShell message="Loading activation..." />}>
      <ActivateClientAccountContent />
    </Suspense>
  );
}

function ActivateClientAccountContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const returnPath = token ? `/auth/activate?token=${encodeURIComponent(token)}` : "/auth/activate";
  const signInHref = `/?next=${encodeURIComponent(returnPath)}`;
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    async function loadInvitation() {
      if (!token) {
        setError("Invitation token is missing.");
        setLoading(false);
        return;
      }

      try {
        const result = await getInvitation(token);
        setInvitation(result.invitation);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load invitation.");
      } finally {
        setLoading(false);
      }
    }

    void loadInvitation();
  }, [token]);

  async function handleActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);

    try {
      await activateInvitation({
        token,
        password,
        confirmPassword,
        termsAccepted
      });
      setSuccess("Your account has been activated. Redirecting to login...");
      const nextPath = invitation?.operatorSlug ? `/portal/${encodeURIComponent(invitation.operatorSlug)}` : "/";
      window.setTimeout(() => router.push(`/?next=${encodeURIComponent(nextPath)}`), 1500);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to activate account.");
    } finally {
      setSaving(false);
    }
  }

  async function handleOperatorAcceptance() {
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const result = await acceptOperatorInvitation(token);
      setSuccess(result.message);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to accept this operator invitation.");
    } finally {
      setSaving(false);
    }
  }

  async function handleOperatorClientAcceptance() {
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const result = await acceptOperatorClientInvitation(token);
      setSuccess(result.message);
      router.replace(`/portal/${encodeURIComponent(result.operator.slug)}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to accept this client access invitation.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSwitchToInvitedAccount() {
    setSwitchingAccount(true);
    await logout();
    router.replace(signInHref);
  }

  return (
    <ActivationShell>

        {loading ? <p className="mt-6 text-sm text-slate-500">Checking invitation...</p> : null}

        {!loading && invitation ? (
          <>
            <div className="mt-6 border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {invitation.kind === "OPERATOR" ? (
                <>
                  <p><span className="font-semibold">Access:</span> Operator administrator</p>
                  <p className="mt-1"><span className="font-semibold">Operator:</span> {invitation.companyName}</p>
                  {invitation.operatorSlug ? <p className="mt-1"><span className="font-semibold">Portal URL:</span> /portal/{invitation.operatorSlug}</p> : null}
                  <p className="mt-2 leading-5">This grants access to this operator&apos;s separate workspace. It does not grant Swiftline staff permissions or access to Swiftline&apos;s operational workspace.</p>
                </>
              ) : invitation.kind === "DRIVER" ? (
                <>
                  <p><span className="font-semibold">Access:</span> Swiftline Pickup Driver Portal</p>
                  <p className="mt-1"><span className="font-semibold">Driver type:</span> {(invitation.engagementType ?? "").replace(/_/g, " ")}</p>
                </>
              ) : (
                <>
                  <p><span className="font-semibold">Company:</span> {invitation.companyName}</p>
                  {invitation.operatorSlug ? <p className="mt-1"><span className="font-semibold">Operator portal:</span> /portal/{invitation.operatorSlug}</p> : null}
                </>
              )}
              <p className="mt-1"><span className="font-semibold">Email:</span> {invitation.email}</p>
              <p className="mt-1"><span className="font-semibold">Expires:</span> {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(invitation.expiresAt))}</p>
            </div>

            {(invitation.kind === "OPERATOR" || (invitation.kind === "BUSINESS" && invitation.operatorSlug)) && invitation.requiresSignIn ? (
              <div className="mt-6 space-y-4">
                <p className="text-sm leading-6 text-slate-700">
                  This email already has a portal account. Sign in as <span className="font-semibold">{invitation.email}</span> with the existing password, then accept the invitation here. Your password will not be changed.
                </p>
                <Link href={signInHref}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-blue-900 px-4 text-sm font-semibold text-white transition hover:bg-blue-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
                  Sign in with the invited account
                </Link>
                <button type="button" disabled={switchingAccount} onClick={() => void handleSwitchToInvitedAccount()}
                  className="inline-flex min-h-10 w-full items-center justify-center rounded-lg px-4 text-sm font-semibold text-slate-700 underline underline-offset-4 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60">
                  {switchingAccount ? "Signing out…" : "Sign out and switch accounts"}
                </button>
                <button type="button" disabled={saving} onClick={() => void (invitation.kind === "OPERATOR" ? handleOperatorAcceptance() : handleOperatorClientAcceptance())}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-blue-900 px-4 text-sm font-semibold text-blue-950 transition hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60">
                  {saving ? "Accepting invitation…" : invitation.kind === "OPERATOR" ? "Accept operator invitation" : "Accept client access"}
                </button>
                <p className="text-xs leading-5 text-slate-600">Only the account invited at this address can accept access. If you are signed in as someone else, sign out and return using the invited account.</p>
              </div>
            ) : (
            <form onSubmit={handleActivation} className="mt-6 grid gap-4">
              <div className="relative">
                <input
                  type={passwordVisible ? "text" : "password"}
                  value={password}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="New Password *"
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 w-full border border-slate-300 px-3 pr-11 text-sm outline-none transition placeholder:text-slate-400 focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                />
                <button
                  type="button"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  aria-label={passwordVisible ? "Hide new password" : "Show new password"}
                  aria-pressed={passwordVisible}
                  className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
                >
                  {passwordVisible ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
                </button>
              </div>
              <div className="relative">
                <input
                  type={confirmPasswordVisible ? "text" : "password"}
                  value={confirmPassword}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="Confirm Password *"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="h-12 w-full border border-slate-300 px-3 pr-11 text-sm outline-none transition placeholder:text-slate-400 focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                />
                <button
                  type="button"
                  onClick={() => setConfirmPasswordVisible((visible) => !visible)}
                  aria-label={confirmPasswordVisible ? "Hide confirm password" : "Show confirm password"}
                  aria-pressed={confirmPasswordVisible}
                  className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
                >
                  {confirmPasswordVisible ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
                </button>
              </div>
              <label className="flex items-start gap-3 text-sm font-medium leading-6 text-slate-700">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  required
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  I accept Swiftline terms and conditions.{" "}
                  <Link
                    href="/terms-and-conditions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-900 hover:underline"
                  >
                    Read terms and conditions
                  </Link>
                  .
                </span>
              </label>
              <button
                type="submit"
                disabled={saving}
                className="h-12 bg-blue-900 px-4 text-sm font-semibold text-white transition hover:bg-blue-950 disabled:bg-slate-300"
              >
                {saving ? "Activating..." : "Activate Account"}
              </button>
            </form>
            )}
          </>
        ) : null}

        {error ? <div role="alert" className="mt-5 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div> : null}
        {success ? <div role="status" className="mt-5 border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">{success}</div> : null}

        <Link href={(invitation?.kind === "OPERATOR" || (invitation?.kind === "BUSINESS" && invitation.operatorSlug)) && invitation.requiresSignIn ? signInHref : "/auth/login"} className="mt-6 inline-block text-sm font-semibold text-blue-900">
          Back to login
        </Link>
    </ActivationShell>
  );
}

function ActivationShell({ children, message }: { children?: ReactNode; message?: string }) {
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-10">
      <section className="mx-auto max-w-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-blue-900">Swiftline Portal</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Activate Account</h1>
        {message ? <p className="mt-6 text-sm text-slate-500">{message}</p> : children}
      </section>
    </main>
  );
}
