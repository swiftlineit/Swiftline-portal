"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { IconType } from "react-icons";
import {
  FiBriefcase,
  FiChevronDown,
  FiCreditCard,
  FiFileText,
  FiGitBranch,
  FiMapPin,
  FiMessageSquare,
  FiPackage,
  FiPlus,
  FiRotateCcw,
  FiTag,
  FiUsers
} from "react-icons/fi";
import type { OperatorSession } from "@/lib/operatorDirectory";

type NavigationLink = { label: string; path: string; icon: IconType };
type NavigationGroup = { label: string; links: NavigationLink[] };
type QuickAction = NavigationLink & { primary?: boolean };

function navigationFor(operator: OperatorSession, operatorSlug: string): NavigationGroup[] {
  const base = `/portal/${encodeURIComponent(operatorSlug)}`;
  const role = operator.membership.role;
  const supportReadOnly = operator.access.mode === "PLATFORM_SUPPORT" || operator.access.readOnly;
  const operations: NavigationLink[] = [
    { label: "Shipments", path: `${base}/shipments`, icon: FiPackage }
  ];
  const accounts: NavigationLink[] = [];

  if (!supportReadOnly) {
    operations.push(
      { label: "Tracking", path: `${base}/tracking`, icon: FiMapPin },
      { label: "Manifests", path: `${base}/manifests`, icon: FiFileText }
    );
    if (role !== "CLIENT") {
      operations.push(
        { label: "Amendments", path: `${base}/amendments`, icon: FiFileText },
        { label: "Cancellations", path: `${base}/cancellations`, icon: FiRotateCcw }
      );
      accounts.push(
        { label: "Business accounts", path: `${base}/business-accounts`, icon: FiBriefcase },
        { label: "Branches", path: `${base}/branches`, icon: FiGitBranch }
      );
      if (role === "OPERATOR_ADMIN") {
        accounts.push(
          { label: "Individual rates", path: `${base}/rate-card/individual`, icon: FiTag },
          { label: "Users", path: `${base}/users`, icon: FiUsers }
        );
      }
      if (role === "OPERATOR_ADMIN" || role === "OPERATIONS") {
        operations.push({ label: "Client queries", path: `${base}/queries`, icon: FiMessageSquare });
      }
    } else {
      accounts.push({ label: "Rate card", path: `${base}/rate-card`, icon: FiTag });
      accounts.push({ label: "Contact us", path: `${base}/contact`, icon: FiMessageSquare });
    }
  }

  accounts.push({ label: "Credit", path: `${base}/credit`, icon: FiCreditCard });

  return [
    { label: "Operations", links: operations },
    { label: role === "CLIENT" ? "Account" : "Accounts", links: accounts }
  ].filter((group) => group.links.length > 0);
}

function quickActionsFor(operator: OperatorSession, operatorSlug: string): QuickAction[] {
  const base = `/portal/${encodeURIComponent(operatorSlug)}`;
  const supportReadOnly = operator.access.mode === "PLATFORM_SUPPORT" || operator.access.readOnly;
  if (supportReadOnly) {
    return [
      { label: "Shipments", path: `${base}/shipments`, icon: FiPackage },
      { label: "Credit", path: `${base}/credit`, icon: FiCreditCard }
    ];
  }

  switch (operator.membership.role) {
    case "CLIENT":
      return [
        { label: "Create shipment", path: `${base}/shipments/new`, icon: FiPlus, primary: true },
        { label: "My shipments", path: `${base}/shipments`, icon: FiPackage }
      ];
    case "OPERATOR_ADMIN":
    case "OPERATIONS":
      return [
        { label: "Create shipment", path: `${base}/shipments/new`, icon: FiPlus, primary: true }
      ];
    case "FINANCE":
      return [
        { label: "Shipments", path: `${base}/shipments`, icon: FiPackage },
        { label: "Credit", path: `${base}/credit`, icon: FiCreditCard }
      ];
    default:
      return [];
  }
}

function WorkspaceMenu({ group, pathname }: { group: NavigationGroup; pathname: string }) {
  const menuRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    function closeOnOutsidePress(event: PointerEvent) {
      const menu = menuRef.current;
      if (menu?.open && !menu.contains(event.target as Node | null)) menu.open = false;
    }

    function closeOnEscape(event: KeyboardEvent) {
      const menu = menuRef.current;
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

  const isActive = group.links.some(({ path }) => pathname === path || pathname.startsWith(`${path}/`));

  return (
    <details ref={menuRef} className="group relative min-w-0 sm:flex-none">
      <summary
        aria-label={`${group.label} menu`}
        className={`flex min-h-11 w-full cursor-pointer list-none items-center justify-center gap-1 rounded-lg px-1 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] [&::-webkit-details-marker]:hidden sm:w-auto sm:justify-start sm:gap-2 sm:px-3 sm:text-sm ${isActive ? "bg-[#0D1282]/[0.07] text-[#0D1282]" : "bg-slate-50 text-slate-700 hover:bg-slate-100 hover:text-slate-950"}`}
      >
        {group.label}
        <FiChevronDown aria-hidden="true" className="h-4 w-4 transition group-open:rotate-180" />
      </summary>
      <nav
        aria-label={`${group.label} pages`}
        className={`absolute ${group.label === "Accounts" || group.label === "Account" ? "right-0" : "left-0"} top-[calc(100%+0.5rem)] z-40 min-w-56 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg`}
      >
        {group.links.map(({ label, path, icon: Icon }) => {
          const active = pathname === path || pathname.startsWith(`${path}/`);
          return (
            <Link
              key={path}
              href={path}
              aria-current={active ? "page" : undefined}
              onClick={() => { if (menuRef.current) menuRef.current.open = false; }}
              className={`flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0D1282] ${active ? "bg-[#0D1282]/[0.07] text-[#0D1282]" : "bg-slate-50 text-slate-700 hover:bg-slate-100 hover:text-slate-950"}`}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
    </details>
  );
}

export function OperatorHeaderNavigation({
  operator,
  operatorSlug
}: {
  operator: OperatorSession;
  operatorSlug: string;
}) {
  const pathname = usePathname();
  const groups = navigationFor(operator, operatorSlug);
  const quickActions = quickActionsFor(operator, operatorSlug);

  return (
    <nav
      aria-label="Operator workspace actions"
      className="grid min-h-14 w-full max-w-full items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:flex sm:w-fit"
      style={{ gridTemplateColumns: `repeat(${groups.length + quickActions.length}, minmax(0, 1fr))` }}
    >
      {groups.map((group) => <WorkspaceMenu key={group.label} group={group} pathname={pathname} />)}
      {quickActions.map(({ label, path, icon: Icon, primary }) => (
        <Link
          key={path}
          href={path}
          className={`inline-flex min-h-11 min-w-0 w-full items-center justify-center rounded-lg px-1 text-[11px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] sm:w-auto sm:gap-2 sm:whitespace-nowrap sm:px-3 sm:text-sm ${quickActions.length > 1 ? "flex-col gap-0 whitespace-normal text-center text-[10px] leading-tight sm:flex-row sm:gap-2 sm:text-left sm:text-sm sm:leading-normal" : "gap-1 whitespace-nowrap"} ${primary ? "border border-[#0D1282]/15 bg-[#0D1282]/[0.08] text-[#0D1282] hover:bg-[#0D1282]/[0.12]" : "border border-slate-300 bg-white text-[#0D1282] hover:bg-slate-50"}`}
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className={quickActions.length > 1 ? "line-clamp-2" : "min-w-0"}>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
