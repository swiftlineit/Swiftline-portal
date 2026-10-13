"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FiChevronDown, FiChevronRight, FiSearch } from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import { StatusPill } from "@/components/users/StaffFields";
import UserAvatar from "@/components/users/UserAvatar";
import { roleLabels, STAFF_DIRECTORY_AREA, type PortalRole } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { listUsers, updateUserStatus, type User, type UserStatus } from "@/lib/users";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import {
  approveClientAccessRequest,
  declineClientAccessRequest,
  listClientAccessRequests,
  type ClientAccessRequest
} from "@/lib/clientAccessRequests";

// The transitions offered per current status, so the row only shows the moves
// that are actually available from where the account is now.
const statusActionMap: Record<UserStatus, Array<{ label: string; status: UserStatus }>> = {
  invited: [
    { label: "Activate", status: "active" },
    { label: "Suspend", status: "suspended" },
    { label: "Disable", status: "disabled" }
  ],
  active: [
    { label: "Suspend", status: "suspended" },
    { label: "Disable", status: "disabled" }
  ],
  suspended: [
    { label: "Activate", status: "active" },
    { label: "Disable", status: "disabled" }
  ],
  disabled: [{ label: "Activate", status: "active" }]
};

const statusActionTone: Record<UserStatus, string> = {
  active: "border-emerald-200 text-emerald-700 hover:bg-emerald-50",
  invited: "border-slate-200 text-slate-700 hover:bg-slate-50",
  suspended: "border-amber-200 text-amber-700 hover:bg-amber-50",
  disabled: "border-red-200 text-red-700 hover:bg-red-50"
};

function branchSummary(item: User) {
  if (item.role === "admin") return "All branches";
  if (item.role === "client") return "Managed through client access";

  const names = item.assignedBranches.map((branch) => branch.code || branch.name).filter(Boolean);
  if (!names.length) return "None";
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

/** A branch id, whichever field it arrived in. */
function branchId(branch: { _id?: string; id?: string }) {
  return branch._id ?? branch.id ?? "";
}

/** Matches a user against the search box, across the fields people search by. */
function matchesSearch(item: User, needle: string) {
  if (!needle) return true;
  const term = needle.toLowerCase();
  return [
    item.name,
    [item.firstName, item.lastName].filter(Boolean).join(" "),
    item.email,
    item.phone,
    ...item.assignedBranches.flatMap((branch) => [branch.name, branch.code])
  ].some((value) => (value ?? "").toLowerCase().includes(term));
}

export default function UsersPage() {
  const { user, loading } = useAdminUser(STAFF_DIRECTORY_AREA);
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [tab, setTab] = useState<"directory" | "requests">("directory");
  const [requests, setRequests] = useState<ClientAccessRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [decliningId, setDecliningId] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  // The request currently being approved or declined. Its buttons are disabled
  // while the call is in flight, so a second click cannot create a second login.
  const [busyRequestId, setBusyRequestId] = useState("");

  // Login status is an admin action. HR reads the directory only, matching the
  // guard on PATCH /users/:id/status.
  const canManageStatus = user?.role === "admin";
  // Approving a request creates a real login, so the queue is admin-only-
  // the same line the endpoint draws.
  const canReviewRequests = user?.role === "admin";

  useEffect(() => {
    if (!user) return;
    async function loadUsers() {
      setLoadingUsers(true);
      try {
        setUsers((await listUsers()).users);
      } catch (caughtError) {
        toast.error(caughtError instanceof Error ? caughtError.message : "Unable to load users.");
      } finally {
        setLoadingUsers(false);
      }
    }
    void loadUsers();
  }, [user]);

  const loadRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      setRequests((await listClientAccessRequests()).requests);
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Unable to load access requests.");
    } finally {
      setRequestsLoading(false);
    }
  }, []);

  // Loaded regardless of the visible tab, so the badge can say how many are
  // waiting without somebody having to go and look.
  useEffect(() => {
    if (!user || !canReviewRequests) return;
    void Promise.resolve().then(loadRequests);
  }, [user, canReviewRequests, loadRequests]);

  /**
   * Approves the request in one step and reports what happened.
   *
   * The server creates the login, sends the password invitation and clears the
   * request, so the list is reloaded rather than edited in place- the row is
   * gone, and the person appears under Users once they set their password.
   *
   * `busyRequestId` disables the buttons for the row being worked on, because
   * a second click here would try to create a second login.
   */
  async function approve(item: ClientAccessRequest) {
    setBusyRequestId(item.id);
    try {
      const result = await approveClientAccessRequest(item.id);
      // A login created without its email is an approval that still stands, so
      // it is reported as a warning the operator has to act on rather than as
      // a failure that would suggest retrying.
      if (result.emailSent) toast.success(result.message);
      else toast.warning(result.message);
      await loadRequests();
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "The request could not be approved.");
    } finally {
      setBusyRequestId("");
    }
  }

  async function decline(item: ClientAccessRequest) {
    if (declineReason.trim().length < 3) return;
    setBusyRequestId(item.id);
    try {
      const result = await declineClientAccessRequest(item.id, declineReason.trim());
      toast.success(result.message);
      setDecliningId("");
      setDeclineReason("");
      await loadRequests();
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "The request could not be declined.");
    } finally {
      setBusyRequestId("");
    }
  }

  async function handleStatusChange(userId: string, status: UserStatus) {
    setBusyUserId(userId);
    try {
      const updated = await updateUserStatus(userId, status);
      setUsers((current) => current.map((item) => item._id === userId ? { ...item, ...updated.user } : item));
      toast.success(`User status changed to ${status}.`);
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Unable to update user status.");
    } finally {
      setBusyUserId(null);
    }
  }

  /** Branches that actually appear in the directory, so the filter offers no dead options. */
  const branchOptions = useMemo(() => {
    const found = new Map<string, string>();
    for (const item of users) {
      for (const branch of item.assignedBranches) {
        // The list serialises a branch as either `_id` or `id` depending on
        // where it was populated, so both are accepted rather than one being
        // assumed and half the branches silently missing from the filter.
        const id = branchId(branch);
        if (id) found.set(id, branch.code ? `${branch.name} (${branch.code})` : branch.name);
      }
    }
    return [...found.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [users]);

  const visibleUsers = useMemo(() => users.filter((item) => {
    if (!matchesSearch(item, search.trim())) return false;
    if (statusFilter && item.userStatus !== statusFilter) return false;
    // An admin has no branch rows but reaches every branch, so a branch filter
    // keeps them rather than hiding the people who can act on it.
    if (branchFilter && item.role !== "admin"
      && !item.assignedBranches.some((branch) => branchId(branch) === branchFilter)) return false;
    return true;
  }), [users, search, statusFilter, branchFilter]);

  if (loading || !user) return <DashboardLoading />;

  return (
    <>
      <div className="mb-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">Users</h1>
            <p className="mt-1 text-sm text-slate-500">
              Add internal staff and open a record to review or change their details.
            </p>
          </div>

          <Link
            href="/dashboard/users/new"
            className="inline-flex h-10 w-fit items-center justify-center rounded-xl bg-[#0D1282] px-4 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/15 transition hover:bg-[#0a0d63]"
          >
            + Add Staff
          </Link>
        </div>

        {canReviewRequests ? (
          <div className="mt-5 border-b border-slate-200">
            <div className="flex min-w-0 items-center gap-6 overflow-x-auto">
              {([
                { key: "directory" as const, label: "Staff directory" },
                { key: "requests" as const, label: "Client login requests" }
              ]).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={`relative inline-flex shrink-0 items-center gap-2 pb-3 text-sm font-semibold transition-colors ${
                    tab === item.key
                      ? "text-[#0D1282]"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {item.label}

                  {/* Only shown when there is something waiting: a permanent "0"
                      trains people to stop looking at the number. */}
                  {item.key === "requests" && requests.length ? (
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-bold text-white">
                      {requests.length}
                    </span>
                  ) : null}

                  {tab === item.key ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#0D1282]"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {tab === "requests" ? (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="font-semibold text-slate-950">Client login requests</h2>
            <p className="mt-1 text-sm text-slate-500">
              Raised by a business account administrator. Approving one creates a portal login with access to that account.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-3xl text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="whitespace-nowrap px-5 py-4">Person</th>
                  <th className="whitespace-nowrap px-5 py-4">Account</th>
                  <th className="whitespace-nowrap px-5 py-4">Role</th>
                  <th className="whitespace-nowrap px-5 py-4">Requested by</th>
                  <th className="whitespace-nowrap px-5 py-4 text-right">Decision</th>
                </tr>
              </thead>
              <tbody>
                {requestsLoading ? (
                  <tr><td colSpan={5} className="px-5 py-12 text-center text-slate-500">Loading requests…</td></tr>
                ) : !requests.length ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center">
                      <p className="font-semibold text-slate-900">No requests waiting</p>
                      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                        When a customer asks for a login for one of their colleagues, it appears here for approval before any account is created.
                      </p>
                    </td>
                  </tr>
                ) : requests.map((item) => (
                  <tr key={item.id} className="border-b border-slate-100 last:border-b-0 align-top">
                    <td className="px-5 py-4">
                      <p className="font-semibold text-slate-900">{item.firstName} {item.lastName}</p>
                      <p className="mt-1 text-xs text-slate-500">{item.email}</p>
                      <p className="text-xs text-slate-500">{item.phone}</p>
                    </td>
                    <td className="px-5 py-4">
                      <p className="text-slate-800">{item.accountName}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {item.accountCode}{item.branchCode ? ` · ${item.branchCode}` : ""}
                      </p>
                    </td>
                    <td className="px-5 py-4 text-slate-700">{item.roleLabel}</td>
                    <td className="px-5 py-4">
                      <p className="text-slate-700">{item.requestedByName}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDashboardDateTime(item.requestedAt)}</p>
                    </td>
                    <td className="px-5 py-4">
                      {decliningId === item.id ? (
                        <div className="flex flex-col items-end gap-2">
                          <textarea
                            value={declineReason}
                            onChange={(event) => setDeclineReason(event.target.value)}
                            placeholder="Why is this being declined? The customer sees this."
                            maxLength={500}
                            className="min-h-20 w-full min-w-56 rounded-xl border border-slate-300 p-2 text-sm"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => { setDecliningId(""); setDeclineReason(""); }}
                              className="inline-flex h-9 items-center rounded-4xl border border-slate-300 px-3 text-sm font-semibold text-slate-700"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={declineReason.trim().length < 3 || busyRequestId === item.id}
                              onClick={() => void decline(item)}
                              className="inline-flex h-9 items-center rounded-4xl bg-red-600 px-3 text-sm font-semibold text-white disabled:bg-slate-300"
                            >
                              {busyRequestId === item.id ? "Declining…" : "Confirm decline"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            disabled={busyRequestId === item.id}
                            onClick={() => setDecliningId(item.id)}
                            className="inline-flex h-9 items-center rounded-4xl border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:border-slate-200 disabled:text-slate-400"
                          >
                            Decline
                          </button>
                          <button
                            type="button"
                            disabled={busyRequestId === item.id}
                            onClick={() => void approve(item)}
                            className="inline-flex h-9 items-center rounded-4xl bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#0a0d63] disabled:bg-slate-300"
                          >
                            {busyRequestId === item.id ? "Sending invite…" : "Approve"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
      <>
      {/* Filtered in the browser rather than the server: this directory is
          staff only and loads in full, so every row is already here. */}
      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <FiSearch
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, email, phone or branch"
              className="h-10 w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 text-sm outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:shrink-0">
            <div className="relative min-w-0 sm:min-w-52 lg:w-56">
              <select
                value={branchFilter}
                onChange={(event) => setBranchFilter(event.target.value)}
                className="h-10 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-10 text-sm font-medium text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
              >
                <option value="">All branches</option>
                {branchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.label}</option>
                ))}
              </select>
              <FiChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              />
            </div>

            <div className="relative min-w-0 sm:min-w-44 lg:w-44">
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="h-10 w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 pr-10 text-sm font-medium text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10"
              >
                <option value="">All statuses</option>
                {["active", "invited", "suspended", "disabled"].map((status) => (
                  <option key={status} value={status}>
                    {status[0]?.toUpperCase()}{status.slice(1)}
                  </option>
                ))}
              </select>
              <FiChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 lg:ml-1 lg:shrink-0">
            {search || branchFilter || statusFilter ? (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setBranchFilter("");
                  setStatusFilter("");
                }}
                className="text-sm font-semibold text-slate-500 transition hover:text-slate-800"
              >
                Clear
              </button>
            ) : (
              <span />
            )}

            <span className="whitespace-nowrap text-sm text-slate-500">
              <span className="font-semibold text-slate-800">{visibleUsers.length}</span> of {users.length}
            </span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-3xl text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
            <tr>
              <th className="whitespace-nowrap px-5 py-4">Name</th>
              <th className="whitespace-nowrap px-5 py-4">Role</th>
              <th className="whitespace-nowrap px-5 py-4">Assigned Branches</th>
              <th className="whitespace-nowrap px-5 py-4">Staff Details</th>
              <th className="whitespace-nowrap px-5 py-4">Status</th>
              <th className="whitespace-nowrap px-5 py-4 text-right">Actions</th>
            </tr>
          </thead>

          <tbody>
            {loadingUsers ? (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-slate-500">Loading users...</td>
              </tr>
            ) : visibleUsers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-slate-500">
                  {users.length ? "No users match these filters." : "No users found."}
                </td>
              </tr>
            ) : visibleUsers.map((item) => (
              <tr key={item._id} className="border-b border-slate-100 align-middle last:border-b-0 hover:bg-slate-50/60">
                <td className="px-5 py-4">
                  <Link href={`/dashboard/users/${item._id}`} className="flex items-center gap-3 font-medium text-slate-900 transition hover:text-[#0D1282]">
                    <UserAvatar userId={item._id} name={item.name} hasProfileImage={item.hasProfileImage} />
                    <span className="min-w-0">
                      <span className="block truncate">{item.name || "Unnamed user"}</span>
                      <span className="mt-0.5 block truncate text-xs font-normal text-slate-500">{item.email}</span>
                    </span>
                  </Link>
                </td>

                <td className="whitespace-nowrap px-5 py-4">
                  <span className="inline-flex items-center rounded-full bg-[#0D1282]/8 px-2.5 py-1 text-xs font-semibold text-[#0D1282]">
                    {roleLabels[item.role as PortalRole] ?? item.role}
                  </span>
                </td>

                <td className="px-5 py-4 text-slate-700">{branchSummary(item)}</td>

                <td className="px-5 py-4">
                  <div className="space-y-0.5 text-xs text-slate-600">
                    {item.staffProfile?.designation ? <p>{item.staffProfile.designation}</p> : null}
                    {item.phone ? <p>{item.phone}</p> : null}
                    {item.staffProfile?.employeeCode ? <p>Code: {item.staffProfile.employeeCode}</p> : null}
                  </div>
                </td>

                <td className="whitespace-nowrap px-5 py-4"><StatusPill status={item.userStatus} /></td>

                <td className="whitespace-nowrap px-5 py-4">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {/* Your own login is not suspendable from here, so an admin
                        cannot lock themselves out of the portal. */}
                    {canManageStatus && item.userStatus && item.email !== user.email
                      ? statusActionMap[item.userStatus].map((action) => (
                        <button
                          key={`${item._id}-${action.status}`}
                          type="button"
                          disabled={busyUserId === item._id}
                          onClick={() => void handleStatusChange(item._id, action.status)}
                          className={`h-8 rounded-full border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${statusActionTone[action.status]}`}
                        >
                          {action.label}
                        </button>
                      ))
                      : null}

                    <Link
                      href={`/dashboard/users/${item._id}`}
                      className="inline-flex items-center gap-1 text-sm font-semibold text-[#0D1282] transition hover:underline"
                    >
                      View
                      <FiChevronRight aria-hidden="true" className="h-4 w-4" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </>
  );
}
