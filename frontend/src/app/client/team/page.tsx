"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FiInfo, FiUserPlus, FiUsers, FiChevronDown } from "react-icons/fi";
import { toast } from "react-toastify";
import { ClientDashboardLoading } from "@/components/client/ClientDashboardShell";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import {
  listClientTeam,
  requestTeamInvite,
  teamStatusLabels,
  updateTeamMemberRole,
  type TeamMember,
  type TeamRole
} from "@/lib/clientTeam";
import { useClientUser } from "@/lib/useClientUser";

const emptyInvite = { firstName: "", lastName: "", email: "", phone: "", role: "booking_user" };

/**
 * The people on this business account.
 *
 * Inviting somebody raises a request rather than creating a login: whoever is
 * named would gain sight of this account's shipments, invoices and claims, so
 * Swiftline approves it first. The form says so plainly rather than implying
 * an invitation went out.
 */
export default function ClientTeamPage() {
  const { user, loading } = useClientUser();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [roles, setRoles] = useState<TeamRole[]>([]);
  const [invite, setInvite] = useState(emptyInvite);
  const [showInvite, setShowInvite] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);

  const load = useCallback(async () => {
    setDataLoading(true);
    setError("");
    try {
      const result = await listClientTeam();
      setMembers(result.members);
      setRoles(result.roles);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Team members could not be loaded.");
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void Promise.resolve().then(load);
  }, [user, load]);

  if (loading || !user) return <ClientDashboardLoading />;

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await requestTeamInvite(invite);
      toast.success(result.message);
      setInvite(emptyInvite);
      setTermsAccepted(false);
      setShowInvite(false);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The request could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(member: TeamMember, role: string) {
    setBusy(true);
    try {
      const result = await updateTeamMemberRole(member.id, role);
      toast.success(result.message);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The role could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-8xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-950">Team Members</h1>
          <p className="mt-1 text-sm text-slate-500">
            Who can sign in to this account, and what each of them may do.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowInvite((open) => !open)}
          className="inline-flex h-10 items-center gap-2 rounded-4xl bg-blue-950 px-4 text-sm font-semibold text-white hover:bg-blue-900"
        >
          <FiUserPlus aria-hidden="true" className="h-4 w-4" />
          Invite Team Member
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          {error}
        </div>
      ) : null}

      {showInvite ? (
        <form onSubmit={submitInvite} className="mb-5 rounded-2xl border border-slate-200 bg-white p-5">
          {/* Said before they fill the form, not after they submit it. */}
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
            <FiInfo aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-blue-800" />
            <p className="text-sm text-blue-900">
              Swiftline reviews every access request. Your colleague receives their invitation once it is approved.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase text-slate-600">First name <span className="text-red-500">*</span></span>
              <input
                value={invite.firstName}
                onChange={(event) => setInvite((current) => ({ ...current, firstName: event.target.value }))}
                maxLength={80}
                required
                className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-blue-900"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-slate-600">Last name <span className="text-red-500">*</span></span>
              <input
                value={invite.lastName}
                onChange={(event) => setInvite((current) => ({ ...current, lastName: event.target.value }))}
                maxLength={80}
                required
                className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-blue-900"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-slate-600">Email <span className="text-red-500">*</span></span>
              <input
                type="email"
                value={invite.email}
                onChange={(event) => setInvite((current) => ({ ...current, email: event.target.value }))}
                required
                className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-blue-900"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase text-slate-600">Phone <span className="text-red-500">*</span></span>
              <input
                value={invite.phone}
                onChange={(event) => setInvite((current) => ({ ...current, phone: event.target.value }))}
                placeholder="+91 98765 43210"
                required
                className="mt-2 h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none focus:border-blue-900"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-semibold uppercase text-slate-600">Role</span>
              <div className="relative">
  <select
    value={invite.role}
    onChange={(event) =>
      setInvite((current) => ({
        ...current,
        role: event.target.value,
      }))
    }
    className="mt-2 h-11 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-11 text-sm outline-none focus:border-blue-900"
  >
    {roles.map((role) => (
      <option key={role.value} value={role.value}>
        {role.label}
      </option>
    ))}
  </select>

  <FiChevronDown
    aria-hidden="true"
    className="pointer-events-none absolute right-4 top-[calc(50%+4px)] h-4 w-4 -translate-y-1/2 text-slate-500"
  />
</div>
            </label>
          </div>

          <label className="mt-4 flex items-start gap-3 text-sm leading-5 text-slate-700">
            <input
              type="checkbox"
              checked={termsAccepted}
              required
              onChange={(event) => setTermsAccepted(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              I have read and accept Swiftline&apos;s terms and the{" "}
              <Link
                href="/privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-blue-900 underline underline-offset-2"
              >
                Privacy Policy
              </Link>
              .
            </span>
          </label>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => { setShowInvite(false); setInvite(emptyInvite); setTermsAccepted(false); }}
              className="inline-flex h-10 items-center rounded-4xl border border-slate-300 px-4 text-sm font-semibold text-slate-700"
            >
              Cancel
            </button>
            <button
              disabled={busy || !termsAccepted}
              className="inline-flex h-10 items-center rounded-4xl bg-blue-950 px-5 text-sm font-semibold text-white disabled:bg-slate-400"
            >
              {busy ? "Sending…" : "Send request to Swiftline"}
            </button>
          </div>
        </form>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-180 text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-100 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Added</th>
              </tr>
            </thead>
            <tbody>
              {dataLoading ? (
                <tr><td colSpan={5} className="px-4 py-14 text-center text-slate-500">Loading team…</td></tr>
              ) : !members.length ? (
                <tr>
                  <td colSpan={5} className="px-4 py-14 text-center">
                    <FiUsers aria-hidden="true" className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-3 text-sm font-semibold text-slate-800">Only you have access</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                      Invite a colleague and Swiftline will set up their login once the request is approved.
                    </p>
                  </td>
                </tr>
              ) : members.map((member) => {
                const status = teamStatusLabels[member.status] ?? { label: member.status, tone: "border-slate-200 bg-slate-50 text-slate-700" };
                // The server refuses a self role change; the row reflects that
                // rather than offering a control that always fails.
                const isSelf = member.email.toLowerCase() === user.email.toLowerCase();
                return (
                  <tr key={member.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">{member.name || "Not provided"}</p>
                      {member.branches.length ? (
                        <p className="mt-1 text-xs text-slate-500">{member.branches.join(", ")}</p>
                      ) : null}
                    </td>
                    <td className="max-w-55 px-4 py-3">
                      <span className="block truncate text-slate-700" title={member.email}>{member.email}</span>
                    </td>
                    <td className="px-4 py-3">
                      {/* A pending request has no membership to re-role yet, and
                          the owner's role is Swiftline's to change. */}
                      {member.status === "active" && member.role !== "account_owner" && !isSelf ? (
                        <select
                          value={member.role}
                          disabled={busy}
                          onChange={(event) => void changeRole(member, event.target.value)}
                          className="h-9 rounded-xl border border-slate-300 bg-white px-2 text-sm"
                        >
                          {roles.map((role) => (
                            <option key={role.value} value={role.value}>{role.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-slate-700">{member.roleLabel}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-4xl border px-2.5 py-1 text-xs font-semibold ${status.tone}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      {member.joinedAt
                        ? formatDashboardDateTime(member.joinedAt)
                        : member.requestedAt
                          ? formatDashboardDateTime(member.requestedAt)
                          : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
