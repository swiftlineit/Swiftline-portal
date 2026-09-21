"use client";

import {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  FiActivity,
  FiAlertTriangle,
  FiArchive,
  FiCalendar,
  FiCheckSquare,
  FiClipboard,
  FiCreditCard,
  FiFileText,
  FiGrid,
  FiHelpCircle,
  FiMapPin,
  FiMenu,
  FiShield,
  FiLogOut,
  FiPackage,
  FiPlusSquare,
  FiSearch,
  FiTag,
  FiTruck,
  FiUser,
  FiUsers,
} from "react-icons/fi";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { IconType } from "react-icons";
import Sidebar, {
  filterNavigation,
  type SidebarNavEntry,
} from "@/components/Sidebar";
import { logout } from "@/lib/auth";
import SessionTimeoutGuard from "@/components/SessionTimeoutGuard";
import DeepLinkTarget from "@/components/DeepLinkTarget";
import NotificationBell from "@/components/NotificationBell";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import RateCardTray from "@/components/rate-cards/RateCardTray";
import GlobalSearch from "@/components/client/GlobalSearch";
import { getClientDashboard } from "@/lib/clientDashboard";
import { BsWhatsapp, BsCurrencyRupee } from "react-icons/bs";
import OperationsCalendarIcon from "@/components/OperationsCalendarIcon";
import { ShellPortalBackButton } from "@/components/PortalBackButton";

export type ClientShellUser = {
  name?: string;
  email: string;
  role: string;
};

/**
 * Client navigation, grouped by what the customer came to do. `access` names the
 * permission a link waits on; the rest are open to every member of an account.
 */
type ClientAccess =
  | "financial"
  | "quote"
  | "quoteRequest"
  | "booking"
  | "addressBook"
  | "accountAdmin";

/**
 * Grouped by the job the customer came to do.
 *
 * Only destinations that exist are listed, so a link is never a 404. Still to
 * arrive: Bulk Upload. Shipment Templates is deliberately
 * absent- it was dropped from scope rather than deferred.
 */
const clientNavigation: Array<
  | { label: string; href: string; icon: IconType }
  | {
      label: string;
      icon: IconType;
      items: Array<{
        label: string;
        href: string;
        icon: IconType;
        access?: ClientAccess;
      }>;
    }
> = [
  {
    label: "Dashboard",
    href: "/client/dashboard",
    icon: FiGrid,
  },
  {
    label: "Shipments",
    icon: FiPackage,
    items: [
      {
        label: "Create Shipment",
        href: "/client/dpd-labels",
        icon: FiPlusSquare,
        access: "booking",
      },
      {
        label:"Shipments Draft",
        href:"/client/dpd-labels#drafts",
        icon:FiPackage,
        access:"booking"
      },
       {
        label: "My Shipments",
        href: "/client/shipments",
        icon: FiPackage,
      },
      {
        label: "Address Book",
        href: "/client/address-book",
        icon: FiMapPin,
        access: "addressBook",
      },
      {
        label: "Tracking",
        href: "/client/tracking",
        icon: FiMapPin,
      },
    ],
  },
  {
    label: "Operations",
    icon: FiTruck,
    items: [
      {
        label: "Pickup Management",
        href: "/client/pickups",
        icon: FiTruck,
      },
      {
        label: "Manifests",
        href: "/client/manifests",
        icon: FiArchive,
      },
      {
        label: "POD Centre",
        href: "/client/pods",
        icon: FiCheckSquare,
      },
      {
        label: "Exceptions",
        href: "/client/exceptions",
        icon: FiAlertTriangle,
      },
      {
        label: "Action Required",
        href: "/client/actions",
        icon: FiCheckSquare,
      },
    ],
  },
  {
    label: "Documents & Compliance",
    icon: FiFileText,
    items: [
      {
        label: "Documents Centre",
        href: "/client/documents",
        icon: FiFileText,
      },
      {
        label: "Customs & KYC",
        href: "/client/customs",
        icon: FiShield,
      },
    ],
  },
  {
    label: "Quotes & Rates",
    icon: FiClipboard,
    items: [
      {
        label: "Get Live Quote",
        href: "/client/get-quote",
        icon: FiClipboard,
        access: "quoteRequest",
      },
      {
        label: "My Quotes",
        href: "/client/quotes",
        icon: FiFileText,
        access: "quote",
      },
      {
        label: "Your Rate Card",
        href: "/client/rate-card",
        icon: FiTag,
      },
      {
        label: "Serviceability Checker",
        href: "/client/serviceability",
        icon: FiSearch,
      },
    ],
  },
  {
    label: "Billing",
    icon: BsCurrencyRupee,
    items: [
      {
        label: "Credit Account",
        href: "/client/credit",
        icon: BsCurrencyRupee,
      },
      {
        label: "Credit Reports",
        href: "/client/credit/statements",
        icon: FiFileText,
        access: "financial",
      },
      {
        label: "Top-up & Payments",
        href: "/client/payments",
        icon: FiCreditCard,
        access: "financial",
      },
    ],
  },
  {
    // Enquiries and compensation are separate journeys with separate rules, so
    // they sit side by side under one heading rather than nested.
    label: "Claims & Support",
    icon: FiShield,
    items: [
      {
        label: "Claims",
        href: "/client/claims",
        icon: FiShield,
      },
      {
        label: "Help Desk",
        href: "/client/tickets",
        icon: FiHelpCircle,
      },
    ],
  },
  {
    label: "Account",
    icon: FiUser,
    items: [
      {
        label: "My Profile",
        href: "/client/profile",
        icon: FiUser,
      },
      {
        label: "Team Members",
        href: "/client/team",
        icon: FiUsers,
        access: "accountAdmin",
      },
      {
        label: "Activity",
        href: "/client/activity",
        icon: FiActivity,
        access: "accountAdmin",
      },
      {
        label: "Holiday & Cut-Off Calendar",
        href: "/client/operations-calendar",
        icon: FiCalendar,
      },
    ],
  },
];

export function ClientDashboardShell({
  user,
  children,
}: {
  user: ClientShellUser;
  children: ReactNode;
}) {
  const router = useRouter();

  // The permission-gated links depend on an API call, so the whole list stays
  // empty until it settles and every link then appears in one paint.
  const [navigation, setNavigation] =
    useState<SidebarNavEntry[] | null>(null);

  // Below `lg` the sidebar is an off-canvas drawer; this is what opens it.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Stable identity: the sidebar holds a media-query listener keyed on it, and
  // a fresh closure each render would rebind that listener each render.
  const closeMobileNav = useCallback(
    () => setMobileNavOpen(false),
    [],
  );

  // Taken from the dashboard call the navigation already makes, so search costs
  // no extra request. Search stays hidden until it resolves- a box that
  // returns nothing because it does not know the account is worse than none.
  const [searchAccountId, setSearchAccountId] = useState("");

  // The WhatsApp support pill floats over the content, so a user should be able
  // to drag it out of the way of anything it is covering. Offsets live in state
  // so the pill stays put across re-renders; a reload simply returns it home.
  const whatsappRef = useRef<HTMLAnchorElement>(null);

  const dragState = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    width: number;
    height: number;
    moved: boolean;
  } | null>(null);

  const dragFrame = useRef<number | null>(null);

  // A drag ends with a click event; that one must not open WhatsApp.
  const suppressChatClick = useRef(false);

  function applyChatPosition(x: number, y: number) {
    const element = whatsappRef.current;
    if (!element) return;

    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function handleChatWindowPointerMove(event: PointerEvent) {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.preventDefault();

    const dx = event.clientX - drag.startPointerX;
    const dy = event.clientY - drag.startPointerY;
    const margin = 8;

    const maxX = Math.max(
      margin,
      window.innerWidth - drag.width - margin,
    );

    const maxY = Math.max(
      margin,
      window.innerHeight - drag.height - margin,
    );

    drag.x = Math.min(
      Math.max(drag.startX + dx, margin),
      maxX,
    );

    drag.y = Math.min(
      Math.max(drag.startY + dy, margin),
      maxY,
    );

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true;
    }

    if (dragFrame.current !== null) return;

    dragFrame.current = window.requestAnimationFrame(() => {
      const currentDrag = dragState.current;

      if (currentDrag) {
        applyChatPosition(
          currentDrag.x,
          currentDrag.y,
        );
      }

      dragFrame.current = null;
    });
  }

  function finishChatDrag(event: PointerEvent) {
    const drag = dragState.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (dragFrame.current !== null) {
      window.cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
    }

    applyChatPosition(drag.x, drag.y);

    if (drag.moved) {
      suppressChatClick.current = true;
    }

    dragState.current = null;

    window.removeEventListener(
      "pointermove",
      handleChatWindowPointerMove,
    );

    window.removeEventListener(
      "pointerup",
      finishChatDrag,
    );

    window.removeEventListener(
      "pointercancel",
      finishChatDrag,
    );
  }

  function handleChatPointerDown(
    event: ReactPointerEvent<HTMLAnchorElement>,
  ) {
    if (
      event.pointerType === "mouse" &&
      event.button !== 0
    ) {
      return;
    }

    const element = whatsappRef.current;

    if (!element) return;

    // Stop the browser's native anchor/image drag behaviour from competing with
    // the floating-button drag.
    event.preventDefault();

    const bounds = element.getBoundingClientRect();

    dragState.current = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startX: bounds.left,
      startY: bounds.top,
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
      moved: false,
    };

    // From this point the button is positioned from the viewport's top-left.
    // Only the transform changes during dragging, so no layout is triggered.
    element.style.left = "0px";
    element.style.top = "0px";
    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.transition = "none";

    applyChatPosition(bounds.left, bounds.top);

    // Listen on the window rather than the anchor itself. This lets the pointer
    // travel anywhere on screen without losing drag events.
    window.addEventListener(
      "pointermove",
      handleChatWindowPointerMove,
      {
        passive: false,
      },
    );

    window.addEventListener(
      "pointerup",
      finishChatDrag,
    );

    window.addEventListener(
      "pointercancel",
      finishChatDrag,
    );
  }

  useEffect(() => {
    let active = true;

    function resolve(
      hasFinancialAccess: boolean,
      hasQuoteAccess: boolean,
      canRequestQuote: boolean,
      canBook: boolean,
      canManageAddresses: boolean,
      isAccountAdmin: boolean,
    ) {
      if (!active) return;

      const granted: Record<ClientAccess, boolean> = {
        financial: hasFinancialAccess,
        quote: hasQuoteAccess,
        quoteRequest: canRequestQuote,
        booking: canBook,
        addressBook: canManageAddresses,
        accountAdmin: isAccountAdmin,
      };

      setNavigation(
        filterNavigation(
          clientNavigation.map((entry) =>
            "items" in entry
              ? {
                  ...entry,
                  items: entry.items.map(
                    ({ access, ...item }) => ({
                      ...item,
                      visible:
                        !access ||
                        granted[access],
                    }),
                  ),
                }
              : entry,
          ),
        ),
      );
    }

    void getClientDashboard()
      .then((dashboard) => {
        const searchable =
          dashboard.accounts.find(
            (item) =>
              item.dashboardAccess.state === "READY",
          ) ?? dashboard.accounts[0];

        if (active) {
          setSearchAccountId(
            searchable?.account.id ?? "",
          );
        }

        resolve(
          dashboard.accounts.some((item) =>
            [
              "account_owner",
              "account_admin",
              "finance",
            ].includes(item.membership.role),
          ),

          dashboard.accounts.some((item) =>
            [
              "account_owner",
              "account_admin",
              "operations",
              "finance",
            ].includes(item.membership.role),
          ),

          dashboard.accounts.some(
            (item) =>
              [
                "account_owner",
                "account_admin",
                "operations",
              ].includes(item.membership.role) &&
              item.account.rateCard.assigned &&
              item.dashboardAccess.state === "READY",
          ),

          dashboard.accounts.some(
            (item) =>
              [
                "account_owner",
                "account_admin",
                "operations",
              ].includes(item.membership.role) &&
              item.assignedBranches.length > 0 &&
              item.bookingAccess.state === "READY" &&
              item.dashboardAccess.state === "READY",
          ),

          dashboard.accounts.some(
            (item) =>
              [
                "account_owner",
                "account_admin",
                "operations",
              ].includes(item.membership.role) &&
              item.dashboardAccess.state === "READY",
          ),

          dashboard.accounts.some((item) =>
            [
              "account_owner",
              "account_admin",
            ].includes(item.membership.role),
          ),
        );
      })
      .catch(() =>
        resolve(
          false,
          false,
          false,
          false,
          false,
          false,
        ),
      );

    return () => {
      active = false;
    };
  }, []);

  async function handleLogout() {
    await logout();
    router.replace("/");
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#EEEDED]/60">
      {/* Mounted inside the shell so it only ever runs for a signed-in user. */}
      <SessionTimeoutGuard />

      {/* Thin Swiftline brand accent */}
      <div className="h-1 shrink-0 bg-[#0D1282]" />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          items={navigation ?? []}
          mobileOpen={mobileNavOpen}
          onMobileClose={closeMobileNav}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center gap-2 border-b border-white/10 bg-[#12185A] px-4 lg:h-20 lg:gap-4 lg:px-8">
            <button
              type="button"
              onClick={() =>
                setMobileNavOpen(true)
              }
              aria-label="Open menu"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/[0.04] text-white transition-colors duration-200 hover:border-white/25 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/25 lg:hidden"
            >
              <FiMenu
                aria-hidden="true"
                className="h-5 w-5"
              />
            </button>

            {/* From `lg` the search bar lives inline; below it moves to its own
                row, where a full-width field is usable on a phone. */}
            <div className="hidden min-w-0 flex-1 lg:block">
              {searchAccountId ? (
                <GlobalSearch
                  businessAccountId={
                    searchAccountId
                  }
                />
              ) : null}
            </div>

            <div className="min-w-0 flex-1 lg:hidden" />

            <div className="flex shrink-0 items-center gap-2 lg:gap-4">
              {/* The name is the first thing to go when width is short: it is
                  the only item here that is not a control. */}
              <div className="hidden text-right md:block">
                <p className="text-sm font-semibold uppercase tracking-wide text-white">
                  {user.name || user.email}
                </p>

                <p className="mt-1 text-xs font-medium uppercase tracking-wide text-[#AEB4D9]">
                  {user.role}
                </p>
              </div>

              <div className="group relative">
                <Link
                  href="/client/profile"
                  aria-label="My Profile"
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-white/25"
                >
                  <FiUser
                    aria-hidden="true"
                    className="h-5 w-5"
                  />
                </Link>

                <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-[#05072B] px-3 py-2 text-xs font-medium text-white opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-1 group-hover:opacity-100">
                  My Profile

                  <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[#05072B]" />
                </div>
              </div>

              <OperationsCalendarIcon />


              <NotificationBell />
              <RateCardTray />


              <div className="group relative inline-flex">
                <button
                  type="button"
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

          {/* Below `lg` search gets its own row: keep it visually connected to
              the dark application header rather than creating a white strip. */}
          {searchAccountId ? (
            <div className="shrink-0 border-b border-white/10 bg-[#12185A] px-4 pb-3 lg:hidden">
              <GlobalSearch
                businessAccountId={
                  searchAccountId
                }
              />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [overflow-anchor:none] scrollbar-none [-ms-overflow-style:none] sm:px-6 lg:px-8 lg:py-6 [&::-webkit-scrollbar]:hidden">
            <div className="mb-4 flex items-center">
              <ShellPortalBackButton />
            </div>

            {children}
          </div>

          <DeepLinkTarget />
        </main>
      </div>

      {/* The client shell had no unsaved-work guard at all, so leaving a
          half-filled form discarded it silently. The sidebar it renders is the
          same guarded one the admin shell uses; this supplies the prompt. */}
      <UnsavedChangesDialog />

      <a
        ref={whatsappRef}
        href="https://wa.me/917027606600"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Contact support on WhatsApp"
        draggable={false}
        onDragStart={(event) =>
          event.preventDefault()
        }
        onPointerDown={handleChatPointerDown}
        onClick={(event) => {
          if (suppressChatClick.current) {
            event.preventDefault();
            suppressChatClick.current = false;
          }
        }}
        // Below the nav drawer (z-50) and its backdrop (z-40), so an open menu
        // covers it instead of leaving it floating over the overlay.
        className="fixed bottom-5 right-5 z-30 flex cursor-grab select-none touch-none items-center gap-1 rounded-full bg-[#25D366] px-3 py-2 text-xs font-semibold text-white shadow hover:bg-[#1ea952] active:cursor-grabbing"
        style={{
          willChange: "transform",
        }}
      >
        <BsWhatsapp className="h-3 w-3" />
        <span className="hidden sm:inline">
          {" "}
          Support
        </span>
      </a>
    </div>
  );
}

export function ClientDashboardLoading() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#EEEDED]/60">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#0D1282]/20 border-t-[#0D1282]" />
      <p className="text-sm font-semibold text-[#0D1282]">
        Loading client dashboard...
      </p>
    </div>
  );
}