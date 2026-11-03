"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";
import {
  BusinessAccount,
  BusinessAccountMember,
  BusinessAccountMemberRole,
  BusinessAccountMemberStatus,
  businessAccountMemberRoles,
  createBusinessAccountClientAccess,
  getBusinessAccountInvitationLink,
  listBusinessAccountMembers,
  resendBusinessAccountInvitation,
  updateBusinessAccountMemberStatus
} from "@/lib/businessAccounts";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { useDialog } from "@/lib/useDialog";

const roleLabels: Record<BusinessAccountMemberRole, string> = {
  account_owner: "Account Owner",
  account_admin: "Account Admin",
  operations: "Operations",
  finance: "Finance",
  tracking_only: "Tracking Only"
};

const statusStyles: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  invited: "bg-amber-50 text-amber-700 ring-amber-600/20",
  suspended: "bg-rose-50 text-rose-700 ring-rose-600/20",
  removed: "bg-slate-100 text-slate-600 ring-slate-500/20",
  disabled: "bg-slate-100 text-slate-600 ring-slate-500/20"
};

const emptyForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  role: "account_owner" as BusinessAccountMemberRole,
  assignedBranches: [] as string[],
  sendInvitationEmail: true
};

function formatStatus(value: string) {
  return value.replaceAll("_", " ");
}

function formatDate(value?: string | null) {
  return value ? formatDashboardDateTime(value) : "Never";
}

function getAssignedBranch(account: BusinessAccount) {
  return account.assignedBranch && typeof account.assignedBranch === "object"
    ? account.assignedBranch
    : null;
}

function getAssignedBranchLabel(account: BusinessAccount) {
  const branch = getAssignedBranch(account);
  if (!branch) return "No branch assigned";
  return `${branch.name || "Branch"}${branch.code ? ` (${branch.code})` : ""}`;
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

// Turn an invitation email result into an admin-facing notice. When delivery
// fails or is disabled, the copy-link action is the manual fallback.
function describeEmailOutcome(result: { emailSent: boolean; emailSkipped: boolean; emailError?: string }) {
  if (result.emailSent) return "Invitation email sent.";
  if (result.emailSkipped) return "Email sending is disabled. Use “Copy invite link” to share access manually.";
  return "Invitation email could not be sent. Use “Copy invite link” to share access manually.";
}

export function BusinessAccountAccessPanel({ account, operatorSlug }: { account: BusinessAccount; operatorSlug?: string }) {
  const [members, setMembers] = useState<BusinessAccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [createError, setCreateError] = useState("");
  const [error, setError] = useState("");
  const [emailNotice, setEmailNotice] = useState("");
  const modalRef = useDialog<HTMLFormElement>(modalOpen, () => {
    setCreateError("");
    setModalOpen(false);
  });
  const canCreateClientLogin = ["approved", "active"].includes(account.status)
    && account.kycReview?.overallStatus === "verified"
    && Boolean(getAssignedBranch(account));
  const assignedBranch = getAssignedBranch(account);

  useEffect(() => {
    let mounted = true;

    async function loadAccessData() {
      setLoading(true);
      setError("");

      try {
        const memberResult = await listBusinessAccountMembers(account.accountId, operatorSlug);

        if (!mounted) return;
        setMembers(memberResult.members);
      } catch (caughtError) {
        if (!mounted) return;
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load client access.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadAccessData();
    return () => {
      mounted = false;
    };
  }, [account.accountId, operatorSlug]);

  function updateForm<Key extends keyof typeof form>(key: Key, value: (typeof form)[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setCreateError("");
  }

  async function handleCreateClientLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!event.currentTarget.checkValidity()) {
      setCreateError("Please complete all required fields with valid information.");
      event.currentTarget.reportValidity();
      return;
    }

    setSaving(true);
    setCreateError("");
    setEmailNotice("");

    try {
      const result = await createBusinessAccountClientAccess(account.accountId, {
        ...form,
        assignedBranches: assignedBranch?._id ? [assignedBranch._id] : []
      }, operatorSlug);
      setMembers((current) => [result.member, ...current]);
      setEmailNotice(describeEmailOutcome(result));
      setForm(emptyForm);
      setModalOpen(false);
    } catch (caughtError) {
      setCreateError(caughtError instanceof Error ? caughtError.message : "Unable to create client login.");
    } finally {
      setSaving(false);
    }
  }

  async function handleResendInvitation(memberId: string) {
    setSaving(true);
    setError("");
    setEmailNotice("");

    try {
      const result = await resendBusinessAccountInvitation(account.accountId, memberId, operatorSlug);
      setEmailNotice(describeEmailOutcome(result));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to resend invitation.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyInviteLink(memberId: string) {
    setSaving(true);
    setError("");
    setEmailNotice("");

    try {
      const result = await getBusinessAccountInvitationLink(account.accountId, memberId, operatorSlug);

      try {
        await navigator.clipboard.writeText(result.activationUrl);
        setEmailNotice("Invite link copied to clipboard. It is valid for 24 hours.");
      } catch {
        // Clipboard access can be denied; surface the link so it can still be shared.
        setEmailNotice(`Copy this invite link manually: ${result.activationUrl}`);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to generate an invite link.");
    } finally {
      setSaving(false);
    }
  }

  async function handleMemberStatusChange(
    memberId: string,
    status: Exclude<BusinessAccountMemberStatus, "invited"> | "restore"
  ) {
    setSaving(true);
    setError("");
    setEmailNotice("");

    try {
      const result = await updateBusinessAccountMemberStatus(account.accountId, memberId, status);
      setMembers((current) => current.map((member) => member._id === memberId ? result.member : member));
      if (status === "restore" && result.member.status === "invited") {
        setEmailNotice("Access restored. Send or copy the new invitation from this user row.");
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to update member access.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-[#0D1282]">Users &amp; Access</h2>
          <p className="mt-1 text-sm text-slate-500">Create client logins without storing passwords in the business account record.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setCreateError("");
            setModalOpen(true);
          }}
          disabled={!canCreateClientLogin}
          className="inline-flex items-center gap-2 rounded-4xl bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0D1282]/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" />
          </svg>
          Create Client Login
        </button>
      </div>

      {!canCreateClientLogin ? (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.63-1.516 2.63H3.72c-1.347 0-2.189-1.463-1.516-2.63L8.485 2.495ZM10 6a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0V7a1 1 0 0 1 1-1Zm0 8a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 10 14Z" clipRule="evenodd" />
          </svg>
          <span>Client login creation unlocks after the account is approved or active, KYC is verified, and one branch is assigned.</span>
        </div>
      ) : null}

      {emailNotice ? (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#0D1282]/15 bg-[#0D1282]/5 px-4 py-3 text-sm font-medium text-[#0D1282]">
          <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
          </svg>
          <span>{emailNotice}</span>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />
          </svg>
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
        <table className="min-w-full text-left text-sm">
          <thead className="border-[#0D1282] bg-slate-200 text-slate-700 ">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide ">User</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide ">Role</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide ">Branches</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide ">Status</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide ">Last Login</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide ">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <tr key={index}>
                  <td colSpan={6} className="px-4 py-4">
                    <div className="h-4 w-full max-w-sm animate-pulse rounded-full bg-slate-100" />
                  </td>
                </tr>
              ))
            ) : members.length ? members.map((member) => {
              const displayName = member.user.name || `${member.user.firstName} ${member.user.lastName}`.trim();
              return (
                <tr key={member._id} className="transition hover:bg-slate-50/80">
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0D1282]/10 text-xs font-semibold text-[#0D1282]">
                        {getInitials(displayName)}
                      </div>
                      <div>
                        <p className="font-semibold text-[#0D1282]">{displayName}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{member.user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                      {roleLabels[member.role]}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-slate-600">
                    {member.assignedBranches.length ? member.assignedBranches.map((branch) => branch.code || branch.name).join(", ") : getAssignedBranchLabel(account)}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1 ring-inset ${statusStyles[member.status] || "bg-slate-100 text-slate-600 ring-slate-500/20"}`}>
                      {formatStatus(member.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-slate-500">{formatDate(member.user.lastLogin)}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {member.status === "invited" ? (
                        <>
                          <MemberActionButton onClick={() => void handleCopyInviteLink(member._id)} disabled={saving}>
                            Copy invite link
                          </MemberActionButton>
                          <MemberActionButton onClick={() => void handleResendInvitation(member._id)} disabled={saving}>
                            Resend
                          </MemberActionButton>
                        </>
                      ) : null}
                      {!operatorSlug && member.status === "active" ? (
                        <MemberActionButton onClick={() => void handleMemberStatusChange(member._id, "suspended")} disabled={saving}>
                          Suspend
                        </MemberActionButton>
                      ) : null}
                      {!operatorSlug && member.status === "suspended" ? (
                        <MemberActionButton onClick={() => void handleMemberStatusChange(member._id, "active")} disabled={saving}>
                          Reactivate
                        </MemberActionButton>
                      ) : null}
                      {!operatorSlug && member.status === "removed" ? (
                        <MemberActionButton onClick={() => void handleMemberStatusChange(member._id, "restore")} disabled={saving}>
                          Restore access
                        </MemberActionButton>
                      ) : !operatorSlug ? (
                        <MemberActionButton onClick={() => void handleMemberStatusChange(member._id, "removed")} disabled={saving} tone="danger">
                          Remove
                        </MemberActionButton>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            }) : (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-slate-400">
                    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
                    </svg>
                    <p className="text-sm font-medium text-slate-500">No client users have been added yet.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-sm">
          <form ref={modalRef} role="dialog" aria-modal="true" aria-label="Create client login" tabIndex={-1} noValidate onSubmit={handleCreateClientLogin} className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold tracking-tight text-[#0D1282]">Create Client Login</h3>
                <p className="mt-1 text-sm text-slate-500">The client receives an activation link and creates their own password.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCreateError("");
                  setModalOpen(false);
                }}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                </svg>
              </button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <AccessField label="First Name" value={form.firstName} onChange={(value) => updateForm("firstName", value)} required />
              <AccessField label="Last Name" value={form.lastName} onChange={(value) => updateForm("lastName", value)} required />
              <AccessField label="Email" type="email" value={form.email} onChange={(value) => updateForm("email", value)} required />
              <AccessField
                label="Phone Number"
                value={form.phone}
                onChange={(value) => updateForm("phone", value)}
                placeholder="+919876543210"
                required
              />
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Client Role</span>
                <select
                  value={form.role}
                  onChange={(event) => updateForm("role", event.target.value as BusinessAccountMemberRole)}
                  className="block h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-[#0D1282] outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
                >
                  {businessAccountMemberRoles.map((role) => (
                    <option key={role} value={role}>{roleLabels[role]}</option>
                  ))}
                </select>
              </label>
              <label className="flex h-11 cursor-pointer items-center gap-3 self-end rounded-xl border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300">
                <input
                  type="checkbox"
                  checked={form.sendInvitationEmail}
                  onChange={(event) => updateForm("sendInvitationEmail", event.target.checked)}
                  className="h-4 w-4 rounded accent-[#0D1282]"
                />
                Send Invitation Email
              </label>
            </div>

            <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-[#0D1282]">Assigned Branch</p>
              <p className="mt-1.5 text-sm text-slate-600">{getAssignedBranchLabel(account)}</p>
              <p className="mt-1 text-xs text-slate-400">Client login access is restricted to the business account assigned branch.</p>
            </div>

            {createError ? (
              <div role="alert" aria-live="assertive" className="mt-5 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />
                </svg>
                <span>{createError}</span>
              </div>
            ) : null}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setCreateError("");
                  setModalOpen(false);
                }}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-xl bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0D1282]/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
              >
                {saving ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
                    </svg>
                    Creating...
                  </>
                ) : "Create Login"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function MemberActionButton({
  onClick,
  disabled,
  tone = "primary",
  children
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: "primary" | "danger";
  children: ReactNode;
}) {
  const toneClasses = tone === "danger"
    ? "text-rose-600 hover:bg-rose-50 disabled:text-slate-300"
    : "text-[#0D1282] hover:bg-[#0D1282]/5 disabled:text-slate-300";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold transition ${toneClasses}`}
    >
      {children}
    </button>
  );
}

function AccessField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}{required ? <span className="text-rose-500"> *</span> : null}
      </span>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder ?? label}
        onChange={(event) => onChange(event.target.value)}
        className="block h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-[#0D1282] outline-none transition placeholder:text-slate-300 focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
      />
    </label>
  );
}
