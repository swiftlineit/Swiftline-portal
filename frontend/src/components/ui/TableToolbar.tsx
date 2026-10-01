"use client";

import { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiColumns, FiDownload, FiFileText } from "react-icons/fi";
import { toast } from "react-toastify";
import { downloadTableExport, type TableExportFormat } from "@/lib/tableExport";

/**
 * The controls every portal table shares: export and column selection.
 *
 * One component rather than per-table copies, so a customer learns the buttons
 * once. Sorting lives on the column headers instead of here- a sort control
 * detached from the column it sorts is harder to read than an arrow on the
 * heading itself.
 */

/**
 * Page sizes on offer. 20 stays first because it is the size every list has
 * always opened at; the larger two are for working a whole day's shipments
 * without paging through them.
 */
export const defaultPageSizeOptions = [30, 50, 100];

export type TableColumnOption = {
  /** Stable key, also what the hidden set stores. */
  key: string;
  label: string;
  /** Columns the table cannot function without, so they cannot be hidden. */
  locked?: boolean;
};

export function TableToolbar({
  exportPath,
  exportParams,
  exportName,
  columns,
  hiddenColumns,
  onHiddenColumnsChange,
  pageSize,
  pageSizeOptions = defaultPageSizeOptions,
  onPageSizeChange,
  rowCount,
  children
}: {
  /** List endpoint path; the export adds `format` to these same filters. */
  exportPath?: string;
  exportParams?: URLSearchParams;
  exportName?: string;
  columns?: TableColumnOption[];
  hiddenColumns?: Set<string>;
  onHiddenColumnsChange?: (next: Set<string>) => void;
  /**
   * Rows per page. Both of these are supplied together or not at all- a table
   * whose page size is fixed simply omits them and the control is not rendered.
   */
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (next: number) => void;
  /** Total matching rows, so the export can warn when it will be capped. */
  rowCount?: number;
  /** Filters and search, rendered to the left of the shared controls. */
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState<TableExportFormat | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // A dropdown that ignores clicks elsewhere on the page reads as stuck.
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  async function runExport(format: TableExportFormat) {
    if (!exportPath) return;
    setBusy(format);
    try {
      await downloadTableExport({
        path: exportPath,
        params: exportParams ?? new URLSearchParams(),
        format,
        fallbackName: exportName ?? "swiftline-export"
      });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The export could not be generated.");
    } finally {
      setBusy(null);
    }
  }

  const selectable = (columns ?? []).filter((column) => !column.locked);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>

      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange ? (
          <label className="inline-flex h-10 items-center gap-2 rounded-4xl border border-slate-300 pl-4 pr-2 text-sm font-semibold text-slate-700">
            <span className="whitespace-nowrap text-slate-500">Rows per page</span>
            <select
              value={pageSize ?? pageSizeOptions[0]}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              aria-label="Rows per page"
              className="h-8 cursor-pointer rounded-3xl bg-transparent pl-1 pr-6 text-sm font-semibold text-slate-900 outline-none"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ) : null}

        {selectable.length ? (
          <div className="relative" ref={pickerRef}>
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              aria-expanded={pickerOpen}
              className="inline-flex h-10 items-center gap-2 rounded-4xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              <FiColumns aria-hidden="true" className="h-4 w-4" />
              Columns
              <FiChevronDown aria-hidden="true" className="h-4 w-4 text-slate-400" />
            </button>
            {pickerOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-60 rounded-2xl border border-slate-200 bg-white p-2 shadow-lg">
                <p className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Show columns
                </p>
                <div className="max-h-72 overflow-y-auto">
                  {selectable.map((column) => {
                    const visible = !hiddenColumns?.has(column.key);
                    return (
                      <label
                        key={column.key}
                        className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={visible}
                          onChange={() => {
                            const next = new Set(hiddenColumns ?? []);
                            if (visible) next.add(column.key); else next.delete(column.key);
                            onHiddenColumnsChange?.(next);
                          }}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        {column.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {exportPath ? (
          <>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void runExport("xlsx")}
              className="inline-flex h-10 items-center gap-2 rounded-4xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              <FiDownload aria-hidden="true" className="h-4 w-4" />
              {busy === "xlsx" ? "Preparing…" : "Export Excel"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void runExport("pdf")}
              className="inline-flex h-10 items-center gap-2 rounded-4xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              <FiFileText aria-hidden="true" className="h-4 w-4" />
              {busy === "pdf" ? "Preparing…" : "Download PDF"}
            </button>
          </>
        ) : null}
      </div>

      {/* Said before the click, not after a truncated file has been saved. */}
      {exportPath && typeof rowCount === "number" && rowCount > 10_000 ? (
        <p className="w-full text-xs text-amber-700">
          {rowCount.toLocaleString()} rows match. An export includes the first 10,000-
          narrow the date range to capture the rest.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A sortable column heading.
 *
 * Only rendered on columns the server can actually order by. A table where
 * some headings sort and others do not is clearer than one where every heading
 * looks clickable and half of them quietly reorder a single page.
 */
export function SortableHeader({
  label,
  sortKey,
  active,
  direction,
  onSort,
  className = ""
}: {
  label: string;
  sortKey: string;
  active: boolean;
  direction: "asc" | "desc";
  onSort: (key: string, direction: "asc" | "desc") => void;
  className?: string;
}) {
  const next = active && direction === "desc" ? "asc" : "desc";

  return (
    <th className={`px-4 py-3 ${className}`} aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(sortKey, next)}
        className={`inline-flex items-center gap-1 font-semibold uppercase transition hover:text-slate-900 ${active ? "text-slate-900" : ""}`}
      >
        {label}
        <span aria-hidden="true" className={active ? "text-blue-900" : "text-slate-300"}>
          {active && direction === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}
