"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FiBell, FiCheck } from "react-icons/fi";
import { announceDeepLink } from "@/lib/deepLink";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type PortalNotification,
} from "@/lib/notifications";

function relativeTime(value: string) {
  const minutes = Math.max(
    Math.floor((Date.now() - new Date(value).getTime()) / 60_000),
    0,
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export default function NotificationBell() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<PortalNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState("");

  /**
   * Unread notifications grouped into the handful of things a customer acts on.
   *
   * Matched on the notification type rather than a stored category, so a type
   * added later simply falls outside the summary instead of needing this list
   * kept in step to keep working.
   */
  const unreadSummary = (() => {
    const unread = notifications.filter((notification) => !notification.readAt);
    const groups = [
      { label: "Action required", className: "border-red-200 bg-red-50 text-red-700", match: /DOCUMENTS_REQUIRED|ACTION_REQUIRED|INFORMATION_REQUESTED|BANK_DETAILS_REQUIRED|ACCEPTANCE_REQUIRED/ },
      { label: "Customs holds", className: "border-amber-200 bg-amber-50 text-amber-800", match: /HOLD|CUSTOMS/ },
      { label: "Delivery exceptions", className: "border-amber-200 bg-amber-50 text-amber-800", match: /DELIVERY|POD_DISPUTED|PICKUP_CANCELLED/ },
      { label: "Claim updates", className: "border-violet-200 bg-violet-50 text-violet-800", match: /^CLAIM_/ },
      { label: "Payments due", className: "border-red-200 bg-red-50 text-red-700", match: /PAYMENT_DUE|PAYMENT_OVERDUE|STATEMENT_ISSUED/ },
    ];

    return groups
      .map((group) => ({
        ...group,
        count: unread.filter((notification) => group.match.test(notification.type)).length,
      }))
      .filter((group) => group.count > 0);
  })();

  const load = useCallback(async () => {
    try {
      const result = await listNotifications();
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
      setError("");
    } catch {
      setError("Notifications could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 60_000);

    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [load]);

  // The panel is a popover, not a modal: a click anywhere outside it or Escape
  // dismisses it, matching how the rest of the header chrome behaves.
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

  async function openNotification(notification: PortalNotification) {
    if (!notification.readAt) {
      await markNotificationRead(notification.id);
      setUnreadCount((count) => Math.max(count - 1, 0));
      setNotifications((items) =>
        items.map((item) =>
          item.id === notification.id
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      );
    }

    setOpen(false);
    router.push(notification.href);
    // Section-targeted hrefs that resolve to the page already on screen change
    // only the fragment, which raises no navigation event, so the shell is told
    // to re-resolve it. Hrefs without a fragment make this a no-op.
    announceDeepLink();
  }

  async function readAll() {
    await markAllNotificationsRead();
    const readAt = new Date().toISOString();

    setUnreadCount(0);
    setNotifications((items) =>
      items.map((item) => ({
        ...item,
        readAt: item.readAt || readAt,
      })),
    );
  }

  return (
    <div ref={containerRef} className="relative group">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Notifications"
        aria-expanded={open}
        className="relative flex h-10 w-10 items-center justify-center rounded-4xl border border-slate-300 bg-white text-slate-700 transition hover:border-blue-800 hover:text-blue-900"
      >
        <FiBell className="h-4 w-4" />

        {unreadCount ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {!open && (
        <div
          className="
            pointer-events-none absolute left-1/2 top-full z-50 mt-2
            -translate-x-1/2 whitespace-nowrap rounded-lg
            bg-slate-900 px-3 py-2 text-xs font-medium text-white
            opacity-0 shadow-xl transition-all duration-200
            group-hover:translate-y-1 group-hover:opacity-100
          "
        >
          Notifications
          <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-slate-900" />
        </div>
      )}

      {open ? (
        <div className="fixed inset-x-4 top-[76px] z-50 border border-slate-200 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-90 sm:max-w-[calc(100vw-2rem)]">
          <div className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
            <p className="text-sm font-semibold text-slate-950">
              Notifications
            </p>

            {unreadCount ? (
              <button
                type="button"
                onClick={() => void readAll()}
                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-900"
              >
                <FiCheck />
                Mark all read
              </button>
            ) : null}
          </div>

          {/* A summary of what is unread, above the list itself.
              Twelve rows do not tell you at a glance that two are customs
              holds; a count of each kind does. */}
          {unreadSummary.length ? (
            <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2.5">
              {unreadSummary.map((group) => (
                <span
                  key={group.label}
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${group.className}`}
                >
                  {group.count} {group.label}
                </span>
              ))}
            </div>
          ) : null}

          <div className="max-h-90 overflow-y-auto">
            {error ? (
              <p className="p-4 text-sm text-red-700">{error}</p>
            ) : null}

            {!error && !notifications.length ? (
              <div className="px-6 py-8 text-center">
                <p className="text-sm font-semibold text-slate-700">You are all caught up</p>
                <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-slate-500">
                  Holds, delivery exceptions, claim decisions, payment reminders and replies from
                  Swiftline all arrive here.
                </p>
              </div>
            ) : null}

            {notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => void openNotification(notification)}
                className={`block w-full border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-slate-50 ${
                  notification.readAt ? "bg-white" : "bg-blue-50"
                }`}
              >
                <span className="block text-sm font-semibold text-slate-950">
                  {notification.title}
                </span>

                <span className="mt-1 block text-xs leading-5 text-slate-600">
                  {notification.message}
                </span>

                <span className="mt-1 block text-[11px] font-medium text-slate-400">
                  {relativeTime(notification.createdAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}