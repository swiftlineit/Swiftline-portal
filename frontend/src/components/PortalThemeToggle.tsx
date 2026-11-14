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
      role="switch"
      aria-label="Dark mode"
      aria-checked={dark}
      title={dark ? "Turn off dark mode" : "Turn on dark mode"}
      onClick={() => {
        const next = dark ? "light" : "dark";
        setTheme(next);
        savePortalTheme(next);
      }}
      className="inline-flex min-h-11 shrink-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282] focus-visible:ring-offset-2"
    >
      <span
        aria-hidden="true"
        className={`relative block h-9 w-16 rounded-full transition-colors duration-500 ease-in-out motion-reduce:transition-none ${dark ? "bg-[#263a61]" : "bg-[#8ed8f8]"}`}
      >
        <span
          className={`absolute left-1 top-1 flex h-7 w-7 items-center justify-center rounded-full shadow-sm transition-[transform,background-color] duration-500 ease-in-out motion-reduce:transition-none ${dark ? "translate-x-7 bg-[#0b1730]" : "translate-x-0 bg-[#ffd54a]"}`}
        >
          {dark ? <FiMoon className="h-4 w-4 text-[#ffd54a]" /> : <FiSun className="h-4 w-4 text-[#765200]" />}
        </span>
      </span>
    </button>
  );
}
