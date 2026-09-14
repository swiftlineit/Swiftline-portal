"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FiArrowLeft } from "react-icons/fi";
import { allowNextBrowserBack, requestLeave } from "@/lib/useUnsavedChanges";
import {
  getFallbackForPath,
  resolveBackTarget,
  isPortalNavigating,
  setPortalNavigating,
} from "@/lib/portalNavigation";

type PortalBackButtonProps = {
  /** Override the inferred fallback (e.g. a filtered list with query params). */
  fallbackHref?: string;
  /** Optional label for screen readers – defaults to “Go back”. */
  ariaLabel?: string;
  /** Hide the button on exact area roots etc. Caller may also conditionally not mount. */
  hidden?: boolean;
  className?: string;
};

/**
 * Single reusable Back control for the portal.
 *
 * - 40px min target (44 on touch), icon-only, consistent hover/focus.
 * - `router.back()` when there is portal history; safe fallback otherwise.
 * - Honors the shared unsaved-changes registry (`Save Draft / Discard / Stay`),
 *   including bubble to the dialog that `requestLeave` opens in the shell.
 * - Re-entry protected: double click / popstate racing click does nothing.
 */
export default function PortalBackButton({
  fallbackHref,
  ariaLabel = "Go back",
  hidden = false,
  className,
}: PortalBackButtonProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [busy, setBusy] = useState(false);

  const fallback = fallbackHref ?? getFallbackForPath(pathname);

  const handleClick = useCallback(async () => {
    if (busy || isPortalNavigating()) return;
    setPortalNavigating(true);
    setBusy(true);
    try {
      const canLeave = await requestLeave();
      if (!canLeave) return;

      const target = resolveBackTarget(pathname, fallback);
      if (target.kind === "back") {
        // Real browser history – keeps filters/query strings and the actual page
        // sequence. `router.back` stays inside Next’s client navigation.
        allowNextBrowserBack();
        router.back();
      } else {
        // No in-portal history or external entry – go to the safe fallback.
        // `push` is correct here: a replace would hide that the user was ever on
        // the detail page and break forward navigation expectations.
        router.push(target.href);
      }
    } finally {
      setBusy(false);
      // Release after a short debounce so a rapid second click still collapses.
      window.setTimeout(() => setPortalNavigating(false), 300);
    }
  }, [busy, fallback, pathname, router]);

  if (hidden) return null;

  // The button is rendered even on top-level pages per plan (“mount shell-wide”)
  // but callers may pass `hidden` to suppress it on exact roots if desired.
  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={
        className ??
        "inline-flex h-9 min-w-[96px] shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white pr-2 text-sm font-semibold text-[#0D1282] shadow-sm transition hover:border-[#0D1282]/30 hover:bg-[#0D1282]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      }
    >
      <FiArrowLeft aria-hidden="true" className="h-4 w-4" />
      <span>Back</span>
    </button>
  );
}

/**
 * Shell helper: every authenticated portal route gets the same control. On a
 * direct entry at an area root there is no safe previous page, so the shared
 * resolver simply keeps the user on that root; after in-portal navigation it
 * follows the real browser history.
 */
export function ShellPortalBackButton(
  props: Omit<PortalBackButtonProps, "hidden">,
) {
  const pathname = usePathname() ?? "";
  // The main staff and client dashboards are entry points, not detail pages.
  // Keep the control on every other authenticated route, including collection
  // roots and create/manage pages.
  if (pathname === "/dashboard" || pathname === "/client/dashboard")
    return null;
  return <PortalBackButton {...props} hidden={false} />;
}
