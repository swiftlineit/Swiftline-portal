"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { listMyAnnouncements, markAnnouncementSeen, type FeatureAnnouncement } from "@/lib/featureAnnouncements";
import WhatsNewModal from "./WhatsNewModal";

/** One prompt on dashboard entry; polling only updates badges while work is in progress. */
export function useWhatsNew(home: "/dashboard" | "/client/dashboard", allowPrompt = true, ready = true) {
  const pathname = usePathname();
  const [announcements, setAnnouncements] = useState<FeatureAnnouncement[]>([]);
  const [queue, setQueue] = useState<FeatureAnnouncement[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const previousPath = useRef<string | null>(null);
  const active = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const items = await listMyAnnouncements();
      if (active.current) { setAnnouncements(items); setNow(Date.now()); }
      return items;
    } catch { return null; }
  }, []);

  useEffect(() => {
    if (!ready) return;
    active.current = true;
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    return () => { active.current = false; window.clearTimeout(initial); window.clearInterval(interval); };
  }, [refresh, ready]);

  useEffect(() => {
    const nextEnd = announcements
      .map((item) => item.endsAt ? Date.parse(item.endsAt) : null)
      .filter((end): end is number => end !== null && end > now)
      .sort((left, right) => left - right)[0];
    if (nextEnd === undefined) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.max(0, nextEnd - now + 1));
    return () => window.clearTimeout(timeout);
  }, [announcements, now]);

  useEffect(() => {
    if (!ready) return;
    const entered = pathname === home && previousPath.current !== home;
    previousPath.current = pathname;
    if (!entered || !allowPrompt) return;
    let cancelled = false;
    void refresh().then((items) => {
      if (!cancelled && items?.some((item) => !item.seen)) setQueue(items.filter((item) => !item.seen));
    });
    return () => { cancelled = true; };
  }, [pathname, home, allowPrompt, ready, refresh]);

  const seen = useCallback(async (item: FeatureAnnouncement) => {
    try {
      await markAnnouncementSeen(item.id);
      setAnnouncements((current) => current.map((entry) => entry.id === item.id && entry.revision === item.revision ? { ...entry, seen: true } : entry));
    } catch { /* Keep the badge so the user can retry next visit. */ }
  }, []);

  const activeAnnouncements = announcements.filter((item) => item.status === "PUBLISHED"
    && (!item.startsAt || Date.parse(item.startsAt) <= now)
    && (!item.endsAt || Date.parse(item.endsAt) > now));

  return {
    badgeHrefs: activeAnnouncements.filter((item) => !item.seen).map((item) => item.targetHref),
    unreadCount: activeAnnouncements.filter((item) => !item.seen).length,
    available: activeAnnouncements.length > 0,
    open: () => { if (activeAnnouncements.length) setQueue(activeAnnouncements); },
    modal: queue ? <WhatsNewModal items={queue} onSeen={seen} onClose={() => setQueue(null)} /> : null
  };
}
