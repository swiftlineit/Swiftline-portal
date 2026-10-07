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
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/[0.06] text-white transition-colors hover:border-white/40 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
    >
      {dark ? <FiSun aria-hidden="true" className="h-5 w-5" /> : <FiMoon aria-hidden="true" className="h-5 w-5" />}
    </button>
  );
}
