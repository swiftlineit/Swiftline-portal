"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FiPlus } from "react-icons/fi";
import {
  ClientDashboardLoading,
} from "@/components/client/ClientDashboardShell";
import DateRangeFilter from "@/components/ui/DateRangeFilter";
import { emptyDateRange } from "@/lib/dateRange";
import Pagination from "@/components/ui/Pagination";
import QuoteList from "@/components/quotes/QuoteList";
import { listShipmentQuotes, type ShipmentQuote, type ShipmentQuoteListInput } from "@/lib/shipmentQuotes";
import { useClientUser } from "@/lib/useClientUser";

const emptyPagination = { page: 1, limit: 20, total: 0, totalPages: 1 };

export default function ClientQuotesPage() {
  const { user, loading } = useClientUser();
  const [quotes, setQuotes] = useState<ShipmentQuote[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [dateRange, setDateRange] = useState(emptyDateRange);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [dataLoading, setDataLoading] = useState(true);

  const load = useCallback(async () => {
    setDataLoading(true);
    setError("");
    try {
      const input: ShipmentQuoteListInput = { dateRange, page };
      const result = await listShipmentQuotes("client", input);
      setQuotes(result.quotes);
      setPagination(result.pagination);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load quotes.");
    } finally {
      setDataLoading(false);
    }
  }, [dateRange, page]);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [load, user]);

  if (loading || !user) return <ClientDashboardLoading />;
  return (
      <div className="mx-auto max-w-8xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">
              Shipment Quotes
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Review estimates and branch-approved live quotes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DateRangeFilter
              value={dateRange}
              onChange={(value) => {
                setDateRange(value);
                setPage(1);
              }}
            />
            <Link
              href="/client/get-quote"
              className="inline-flex h-10 items-center gap-2 rounded-4xl bg-blue-950 px-4 text-sm font-semibold text-white hover:bg-blue-900"
            >
              <FiPlus />
              Get Quote
            </Link>
          </div>
        </div>
        {error ? (
          <div className="mb-5 border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
            {error}
          </div>
        ) : null}
        <QuoteList quotes={quotes} audience="client" loading={dataLoading} />
        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          onPageChange={setPage}
        />
      </div>
  );
}
