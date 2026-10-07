"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FiChevronDown, FiEdit2, FiExternalLink } from "react-icons/fi";
import { BiEdit } from "react-icons/bi";
import { DashboardLoading } from "@/components/DashboardShell";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import {
  Branch,
  BranchStatus,
  branchStatusTransitions,
  deleteBranchDraft,
  formatBranchLabel,
  listBranches,
  updateBranchStatus,
} from "@/lib/branches";
import { BRANCH_VIEW_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

function formatListValue(values: string[]) {
  if (!values.length) return "Not set";
  if (values.length <= 2) return values.map(formatBranchLabel).join(", ");

  return `${values.slice(0, 2).map(formatBranchLabel).join(", ")} +${values.length - 2}`;
}

// Status badge colours using the portal palette.
function getStatusBadgeClasses(status: BranchStatus) {
  switch (status) {
    case "ACTIVE":
      return "bg-[#22C55E]/10 text-[#15803D] ring-1 ring-[#22C55E]/20";

    case "DRAFT":
      return "bg-[#F3F4F6] text-[#4B5563] ring-1 ring-[#D1D5DB]";

    case "INACTIVE":
      return "bg-[#F3F4F6] text-[#6B7280] ring-1 ring-[#D1D5DB]";

    case "SUSPENDED":
      return "bg-[#FFF7ED] text-[#C2410C] ring-1 ring-[#FDBA74]";

    case "CLOSED":
      return "bg-[#F3F4F6] text-[#4B5563] ring-1 ring-[#D1D5DB]";

    default:
      return "bg-[#F3F4F6] text-[#4B5563] ring-1 ring-[#D1D5DB]";
  }
}

// Human labels for the lifecycle actions offered per status.
const statusActionLabels: Record<BranchStatus, string> = {
  DRAFT: "Move to Draft",
  ACTIVE: "Activate",
  INACTIVE: "Deactivate",
  SUSPENDED: "Suspend",
  CLOSED: "Close",
};

export default function BranchesPage() {
  // Operations reads this page; creating, editing, and status changes stay with
  // admin, matching the write guards on the branch router.
  const { user, loading } = useAdminUser(BRANCH_VIEW_AREA);
  const canManage = user?.role === "admin";
  const [branches, setBranches] = useState<Branch[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [updatingBranchId, setUpdatingBranchId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Branch | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 10;

  useEffect(() => {
    if (!user) return;

    async function loadBranches() {
      setBranchesLoading(true);
      setError("");

      try {
        const data = await listBranches(search, status, page, pageSize);
        setBranches(data.branches);
        setTotal(data.total ?? data.branches.length);
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load branches.",
        );
      } finally {
        setBranchesLoading(false);
      }
    }

    const timeout = window.setTimeout(() => {
      void loadBranches();
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [search, status, user, page]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * pageSize;

  async function handleStatusChange(branch: Branch, nextStatus: BranchStatus) {
    setUpdatingBranchId(branch._id);
    setError("");

    try {
      const data = await updateBranchStatus(branch._id, nextStatus);
      setBranches((current) =>
        current.map((item) => (item._id === branch._id ? data.branch : item)),
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to update branch status.",
      );
    } finally {
      setUpdatingBranchId(null);
    }
  }

  async function handleDeleteDraft() {
    if (!pendingDelete) return;

    setDeleting(true);
    setError("");

    try {
      await deleteBranchDraft(pendingDelete._id);
      setBranches((current) =>
        current.filter((item) => item._id !== pendingDelete._id),
      );
      setPendingDelete(null);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to delete this draft branch.",
      );
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleStatusMenuChange(branch: Branch, value: string) {
    if (!value || value.startsWith("current:")) return;

    if (value === "delete") {
      setPendingDelete(branch);
      return;
    }

    if (value.startsWith("status:")) {
      await handleStatusChange(
        branch,
        value.replace("status:", "") as BranchStatus,
      );
    }
  }

  if (loading || !user) return <DashboardLoading />;

  return (
    <div className="min-h-full -m-6 p-6 lg:-m-8 lg:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0D1282]">
            Branches
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {canManage
              ? "Create, activate, and manage operating branches."
              : "Operating branches and their assignments."}
          </p>
        </div>
        {canManage ? (
          <Link
            href="/dashboard/branches/create"
            className="inline-flex items-center gap-2 rounded-4xl bg-[#0D1282] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#0D1282]/20 transition hover:bg-[#0a0d63] focus:outline-none focus:ring-2 focus:ring-[#0D1282]/40 focus:ring-offset-2"
          >
            <span className="text-base leading-none">+</span> Create New Branch
          </Link>
        ) : null}
      </div>

      <div className="mb-4 grid gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-[1fr_240px]">
        <label className="block text-sm font-semibold text-slate-700">
          Search
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Branch name, code, city, or email"
            className="mt-2 block h-10 w-full rounded-lg border border-slate-200 bg-[#EEEDED]/50 px-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:bg-white focus:ring-2 focus:ring-[#0D1282]/15"
          />
        </label>
        <label className="block text-sm font-semibold text-slate-700">
          Status
          <div className="relative mt-2">
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 pr-10 text-sm font-semibold text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
            >
              <option value="">All Status</option>
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="CLOSED">Closed</option>
            </select>
            <FiChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#0D1282]"
            />
          </div>
        </label>
      </div>

      {error ? (
        <div className="mb-4 rounded-xl border border-[#D71313]/25 bg-[#D71313]/5 px-4 py-3 text-sm font-medium text-[#D71313]">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-200 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-3.5 font-semibold">Branch</th>
                <th className="px-4 py-3.5 font-semibold">Status</th>
                <th className="px-4 py-3.5 font-semibold">Location</th>
                <th className="px-4 py-3.5 font-semibold">Currency</th>
                <th className="px-4 py-3.5 font-semibold">Services</th>
                <th className="px-4 py-3.5 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {branchesLoading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-slate-500"
                  >
                    Loading branches...
                  </td>
                </tr>
              ) : branches.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-slate-500"
                  >
                    No branches found.
                  </td>
                </tr>
              ) : (
                branches.map((branch) => (
                  <tr
                    key={branch._id}
                    className="transition-colors hover:bg-[#EEEDED]/40"
                  >
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-slate-900">
                        {branch.name}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-[#0D1282]">
                        {branch.code}
                      </p>
                      {branch.labelCode ? (
                        <p className="mt-1 text-xs text-slate-500">
                          Station {branch.labelCode}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${getStatusBadgeClasses(branch.status)}`}
                      >
                        {formatBranchLabel(branch.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <p className="text-slate-700">
                        {branch.address.city || "Not set"}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {branch.address.countryName ||
                          branch.address.countryCode ||
                          "Not set"}
                      </p>
                    </td>
                    <td className="px-4 py-3.5 text-slate-700">
                      {branch.baseCurrency || "Not set"}
                    </td>
                    <td className="px-4 py-3.5 text-slate-600">
                      {formatListValue(branch.operations.supportedServices)}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative w-36">
                          <select
                            value={`current:${branch.status}`}
                            onChange={(event) =>
                              void handleStatusMenuChange(
                                branch,
                                event.target.value,
                              )
                            }
                            disabled={!canManage || updatingBranchId === branch._id}
                            aria-label={`Change status for ${branch.name}`}
                            className="h-9 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-2.5 pr-8 text-xs font-semibold capitalize text-slate-700 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15 disabled:opacity-60"
                          >
                            <option value={`current:${branch.status}`}>
                              {updatingBranchId === branch._id
                                ? "Updating..."
                                : formatBranchLabel(branch.status)}
                            </option>
                            {branchStatusTransitions[branch.status].map(
                              (nextStatus) => (
                                <option
                                  key={nextStatus}
                                  value={`status:${nextStatus}`}
                                >
                                  {statusActionLabels[nextStatus]}
                                </option>
                              ),
                            )}
                            {/* A branch that has operated is closed, not
                                deleted, so this is offered on drafts only. */}
                            {branch.status === "DRAFT" ? (
                              <option value="delete">Delete Draft</option>
                            ) : null}
                          </select>
                          <FiChevronDown
                            aria-hidden="true"
                            className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#0D1282]"
                          />
                        </div>
                        <Link
                          href={`/dashboard/branches/${branch._id}`}
                          className="inline-flex items-center gap-1 text-sm font-semibold text-blue-900 hover:text-blue-700"
                        >
                          View{" "}
                          <FiExternalLink
                            aria-hidden="true"
                            className="h-4 w-4"
                          />
                        </Link>
                        {canManage ? (
                          <Link
                            href={`/dashboard/branches/${branch._id}/edit`}
                            className="inline-flex items-center gap-1 ml-3 text-sm font-semibold text-blue-900 hover:text-blue-700"
                          >
                            Edit
                            <BiEdit aria-hidden="true" className="h-4 w-4" />
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {total > pageSize ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-sm text-slate-600 shadow-sm">
          <p>
            Showing{" "}
            <span className="font-semibold text-slate-800">
              {startIndex + 1}-{Math.min(startIndex + pageSize, total)}
            </span>{" "}
            of <span className="font-semibold text-slate-800">{total}</span>{" "}
            branches
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={safePage === 1}
              className="rounded-lg border border-slate-200 px-3.5 py-2 font-semibold text-slate-700 transition hover:border-[#0D1282] hover:text-[#0D1282] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-700"
            >
              Previous
            </button>
            <span className="rounded-lg bg-[#0D1282]/10 px-3 py-2 font-semibold text-[#0D1282]">
              Page {safePage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
              disabled={safePage === totalPages}
              className="rounded-lg border border-slate-200 px-3.5 py-2 font-semibold text-slate-700 transition hover:border-[#0D1282] hover:text-[#0D1282] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-700"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete draft branch?"
          description={(
            <>
              <span className="font-semibold text-slate-900">{pendingDelete.name}</span>{" "}
              ({pendingDelete.code}) will be permanently removed. This cannot be undone.
            </>
          )}
          confirmLabel="Delete Draft"
          busyLabel="Deleting..."
          busy={deleting}
          onConfirm={handleDeleteDraft}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
