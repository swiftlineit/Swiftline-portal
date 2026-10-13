"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { applyPortalTheme, readPortalTheme } from "@/lib/portalTheme";

export default function PortalThemeController() {
  const pathname = usePathname();

  useEffect(() => {
    applyPortalTheme(readPortalTheme());
    const sync = () => applyPortalTheme(readPortalTheme());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [pathname]);

  return null;
}
