"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiChevronDown, FiGrid, FiLogOut, FiSearch, FiSettings, FiUser } from "react-icons/fi";
import { logout } from "@/lib/auth";
import { getOperatorProfile, getProfile, loadProfileImageUrl, profileHref, type ProfileUser } from "@/lib/profile";
import { loadOperatorCompanyLogo } from "@/lib/operatorSettings";
import { getOperatorSession, type OperatorSession } from "@/lib/operatorDirectory";
import NotificationBell from "@/components/NotificationBell";
import { OperatorHeaderNavigation } from "@/components/operators/OperatorWorkspaceNavigation";

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0]?.slice(0, 2) || "OP").toUpperCase();
}

function formatRole(role: OperatorSession["membership"]["role"]): string {
  return {
    OPERATOR_ADMIN: "Operator administrator",
    OPERATIONS: "Operations",
    FINANCE: "Finance",
    CLIENT: "Business account client"
  }[role];
}

export default function OperatorPortalHeader({ operatorSlug }: { operatorSlug: string }) {
  const router = useRouter();
  const profileMenuRef = useRef<HTMLDetailsElement | null>(null);
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [profile, setProfile] = useState<ProfileUser | null>(null);
  const [profileImageUrl, setProfileImageUrl] = useState("");
  const [profileImageVersion, setProfileImageVersion] = useState(0);
  const [operatorLogoUrl, setOperatorLogoUrl] = useState("");

  useEffect(() => {
    function closeOnOutsidePress(event: PointerEvent) {
      const menu = profileMenuRef.current;
      if (menu?.open && !menu.contains(event.target as Node | null)) menu.open = false;
    }

    function closeOnEscape(event: KeyboardEvent) {
      const menu = profileMenuRef.current;
      if (event.key !== "Escape" || !menu?.open) return;
      menu.open = false;
      menu.querySelector("summary")?.focus();
      event.preventDefault();
    }

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let logoObjectUrl = "";

    void getOperatorSession(operatorSlug, controller.signal).then((session) => {
      if (!active) return;
      setOperator(session);
      const loadProfile = session.membership.role === "CLIENT"
        ? getOperatorProfile(operatorSlug)
        : getProfile();
      void loadProfile.then((result) => {
        if (!active) return;
        setProfile(result.user);
        if (!result.user.hasProfileImage) setProfileImageUrl("");
      }).catch(() => {
        if (active) {
          setProfile(null);
          setProfileImageUrl("");
        }
      });
    }).catch(() => {
      if (active) {
        setOperator(null);
        setProfile(null);
      }
    });

    void loadOperatorCompanyLogo(operatorSlug, controller.signal).then((url) => {
      if (!url) return;
      if (!active) {
        URL.revokeObjectURL(url);
        return;
      }
      logoObjectUrl = url;
      setOperatorLogoUrl(url);
    }).catch(() => {
      if (active) setOperatorLogoUrl("");
    });

    return () => {
      active = false;
      controller.abort();
      if (logoObjectUrl) URL.revokeObjectURL(logoObjectUrl);
    };
  }, [operatorSlug]);

  useEffect(() => {
    const refreshImage = () => setProfileImageVersion((version) => version + 1);
    window.addEventListener("profile-image-updated", refreshImage);
    return () => window.removeEventListener("profile-image-updated", refreshImage);
  }, []);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (!profile?.hasProfileImage) return;

    void loadProfileImageUrl().then((url) => {
      if (!active) {
        URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      setProfileImageUrl(url);
    }).catch(() => {
      if (active) setProfileImageUrl("");
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [profile?.hasProfileImage, profileImageVersion]);

  async function handleSignOut() {
    try {
      await logout();
    } finally {
      router.replace("/");
    }
  }

  const profileRole = profile?.role.toLowerCase() === "client" || operator?.membership.role === "CLIENT" ? "client" : "admin";
  const operatorName = operator?.operator.companyName || "Operator";
  const profileUrl = operator?.membership.role === "CLIENT"
    ? `/portal/${encodeURIComponent(operatorSlug)}/profile`
    : operator?.access.mode === "MEMBER"
      ? `${profileHref(profileRole)}?operatorSlug=${encodeURIComponent(operatorSlug)}`
      : profileHref(profileRole);
  const canSwitchWorkspace = operator?.access.mode === "MEMBER"
    && operator.membership.role !== "CLIENT"
    && profileRole === "client";
  const canManageSettings = Boolean(operator
    && ["OPERATOR_ADMIN", "OPERATIONS"].includes(operator.membership.role)
    && operator.access.mode === "MEMBER"
    && !operator.access.readOnly);

  return (
    <header className="relative z-30 min-h-20 border-b border-slate-200 bg-white">
      <div data-operator-header-content className="mx-auto grid max-w-[1440px] grid-cols-[56px_minmax(0,1fr)_auto] grid-rows-[56px_56px_auto] items-center gap-x-2 gap-y-2 px-3 py-2 sm:gap-x-4 sm:px-6 lg:px-8 xl:grid-cols-[56px_minmax(200px,1fr)_auto_auto] xl:grid-rows-1 xl:gap-x-3 xl:py-3">
        <Link
          href={`/portal/${encodeURIComponent(operatorSlug)}`}
          aria-label={`${operatorName} workspace home`}
          className="col-start-1 row-start-1 flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#0D1282]"
        >
          {operatorLogoUrl ? (
            <Image src={operatorLogoUrl} alt="" width={56} height={56} unoptimized className="h-full w-full object-contain" />
          ) : null}
        </Link>

        <div className="relative col-span-full row-start-2 min-w-0 xl:col-span-1 xl:col-start-2 xl:row-start-1">
          <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            aria-label="Search workspace"
            placeholder="Search workspace"
            autoComplete="off"
            className="h-14 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#0D1282] focus:bg-white focus:ring-2 focus:ring-[#0D1282]/10"
          />
        </div>

        {operator ? (
          <div className="col-span-full row-start-3 min-w-0 xl:col-span-1 xl:col-start-3 xl:row-start-1">
            <OperatorHeaderNavigation operator={operator} operatorSlug={operatorSlug} />
          </div>
        ) : null}

        <div className="relative col-span-2 col-start-2 row-start-1 flex shrink-0 items-center justify-end gap-2 sm:static sm:gap-3 xl:col-span-1 xl:col-start-4 xl:row-start-1">
        <details ref={profileMenuRef} className="group shrink-0 sm:relative">
          <summary aria-label="Account profile and options" className="flex h-14 cursor-pointer list-none items-center gap-2 rounded-lg border border-slate-200 bg-white p-1.5 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] [&::-webkit-details-marker]:hidden sm:gap-3 sm:pl-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#0D1282]/[0.07] text-xs font-semibold text-[#0D1282]">
              {profileImageUrl ? (
                <Image src={profileImageUrl} alt="" width={36} height={36} unoptimized className="h-full w-full object-cover" />
              ) : initials(profile?.name || profile?.email || "Profile")}
            </span>
            <span className="hidden min-w-0 text-left sm:block">
              <span className="block max-w-48 truncate text-sm font-semibold text-slate-900">{profile?.name || profile?.email || "My profile"}</span>
              <span className="block text-xs text-slate-500">{operator ? formatRole(operator.membership.role) : "Account"}</span>
            </span>
            <FiChevronDown aria-hidden="true" className="mr-1 h-4 w-4 shrink-0 text-slate-500 transition group-open:rotate-180" />
          </summary>

          <div className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="truncate text-sm font-semibold text-slate-900">{profile?.name || "Your account"}</p>
              {profile?.email ? <p className="mt-0.5 break-all text-xs text-slate-500">{profile.email}</p> : null}
              {operator ? <p className="mt-1 text-xs text-slate-500">{formatRole(operator.membership.role)}</p> : null}
            </div>
            <nav aria-label="Account options" className="p-1.5">
              <Link href={profileUrl} className="flex min-h-10 items-center gap-2.5 rounded-md px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 hover:text-[#0D1282] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0D1282]">
                <FiUser aria-hidden="true" className="h-4 w-4" /> My profile
              </Link>
              {canSwitchWorkspace ? (
                <Link href="/workspaces" className="flex min-h-10 items-center gap-2.5 rounded-md px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 hover:text-[#0D1282] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0D1282]">
                  <FiGrid aria-hidden="true" className="h-4 w-4" /> Switch workspace
                </Link>
              ) : null}
              <button type="button" onClick={() => void handleSignOut()} className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-50 hover:text-rose-800 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-rose-700">
                <FiLogOut aria-hidden="true" className="h-4 w-4" /> Sign out
              </button>
            </nav>
          </div>
        </details>

        {canManageSettings ? (
          <Link
            href={`/portal/${encodeURIComponent(operatorSlug)}/settings`}
            aria-label="Company settings"
            title="Company settings"
            className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 hover:text-[#0D1282] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            <FiSettings aria-hidden="true" className="h-5 w-5" />
          </Link>
        ) : null}
        {operator?.access.mode === "MEMBER" ? (
          <NotificationBell key={operatorSlug} operatorSlug={operatorSlug} operatorHeader />
        ) : null}
        </div>
      </div>
    </header>
  );
}
