"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import RateCardShareModal from "@/components/rate-cards/RateCardShareModal";
import {
  daysUntil,
  downloadClientRateCardShareDocument,
  formatShareDate,
  listClientRateCardShares,
  markClientRateCardShareRead,
  type RateCardShare,
} from "@/lib/rateCardShares";
import { FaTags } from "react-icons/fa6";

// Remembers which shares have already auto-opened, so a share cannot pop a
// second time if the read call failed or the client has two tabs open. Cleared
// against the live share list on every load so it cannot grow without bound.
const AUTO_OPENED_KEY = "swiftline.rateCards.autoOpened";

function readAutoOpened(): string[] {
  try {
    const stored = window.localStorage.getItem(AUTO_OPENED_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Private-browsing modes throw on storage access. Losing the guard only
    // means a share may greet the client once more, which is survivable.
    return [];
  }
}

function writeAutoOpened(ids: string[]) {
  try {
    window.localStorage.setItem(AUTO_OPENED_KEY, JSON.stringify(ids));
  } catch {
    // See readAutoOpened.
  }
}

/**
 * The client's rate card inbox: a header tray that glows while something is
 * unread, and auto-opens a rate card the very first time it arrives. Built as a
 * tray rather than a page so this shelf can carry other shared documents later
 * without adding another route each time.
 *
 * The button is dual-purpose: while the client holds at least one live share
 * it opens the tray; with nothing shared it is a plain link to the client's
 * own assigned rate card. Both destinations are server-scoped to the client's
 * accounts, so a client can only ever see what was shared with them.
 */
export default function RateCardTray() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shares, setShares] = useState<RateCardShare[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeShare, setActiveShare] = useState<RateCardShare | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await listClientRateCardShares();
      setShares(result.shares);
      setUnreadCount(result.unreadCount);
      setError("");
      return result.shares;
    } catch {
      setError("Rate cards could not be loaded.");
      return [];
    }
  }, []);

  const openShare = useCallback(async (share: RateCardShare) => {
    setActiveShare(share);
    setOpen(false);

    if (share.readAt) return;

    // Optimistic: the badge clears the moment the card is on screen, and a
    // failed write only means it reappears on the next poll.
    setUnreadCount((count) => Math.max(count - 1, 0));
    setShares((items) =>
      items.map((item) => (item.id === share.id ? { ...item, readAt: new Date().toISOString() } : item)),
    );

    await markClientRateCardShareRead(share.id).catch(() => undefined);
  }, []);

  // Load off the render pass, then greet the client with the newest live rate
  // card they have never seen. Only the newest- a backlog of five would
  // otherwise stack five modals on top of each other.
  useEffect(() => {
    let active = true;

    async function loadAndGreet() {
      const loaded = await load();
      if (!active || !loaded.length) return;

      const autoOpened = readAutoOpened();
      const liveIds = new Set(loaded.map((share) => share.id));
      const greeting = loaded.find(
        (share) => !share.readAt && !share.expired && !autoOpened.includes(share.id),
      );

      if (!greeting) {
        writeAutoOpened(autoOpened.filter((id) => liveIds.has(id)));
        return;
      }

      writeAutoOpened([...autoOpened.filter((id) => liveIds.has(id)), greeting.id]);
      await openShare(greeting);
    }

    const initialLoad = window.setTimeout(() => void loadAndGreet(), 0);
    const interval = window.setInterval(() => void load(), 120_000);

    return () => {
      active = false;
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [load, openShare]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function handleDownload(share: RateCardShare, format: "pdf" | "xlsx") {
    await downloadClientRateCardShareDocument(share.id, format, share.shareNumber);
  }

  const hasUnread = unreadCount > 0;

  // Only live shares earn the tray. Expired-only (or no) inboxes link straight
  // to the client's own assigned rate card instead of an empty dropdown.
  const hasLiveShares = shares.some((share) => !share.expired);

  const buttonClassName = `relative inline-flex h-10 items-center gap-2 rounded-4xl border-2 bg-white px-2.5 text-sm font-semibold transition sm:gap-2.5 sm:px-3.5 ${
    hasUnread
      ? "border-[#0D1282]/35 bg-[#0D1282]/4 text-[#0D1282] shadow-[0_0_0_3px_rgba(13,18,130,0.10)]"
      : "border-slate-300 text-slate-700 shadow-sm hover:border-[#ffffff] hover:bg-[#0D1282]/4 hover:text-[#ffffff]"
  }`;

  return (
    <>
      <div ref={containerRef} className="group relative">
        {hasLiveShares ? (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-label={hasUnread ? `Your Rate Card, ${unreadCount} unread` : "Your Rate Card"}
            aria-expanded={open}
            className={buttonClassName}
          >
            {/* A slow halo rather than a bouncing badge: enough to draw the eye on
                a page the client visits every day, not enough to nag. */}
            {hasUnread ? (
              <span
                aria-hidden="true"
                className="absolute inset-0 animate-ping rounded-xl bg-[#0D1282]/15 [animation-duration:2.4s]"
              />
            ) : null}

              <FaTags   className="h-4 w-4 text-red-500 " />
          

            <span className="relative hidden whitespace-nowrap sm:inline">Your Rate Card</span>

            {hasUnread ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#0D1282] px-1 text-[10px] font-bold text-white shadow-sm">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}
          </button>
        ) : (
          <Link
            href="/client/rate-card"
            aria-label="Your Rate Card"
            className={buttonClassName}
          >
              <FaTags   className="h-4 w-4 text-red-500 " />

            <span className="relative hidden whitespace-nowrap sm:inline">Your Rate Card</span>
          </Link>
        )}

        {open ? (
          <div className="fixed inset-x-4 top-[76px] z-50 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-96 sm:max-w-[calc(100vw-2rem)]">
            <div className="flex h-12 items-center justify-between border-b border-slate-200 bg-slate-50 px-4">
              <p className="text-sm font-semibold text-slate-950">Shared with you</p>
              {hasUnread ? (
                <span className="rounded-full bg-[#0D1282]/10 px-2.5 py-1 text-[11px] font-bold text-[#0D1282]">
                  {unreadCount} new
                </span>
              ) : null}
            </div>

            <div className="max-h-96 overflow-y-auto">
              {error ? <p className="p-4 text-sm text-red-700">{error}</p> : null}

              {!error && !shares.length ? (
                <p className="p-6 text-center text-sm text-slate-500">
                  No rate cards have been shared with you yet.
                </p>
              ) : null}

              {shares.map((share) => (
                <TrayItem key={share.id} share={share} onOpen={() => void openShare(share)} />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {activeShare ? (
        <RateCardShareModal
          share={activeShare}
          recipientLabel={activeShare.recipientAccounts[0]?.companyName || "Valued Customer"}
          onClose={() => setActiveShare(null)}
          onDownload={(format) => handleDownload(activeShare, format)}
        />
      ) : null}
    </>
  );
}

function TrayItem({ share, onOpen }: { share: RateCardShare; onOpen: () => void }) {
  const countryCount = new Set(share.rows.map((row) => row.countryCode)).size;
  const remainingDays = daysUntil(share.terms.validUntil);
  const unread = !share.readAt;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`block w-full border-b border-slate-100 px-4 py-3 text-left transition last:border-0 hover:bg-slate-50 ${
        unread && !share.expired ? "bg-[#0D1282]/[0.04]" : "bg-white"
      }`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950">{share.title}</span>
        {unread && !share.expired ? (
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#0D1282]" aria-label="Unread" />
        ) : null}
      </span>

      <span className="mt-1 block text-xs text-slate-600">
        {countryCount} {countryCount === 1 ? "destination" : "destinations"} · {share.rows.length}{" "}
        {share.rows.length === 1 ? "slab" : "slabs"}
      </span>

      <span className="mt-1.5 flex items-center gap-2 text-[11px] font-medium">
        {share.historical ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">Historical</span> : null}
        <span className="font-mono text-slate-400">{share.shareNumber}</span>
        <span
          className={`rounded-full px-2 py-0.5 ${
            share.expired
              ? "bg-slate-100 text-slate-500"
              : remainingDays <= 7
                ? "bg-amber-100 text-amber-800"
                : "bg-emerald-100 text-emerald-800"
          }`}
        >
          {share.expired
            ? "Expired"
            : remainingDays <= 7
              ? `${remainingDays}d left`
              : `Valid to ${formatShareDate(share.terms.validUntil)}`}
        </span>
      </span>
    </button>
  );
}
