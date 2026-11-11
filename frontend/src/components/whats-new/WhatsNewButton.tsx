"use client";

import { MdOutlineTipsAndUpdates } from "react-icons/md";

export default function WhatsNewButton({ unreadCount, onClick }: { unreadCount: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      aria-label={`What's new${unreadCount ? `, ${unreadCount} unread update${unreadCount === 1 ? "" : "s"}` : ""}`}
      title="What's new"
      className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700 transition-colors hover:border-blue-800 hover:bg-slate-50 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F0DE36]">
      <MdOutlineTipsAndUpdates aria-hidden="true" className="h-6 w-6" />
      {unreadCount ? (
        <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[#F0DE36] px-1 text-center text-[10px] font-bold leading-4 text-[#12185A]">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      ) : null}
    </button>
  );
}
