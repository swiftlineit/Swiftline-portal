type Props = { page: number; totalPages: number; onPageChange: (page: number) => void; busy?: boolean; label: string };

export default function PaymentPagination({ page, totalPages, onPageChange, busy, label }: Props) {
  return (
    <nav aria-label={label} className="mt-auto flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-xs text-slate-600">
      <span>Page {page} of {totalPages}</span>
      <div className="flex gap-2">
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={busy || page <= 1} className="h-8 rounded-md border border-slate-300 px-3 font-semibold hover:bg-slate-50 disabled:opacity-40">Previous</button>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={busy || page >= totalPages} className="h-8 rounded-md border border-slate-300 px-3 font-semibold hover:bg-slate-50 disabled:opacity-40">Next</button>
      </div>
    </nav>
  );
}
