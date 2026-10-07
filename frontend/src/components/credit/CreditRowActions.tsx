"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FiChevronDown, FiMoreHorizontal } from "react-icons/fi";

export type CreditRowAction = {
  label: string;
  icon: React.ReactNode;
  href?: string;
  onClick?: () => void;
  /** Destructive actions are set apart in red; everything else reads the same. */
  danger?: boolean;
  disabled?: boolean;
};

/**
 * The per-row action menu for the credit accounts table.
 *
 * These were six separate buttons wrapped into a grid, which made every row as
 * tall as the longest action list and left the table hard to scan. Collapsing
 * them behind one trigger keeps rows uniform.
 *
 * The menu is positioned `fixed` against the trigger's measured rectangle
 * rather than absolutely: the table scrolls inside `overflow-x-auto`, and an
 * absolutely positioned menu is clipped by that container.
 */
export default function CreditRowActions({ actions }: { actions: CreditRowAction[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Same popover behaviour as the header chrome: any click outside, or Escape,
  // dismisses it.
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    // Re-measuring is not worth it while scrolling, so the menu closes instead
    // of drifting away from its row.
    function handleScroll() {
      setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open]);

  function toggle() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setOpen((value) => !value);
  }

  const visible = actions.filter((action) => !action.disabled || action.onClick);
  if (!visible.length) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="portal-theme-action inline-flex h-8 items-center gap-1 rounded-4xl border border-[#0D1282] px-2.5 text-[11px] font-semibold text-[#0D1282] transition hover:bg-slate-50"
      >
        <FiMoreHorizontal size={13} aria-hidden="true" />
        Actions
        <FiChevronDown size={12} aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          style={{ top: position.top, right: position.right }}
        >
          {visible.map((action) => {
            const className = `flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold transition hover:bg-slate-50 disabled:opacity-50 ${
              action.danger ? "text-red-700 hover:bg-red-50" : "text-slate-700"
            }`;

            if (action.href) {
              return (
                <Link
                  key={action.label}
                  href={action.href}
                  role="menuitem"
                  className={className}
                  onClick={() => setOpen(false)}
                >
                  {action.icon}
                  {action.label}
                </Link>
              );
            }

            return (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                disabled={action.disabled}
                className={className}
                onClick={() => {
                  setOpen(false);
                  action.onClick?.();
                }}
              >
                {action.icon}
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
