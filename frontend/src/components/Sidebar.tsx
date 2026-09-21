"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useGuardedNavigate } from "@/lib/useUnsavedChanges";
import { usePathname } from "next/navigation";
import type { IconType } from "react-icons";
import {
  FiAlertOctagon,
  FiArchive,
  FiBriefcase,
  FiChevronDown,
  FiChevronLeft,
  FiChevronRight,
  FiClipboard,
  FiCreditCard,
  FiEdit3,
  FiFileText,
  FiGlobe,
  FiGrid,
  FiHelpCircle,
  FiShield,
  FiMapPin,
  FiPackage,
  FiSettings,
  FiTruck,
  FiTrendingUp,
  FiUsers,
  FiX,
  FiXCircle,
} from "react-icons/fi";
import { BsCurrencyRupee } from "react-icons/bs";
import {
  ALL_STAFF_AREA,
  BRANCH_VIEW_AREA,
  BUSINESS_ACCOUNT_AREA,
  COUNTER_SALES_AREA,
  CREDIT_VIEW_AREA,
  FINANCE_AREA,
  RATE_CARD_AREA,
  CLAIMS_AREA,
  OPERATIONS_AREA,
  SHIPMENT_VIEW_AREA,
  STAFF_DIRECTORY_AREA,
  withAdmin,
} from "@/lib/roles";

/** A destination. `visible` gates it on a role or a permission the caller resolves. */
export type SidebarNavItem = {
  label: string;
  href: string;
  icon: IconType;
  visible?: boolean;
};

/** A collapsible heading. It disappears when none of its children are visible. */
export type SidebarNavGroup = {
  label: string;
  icon: IconType;
  items: SidebarNavItem[];
};

export type SidebarNavEntry = SidebarNavItem | SidebarNavGroup;

function isGroup(entry: SidebarNavEntry): entry is SidebarNavGroup {
  return "items" in entry;
}

/**
 * Drops the links a user may not see, then any group left with nothing in it.
 * Items without a `visible` flag are always shown.
 */
export function filterNavigation(
  entries: SidebarNavEntry[],
): SidebarNavEntry[] {
  return entries.flatMap<SidebarNavEntry>((entry) => {
    if (!isGroup(entry)) return entry.visible === false ? [] : [entry];

    const items = entry.items.filter((item) => item.visible !== false);

    return items.length ? [{ ...entry, items }] : [];
  });
}

/**
 * Staff navigation, grouped by the job being done rather than listed flat- the
 * portal has outgrown a single column of twenty links.
 *
 * `roles` reuses the access bundles from `@/lib/roles`, which the matching page
 * also passes to `useAdminUser`- a link is never shown to a role the page would
 * turn away. A group header is only chrome, so its own visibility follows from
 * whichever of its children survive that filter.
 */
const staffNavigation: Array<
  | (SidebarNavItem & { roles: readonly string[] })
  | {
      label: string;
      icon: IconType;
      items: Array<SidebarNavItem & { roles: readonly string[] }>;
    }
> = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: FiGrid,
    roles: withAdmin(ALL_STAFF_AREA),
  },
  {
    label: "Shipments",
    icon: FiPackage,
    items: [
      {
        label: "All Shipments",
        // Explicitly clear saved dashboard drill-down filters such as
        // "Needs attention" when the operator chooses the canonical list.
        href: "/dashboard/shipments?view=all",
        icon: FiPackage,
        roles: withAdmin(SHIPMENT_VIEW_AREA),
      },
      {
        label: "Tracking",
        href: "/dashboard/tracking",
        icon: FiTruck,
        roles: withAdmin(SHIPMENT_VIEW_AREA),
      },
      {
        label: "Amendments",
        href: "/dashboard/amendments",
        icon: FiEdit3,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Cancellations",
        href: "/dashboard/cancellations",
        icon: FiXCircle,
        roles: withAdmin(OPERATIONS_AREA),
      },
    ],
  },
  {
    label: "Manifests",
    icon: FiArchive,
    items: [
      {
        label: "Shipment Manifests",
        href: "/dashboard/shipment-manifests",
        icon: FiFileText,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Operations Manifests",
        href: "/dashboard/operations-manifests",
        icon: FiArchive,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Flight & Linehaul",
        href: "/dashboard/flight-linehauls",
        icon: FiTruck,
        roles: withAdmin(OPERATIONS_AREA),
      },
    ],
  },
  {
    label: "Operations",
    icon: FiTruck,
    items: [
      {
        label: "Origin Scans",
        href: "/dashboard/operations-scans",
        icon: FiPackage,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Pickup Requests",
        href: "/dashboard/pickups",
        icon: FiTruck,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Pickup Drivers",
        href: "/dashboard/drivers",
        icon: FiUsers,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "International POD",
        href: "/dashboard/pod",
        icon: FiFileText,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Operations Advisory",
        href: "/dashboard/operations-advisory",
        icon: FiAlertOctagon,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Flight Cost Drafts",
        href: "/dashboard/flight-cost-drafts",
        icon: FiFileText,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Swiftline Routes",
        href: "/dashboard/swiftline-routes",
        icon: FiGlobe,
        roles: withAdmin(OPERATIONS_AREA),
      },
    ],
  },
  {
    label: "Sales & Pricing",
    icon: BsCurrencyRupee,
    items: [
      {
        label: "Quote Requests",
        href: "/dashboard/quote-requests",
        icon: FiClipboard,
        roles: withAdmin(OPERATIONS_AREA),
      },
      {
        label: "Counter Sales",
        href: "/dashboard/counter-sales",
        icon: BsCurrencyRupee,
        roles: withAdmin(COUNTER_SALES_AREA),
      },
      {
        label: "Country Rate Card",
        href: "/dashboard/country-rate-card",
        icon: FiFileText,
        roles: withAdmin(RATE_CARD_AREA),
      },
    ],
  },
  {
    label: "Finance",
    icon: FiTrendingUp,
    items: [
      {
        label: "Profitability / Margin",
        href: "/dashboard/finance/profitability",
        icon: FiTrendingUp,
        roles: withAdmin(FINANCE_AREA),
      },
    ],
  },
  {
    label: "Accounts",
    icon: FiBriefcase,
    items: [
      {
        label: "Business Accounts",
        href: "/dashboard/business-accounts",
        icon: FiBriefcase,
        roles: withAdmin(BUSINESS_ACCOUNT_AREA),
      },
      {
        label: "Credit Accounts",
        href: "/dashboard/credit-accounts",
        icon: FiCreditCard,
        roles: withAdmin(CREDIT_VIEW_AREA),
      },
    ],
  },
  {
    label: "Administration",
    icon: FiSettings,
    items: [
      {
        label: "Branches",
        href: "/dashboard/branches",
        icon: FiMapPin,
        roles: withAdmin(BRANCH_VIEW_AREA),
      },
      {
        label: "Users",
        href: "/dashboard/users",
        icon: FiUsers,
        roles: withAdmin(STAFF_DIRECTORY_AREA),
      },
    ],
  },
  {
    label: "Help Desk",
    href: "/dashboard/tickets",
    icon: FiHelpCircle,
    roles: withAdmin(OPERATIONS_AREA),
  },
  {
    label: "Claims",
    href: "/dashboard/claims",
    icon: FiShield,
    roles: withAdmin(CLAIMS_AREA),
  },
];

function staffNavigationFor(userRole: string): SidebarNavEntry[] {
  return filterNavigation(
    staffNavigation.map((entry) =>
      "items" in entry
        ? {
            label: entry.label,
            icon: entry.icon,
            items: entry.items.map(({ roles, ...item }) => ({
              ...item,
              visible: roles.includes(userRole),
            })),
          }
        : {
            label: entry.label,
            href: entry.href,
            icon: entry.icon,
            visible: entry.roles.includes(userRole),
          },
    ),
  );
}

function matchesRoute(pathname: string, href: string) {
  return (
    pathname === href ||
    (!href.endsWith("/dashboard") && pathname.startsWith(`${href}/`))
  );
}

export default function Sidebar({
  userRole,
  items,
  mobileOpen,
  onMobileClose,
}: {
  userRole?: string;
  items?: SidebarNavEntry[];
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const pathname = usePathname();
  const guardNavigate = useGuardedNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    if (!onMobileClose) return;

    const desktop = window.matchMedia("(min-width: 64rem)");

    const closeIfDesktop = () => {
      if (desktop.matches) onMobileClose();
    };

    desktop.addEventListener("change", closeIfDesktop);

    return () => desktop.removeEventListener("change", closeIfDesktop);
  }, [onMobileClose]);

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const navigation = items ?? staffNavigationFor(userRole ?? "");
  const isDrawer = typeof onMobileClose === "function";
  const expanded = isDrawer && mobileOpen ? true : sidebarOpen;

  function toggleGroup(label: string, isOpen: boolean) {
    if (!expanded) {
      setSidebarOpen(true);

      setOpenGroups((current) => ({
        ...current,
        [label]: true,
      }));

      return;
    }

    setOpenGroups((current) => ({
      ...current,
      [label]: !isOpen,
    }));
  }

  function handleNavigated() {
    if (isDrawer) onMobileClose?.();
  }

  const rowBase =
    "group flex h-11 items-center rounded-lg text-sm font-medium transition-colors duration-200";

  const rowLayout = expanded
    ? "w-full justify-start gap-3 px-3"
    : "mx-auto w-11 justify-center";

  function iconClass(active: boolean) {
    return `h-4 w-4 shrink-0 transition-colors duration-200 ${
      active
        ? "text-white"
        : "text-[#AEB4E8] group-hover:text-white"
    }`;
  }

  const asideClass = isDrawer
    ? [
        "flex min-h-0 flex-col overflow-hidden border-r border-white/10 bg-[#12185A]",
        "fixed inset-y-0 left-0 z-50 w-72 transition-[transform,visibility] duration-300",
        mobileOpen
          ? "translate-x-0 visible"
          : "-translate-x-full invisible",
        "lg:static lg:z-auto lg:h-full lg:shrink-0 lg:visible lg:translate-x-0 lg:transition-all",
        sidebarOpen ? "lg:w-60" : "lg:w-20",
      ].join(" ")
    : `flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-white/10 bg-[#12185A] transition-all duration-300 ${
        sidebarOpen ? "w-60" : "w-20"
      }`;

  return (
    <>
      {isDrawer ? (
        <div
          aria-hidden="true"
          onClick={onMobileClose}
          className={`fixed inset-0 z-40 bg-slate-950/50 transition-opacity duration-300 lg:hidden ${
            mobileOpen
              ? "opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        />
      ) : null}

      <aside className={asideClass}>
        <div
          className={`flex h-20 shrink-0 items-center border-b border-white/10 px-3 ${
            expanded ? "justify-between gap-3" : "justify-center"
          }`}
        >
          {expanded ? (
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/dashboard"
                onNavigate={guardNavigate("/dashboard")}
              >
                <Image
                  src="/slc_white_logo.png"
                  alt="Swiftline Cargo"
                  width={100}
                  height={100}
                  className="h-17 w-30 rounded-2xl object-contain"
                />
              </Link>
            </div>
          ) : null}

          {isDrawer ? (
            <button
              type="button"
              onClick={onMobileClose}
              aria-label="Close menu"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/[0.04] text-lg font-semibold text-white transition-colors duration-200 hover:border-white/25 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/25 lg:hidden"
            >
              <FiX aria-hidden="true" />
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setSidebarOpen((current) => !current)}
            aria-label={
              sidebarOpen ? "Collapse sidebar" : "Open sidebar"
            }
            className={`h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/[0.04] text-lg font-semibold text-white transition-colors duration-200 hover:border-white/25 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/25 ${
              isDrawer ? "hidden lg:flex" : "flex"
            }`}
          >
            {sidebarOpen ? (
              <FiChevronLeft aria-hidden="true" />
            ) : (
              <FiChevronRight aria-hidden="true" />
            )}
          </button>
        </div>

        <nav
          data-dashboard-sidebar-scroll
          className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 py-5 scrollbar-none [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {navigation.map((entry) => {
            const Icon = entry.icon;

            if (!isGroup(entry)) {
              const isActive = matchesRoute(pathname, entry.href);

              return (
                <Link
                  key={entry.label}
                  href={entry.href}
                  onNavigate={guardNavigate(entry.href)}
                  onClick={handleNavigated}
                  className={`${rowBase} ${rowLayout} ${
                    isActive
                      ? "bg-white/12 font-semibold text-white ring-1 ring-inset ring-white/10"
                      : "text-[#CDD1F2] hover:bg-white/[0.07] hover:text-white"
                  }`}
                  title={expanded ? undefined : entry.label}
                >
                  <Icon
                    aria-hidden="true"
                    className={iconClass(isActive)}
                  />

                  {expanded ? (
                    <span className="truncate">
                      {entry.label}
                    </span>
                  ) : null}
                </Link>
              );
            }

            const holdsCurrentPage = entry.items.some((item) =>
              matchesRoute(pathname, item.href),
            );

            const isOpen =
              openGroups[entry.label] ?? holdsCurrentPage;

            return (
              <div key={entry.label}>
                <button
                  type="button"
                  onClick={() =>
                    toggleGroup(entry.label, isOpen)
                  }
                  aria-expanded={expanded ? isOpen : false}
                  className={`${rowBase} ${rowLayout} ${
                    holdsCurrentPage
                      ? "bg-white/[0.06] font-semibold text-white"
                      : "text-[#CDD1F2] hover:bg-white/[0.07] hover:text-white"
                  }`}
                  title={expanded ? undefined : entry.label}
                >
                  <Icon
                    aria-hidden="true"
                    className={iconClass(holdsCurrentPage)}
                  />

                  {expanded ? (
                    <>
                      <span className="flex-1 truncate text-left">
                        {entry.label}
                      </span>

                      <FiChevronDown
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 shrink-0 text-[#8F96CC] transition-transform duration-200 ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </>
                  ) : null}
                </button>

                {expanded && isOpen ? (
                  <div className="mt-1 ml-6.5 space-y-0.5 border-l border-white/10 pl-3">
                    {entry.items.map((item) => {
                      const isActive = matchesRoute(
                        pathname,
                        item.href,
                      );

                      return (
                        <Link
                          key={item.label}
                          href={item.href}
                          onNavigate={guardNavigate(item.href)}
                          onClick={handleNavigated}
                          className={`flex h-9 items-center rounded-lg px-3 text-[13px] transition-colors duration-200 ${
                            isActive
                              ? "bg-[#252B83] font-semibold text-white"
                              : "font-medium text-[#AEB4D9] hover:bg-white/[0.06] hover:text-white"
                          }`}
                        >
                          <span className="truncate">
                            {item.label}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
