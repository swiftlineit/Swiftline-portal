export const PORTAL_THEME_STORAGE_KEY = "swiftline-portal-theme";

export type PortalTheme = "light" | "dark";

export function isPortalThemePath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/")
    || pathname === "/client" || pathname.startsWith("/client/");
}

export function readPortalTheme(): PortalTheme {
  try {
    return window.localStorage.getItem(PORTAL_THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return document.documentElement.dataset.portalTheme === "dark" ? "dark" : "light";
  }
}

export function applyPortalTheme(theme: PortalTheme): void {
  const root = document.documentElement;
  if (isPortalThemePath(window.location.pathname) && theme === "dark") {
    root.dataset.portalTheme = "dark";
  } else {
    delete root.dataset.portalTheme;
  }
  window.dispatchEvent(new Event("portal-theme-change"));
}

export function savePortalTheme(theme: PortalTheme): void {
  try {
    window.localStorage.setItem(PORTAL_THEME_STORAGE_KEY, theme);
  } catch {
    // The toggle still works for this page if storage is unavailable.
  }
  applyPortalTheme(theme);
}
