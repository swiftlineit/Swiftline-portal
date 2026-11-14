"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FiInfo } from "react-icons/fi";

// Must match the w-56 on the bubble below; used to decide whether it fits.
const tooltipWidth = 224;
const viewportMargin = 8;

const alignmentClasses = {
  center: "left-1/2 -translate-x-1/2",
  left: "left-0",
  right: "right-0"
} as const;

const arrowClasses = {
  center: "left-1/2 -translate-x-1/2",
  left: "left-3",
  right: "right-3"
} as const;

/**
 * Help bubble shown beside a field, button, or technical term.
 *
 * Opens three ways so it works on every device: hover and keyboard focus are
 * handled in CSS (`group-hover` / `group-focus-within`), while a tap toggles
 * `open`. Touch devices fire focus *and* click from one tap, so the tap path
 * deliberately keeps its own state instead of toggling on focus- otherwise the
 * click would immediately close what the focus just opened.
 */
export default function InfoTooltip({
  text,
  className = "",
  placement = "auto"
}: {
  text: string;
  className?: string;
  /** Position the tooltip bubble relative to its trigger, or choose automatically. */
  placement?: "auto" | "left" | "right";
}) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [alignment, setAlignment] = useState<"center" | "left" | "right">("center");
  const tooltipId = useId();

  /**
   * Keeps the bubble on screen.
   *
   * Centred on its icon it would hang off a narrow viewport whenever the icon
   * sits near an edge- which happens on a phone as soon as a label is even
   * moderately long. Measured on hover and on tap rather than in an effect, so
   * the position is already correct on the first paint that shows it.
   */
  function updateAlignment() {
    const rect = containerRef.current?.getBoundingClientRect();

    if (!rect) return;

    if (placement === "left" && rect.right - tooltipWidth >= viewportMargin) {
      setAlignment("right");
      return;
    }
    if (placement === "right" && rect.left + tooltipWidth <= window.innerWidth - viewportMargin) {
      setAlignment("left");
      return;
    }

    const iconCentre = rect.left + rect.width / 2;
    const halfWidth = tooltipWidth / 2;

    if (iconCentre - halfWidth < viewportMargin) setAlignment("left");
    else if (iconCentre + halfWidth > window.innerWidth - viewportMargin) setAlignment("right");
    else setAlignment("center");
  }

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

  return (
    <span
      ref={containerRef}
      onMouseEnter={updateAlignment}
      onFocus={updateAlignment}
      className={`group relative inline-flex items-center ${className}`}
    >
      <button
        type="button"
        aria-label={text}
        aria-expanded={open}
        aria-describedby={tooltipId}
        onClick={() => {
          updateAlignment();
          setOpen((current) => !current);
        }}
        className="inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full text-slate-400 outline-none transition-colors hover:text-[#0D1282] focus-visible:ring-2 focus-visible:ring-[#F0DE36]/60"
      >
        <FiInfo aria-hidden="true" className="h-3.5 w-3.5" />
      </button>

      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium normal-case leading-5 text-slate-700 shadow-xl ${
          alignmentClasses[alignment]
        } ${open ? "block" : "hidden group-hover:block group-focus-within:block"}`}
      >
        <span className={`absolute -top-1 h-2.5 w-2.5 rotate-45 border-l border-t border-slate-200 bg-white ${arrowClasses[alignment]}`} />
        {text}
      </span>
    </span>
  );
}
