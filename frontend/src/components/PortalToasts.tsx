"use client";

import { useEffect, useState } from "react";
import { ToastContainer } from "react-toastify";
import { isPortalThemePath, readPortalTheme, type PortalTheme } from "@/lib/portalTheme";

export default function PortalToasts() {
  const [theme, setTheme] = useState<PortalTheme>("light");

  useEffect(() => {
    const sync = () => setTheme(isPortalThemePath(window.location.pathname) ? readPortalTheme() : "light");
    sync();
    window.addEventListener("portal-theme-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("portal-theme-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return (
    <ToastContainer
      position="top-right"
      autoClose={3500}
      hideProgressBar
      newestOnTop
      closeOnClick
      pauseOnFocusLoss
      pauseOnHover
      theme={theme}
      toastClassName="border border-slate-200 rounded-none shadow-lg text-sm font-medium"
    />
  );
}
