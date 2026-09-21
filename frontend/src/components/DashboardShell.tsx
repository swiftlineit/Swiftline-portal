"use client";

import {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FiLogOut, FiMenu, FiUser } from "react-icons/fi";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { AuthenticatedUser } from "@/lib/useAdminUser";
import { logout } from "@/lib/auth";
import { readShipmentListScrollState, shipmentListAudienceForPath } from "@/lib/shipmentsList";
import SessionTimeoutGuard from "@/components/SessionTimeoutGuard";
import DeepLinkTarget from "@/components/DeepLinkTarget";
import NotificationBell from "@/components/NotificationBell";
import GlobalSearch from "@/components/client/GlobalSearch";
import OperationsCalendarIcon from "@/components/OperationsCalendarIcon";
import { loadProfileImageUrl } from "@/lib/profile";
import { ShellPortalBackButton } from "@/components/PortalBackButton";

// Shared chrome for every authenticated dashboard page: sidebar, header, and
// scrollable content area.
export default function DashboardShell({
  user,
  children,
}: {
  user: AuthenticatedUser;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const [profileImageUrl, setProfileImageUrl] = useState("");

  // Below `lg` the staff rail is an off-canvas drawer, the same one the client
  // shell uses. Stable callback: the sidebar keys a media-query listener on it.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(
    () => setMobileNavOpen(false),
    [],
  );

  const initials = (user.name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const fallbackInitials = initials.length
    ? `${initials[0][0] ?? ""}${
        initials.length > 1
          ? initials[initials.length - 1][0] ?? ""
          : ""
      }`.toUpperCase()
    : "";

  useEffect(() => {
    let objectUrl = "";
    let active = true;

    async function refreshProfileImage() {
      if (objectUrl) URL.revokeObjectURL(objectUrl);

      objectUrl = "";

      try {
        const url = await loadProfileImageUrl();
        objectUrl = url;

        if (active) setProfileImageUrl(url);
      } catch {
        if (active) setProfileImageUrl("");
      }
    }

    void refreshProfileImage();

    window.addEventListener(
      "profile-image-updated",
      refreshProfileImage,
    );

    return () => {
      active = false;

      window.removeEventListener(
        "profile-image-updated",
        refreshProfileImage,
      );

      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  // The dashboard uses an inner scroll container. Reset it on route changes so
  // a previously scrolled detail screen cannot hide the next page's heading.
  // The shipments list restores its own exact viewport when returning from a
  // detail page, so leave the scroller alone for that return trip - the list
  // replays the saved offset once its rows reload. A fresh drill-down link
  // with different filters still opens at the top.
  useEffect(() => {
    const audience = shipmentListAudienceForPath(pathname);
    if (audience) {
      const saved = readShipmentListScrollState(audience);
      if (saved && (!window.location.search || saved.search === window.location.search)) return;
    }
    contentScrollRef.current?.scrollTo({
      top: 0,
      behavior: "auto",
    });
  }, [pathname]);

  async function handleLogout() {
    await logout();
    router.replace("/");
  }

  return (
    <div className="fixed inset-0 flex h-dvh max-h-dvh flex-col overflow-hidden overscroll-none bg-[#EEEDED]/60">
      {/* Mounted inside the shell so it only ever runs for a signed-in user. */}
      <SessionTimeoutGuard />

      {/* Subtle brand accent above the dark application shell */}
      <div className="h-1 shrink-0 bg-[#0D1282]" />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          userRole={user.role}
          mobileOpen={mobileNavOpen}
          onMobileClose={closeMobileNav}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center gap-2 border-b border-white/10 bg-[#12185A] px-4 lg:h-20 lg:gap-4 lg:px-8">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open menu"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/[0.04] text-white transition-colors duration-200 hover:border-white/25 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/25 lg:hidden"
            >
              <FiMenu
                aria-hidden="true"
                className="h-5 w-5"
              />
            </button>

            {/* Staff search spans every account this user may see. */}
            <div className="hidden min-w-0 flex-1 lg:block">
              <GlobalSearch audience="staff" />
            </div>

            <div className="min-w-0 flex-1 lg:hidden" />

            {/* shrink-0 matters: without it the flexible search above squeezes
                these controls until the logout button is off the edge. */}
            <div className="flex shrink-0 items-center gap-2 lg:gap-4">
              {/* The only item here that is not a control, so it goes first when
                  width is short. */}
              <div className="hidden text-right md:block">
                <p className="text-sm font-semibold uppercase tracking-wide text-white">
                  {user.name || user.email}
                </p>

                <p className="mt-1 text-xs font-medium uppercase tracking-wide text-[#AEB4D9]">
                  {user.role} (
                  <span className="text-[#C7CBF4]">
                    s
                  </span>
                  <span className="text-white">L</span>
                  <span className="text-[#F87171]">
                    C
                  </span>
                  )
                </p>
              </div>

              <div className="group relative">
                <Link
                  href="/dashboard/profile"
                  aria-label="My Profile"
                  className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-white/15 bg-white transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-white/25"
                >
                  {profileImageUrl ? (
                    <Image
                      src={profileImageUrl}
                      alt={`${user.name || "User"} profile`}
                      width={40}
                      height={40}
                      unoptimized
                      className="h-full w-full rounded-full object-cover"
                    />
                  ) : fallbackInitials ? (
                    <span className="text-xs font-bold tracking-wide">
                      {fallbackInitials}
                    </span>
                  ) : (
                    <FiUser
                      aria-hidden="true"
                      className="h-5 w-5"
                    />
                  )}
                </Link>

                <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-[#05072B] px-3 py-2 text-xs font-medium text-white opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-1 group-hover:opacity-100">
                  My Profile

                  <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[#05072B]" />
                </div>
              </div>

              <OperationsCalendarIcon
                variant="staff"
                role={user.role}
              />

              <NotificationBell />

              <div className="group relative inline-flex">
                <button
                  onClick={handleLogout}
                  aria-label="Logout"
                  className="inline-flex h-10 items-center gap-2 rounded-full bg-[#D71313] px-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#b40f0f] focus:outline-none focus:ring-2 focus:ring-[#D71313]/50 focus:ring-offset-2 focus:ring-offset-[#12185A] sm:px-4"
                >
                  <FiLogOut
                    aria-hidden="true"
                    className="h-4 w-4"
                  />

                  <span className="hidden sm:inline">
                    Logout
                  </span>
                </button>

                <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-[#05072B] px-3 py-2 text-xs font-medium text-white opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-1 group-hover:opacity-100">
                  Sign out of your account

                  <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[#05072B]" />
                </div>
              </div>
            </div>
          </header>

          <div
            ref={contentScrollRef}
            data-dashboard-scroll
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [overflow-anchor:none] scrollbar-none [-ms-overflow-style:none] sm:px-8 sm:py-6 [&::-webkit-scrollbar]:hidden"
          >
            <div className="mb-4 flex items-center">
              <ShellPortalBackButton />
            </div>

            {children}
          </div>

          <DeepLinkTarget />
        </main>
      </div>

      {/* One instance per shell: the prompt is driven by a module-level registry
          that any open form writes to, so it must not be mounted per page. */}
      <UnsavedChangesDialog />
    </div>
  );
}

export function DashboardLoading({
  message = "Loading...",
}: {
  message?: string;
}) {
  // Fills the shell's content area. `min-h-screen` here was a full viewport
  // inside an area already shorter than one, which overflowed the scroller.
  return (
    <div className="flex h-full items-center justify-center bg-[#EEEDED]/60">
      <p className="text-sm font-semibold text-[#0D1282]">
        {message}
      </p>
    </div>
  );
}