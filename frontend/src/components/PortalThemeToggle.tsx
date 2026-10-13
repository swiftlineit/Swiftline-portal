"use client";

import { useEffect, useState } from "react";
import { FiMoon, FiSun } from "react-icons/fi";
import { readPortalTheme, savePortalTheme, type PortalTheme } from "@/lib/portalTheme";

export default function PortalThemeToggle() {
  const [theme, setTheme] = useState<PortalTheme>("light");

  useEffect(() => {
    const sync = () => setTheme(readPortalTheme());
    sync();
    window.addEventListener("portal-theme-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("portal-theme-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const dark = theme === "dark";
  return (
    <button
      type="button"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={dark}
      onClick={() => {
        const next = dark ? "light" : "dark";
        setTheme(next);
        savePortalTheme(next);
      }}
      className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]"
    >
      {dark ? <FiSun aria-hidden="true" className="h-4 w-4" /> : <FiMoon aria-hidden="true" className="h-4 w-4" />}
      <span>{dark ? "Switch to light mode" : "Switch to dark mode"}</span>
    </button>
  );
}
