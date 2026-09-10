"use client";

import { useEffect, useRef } from "react";

export default function ProhibitedGoodsModal({ open, items, onClose }: { open: boolean; items: string[]; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="prohibited-title" className="max-h-[90dvh] w-full max-w-2xl overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div><p className="text-[11px] font-bold uppercase tracking-[0.14em] text-red-700">Safety and compliance</p><h2 id="prohibited-title" className="mt-1 text-xl font-bold text-slate-950">Prohibited and restricted goods</h2></div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Close</button>
        </div>
        <div className="max-h-[65dvh] overflow-y-auto px-5 py-5 sm:px-6">
          <p className="text-sm leading-6 text-slate-600">Do not book any item below. This summary does not replace route-specific law, aviation-security rules, customs controls or carrier restrictions. Contact Swiftline before paying if you are unsure.</p>
          <ul className="mt-5 grid gap-2 sm:grid-cols-2">
            {items.map((item) => (
              <li key={item} className="flex gap-2 rounded-lg border border-red-100 bg-red-50/60 px-3 py-2 text-sm text-red-950">
                <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-red-600" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
