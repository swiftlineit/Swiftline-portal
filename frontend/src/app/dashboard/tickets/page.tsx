"use client";

import { useCallback, useEffect, useState } from "react";
import { FiRefreshCw, FiSearch } from "react-icons/fi";
import { DashboardLoading } from "@/components/DashboardShell";
import TicketTable from "@/components/tickets/TicketTable";
import { TableToolbar } from "@/components/ui/TableToolbar";
import {
  listSupportTickets,
  ticketListParams,
  ticketListPath,
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
  ticketStatusLabels,
  type SupportTicket,
} from "@/lib/supportTickets";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

export default function AdminTicketsPage() {
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setDataLoading(true);
    setError("");
    try {
      const result = await listSupportTickets("admin", {
        page,
        status,
        priority,
        category,
        search,
      });
      setTickets(result.tickets);
      setTotalPages(result.pagination.totalPages);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Support tickets could not be loaded.",
      );
    } finally {
      setDataLoading(false);
    }
  }, [category, page, priority, search, status]);
  useEffect(() => {
    if (user) void Promise.resolve().then(load);
  }, [load, user]);
  if (loading || !user) return <DashboardLoading />;
  return (
      <div className="mx-auto max-w-8xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-950">
            Support Tickets
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Review customer requests, respond, and update progress.
          </p>
        </div>
        <div className="mb-5 grid gap-3 border rounded-2xl border-slate-200 bg-white p-4 lg:grid-cols-[minmax(220px,1fr)_190px_160px_210px_auto]">
          <label className="relative">
            <span className="sr-only">Search tickets</span>
            <FiSearch className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Ticket number or subject"
              className="h-10 w-full border rounded-xl border-slate-300 pl-10 pr-3 text-sm outline-none focus:border-blue-900"
            />
          </label>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className="h-10 border rounded-xl border-slate-300 bg-white px-3 pr-9 text-sm"
          >
            <option value="">All Status</option>
            {ticketStatuses.map((value) => (
              <option key={value} value={value}>
                {ticketStatusLabels[value]}
              </option>
            ))}
          </select>
          <select
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value);
              setPage(1);
            }}
            className="h-10 border border-slate-300 rounded-xl bg-white px-3 pr-9 text-sm"
          >
            <option value="">All priorities</option>
            {ticketPriorities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              setPage(1);
            }}
            className="h-10 border border-slate-300 rounded-xl bg-white px-3 pr-9 text-sm"
          >
            <option value="">All categories</option>
            {ticketCategories.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          {/* <button
            type="button"
            onClick={() => void load()}
            title="Refresh tickets"
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-300 text-blue-900"
          >
            <FiRefreshCw className={dataLoading ? "animate-spin" : ""} />
          </button> */}
        </div>
        {error ? (
          <div className="mb-5 border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
            {error}
          </div>
        ) : null}
        <div className="mb-3">
          <TableToolbar
            exportPath={ticketListPath("admin")}
            exportParams={ticketListParams({ status, priority, category, search })}
            exportName="support-tickets"
          />
        </div>
        <TicketTable tickets={tickets} audience="admin" loading={dataLoading} />
        {totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
              className="h-9 border border-slate-300 px-3 text-sm font-semibold disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-sm text-slate-600">
              Page {page} of {totalPages}
            </span>
            <button
              disabled={page === totalPages}
              onClick={() => setPage(page + 1)}
              className="h-9 border border-slate-300 px-3 text-sm font-semibold disabled:opacity-40"
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
  );
}
