import Link from "next/link";
import {
  FiArchive,
  FiCalendar,
  FiFileText,
  FiPackage,
  FiPlus,
  FiUserPlus,
} from "react-icons/fi";
import { describeRole } from "@/lib/dashboardOverview";
import type { AuthenticatedUser } from "@/lib/useAdminUser";
import { panelSurface } from "@/components/dashboard/DashboardWidgets";
import DashboardBanner from "@/components/dashboard/DashboardBanner";

const quickActions = [
  {
    label: "Create shipment",
    href: "/dashboard/dpd-labels",
    icon: FiPackage,
    roles: ["admin", "operations"],
    primary: true,
  },
  {
    label: "New manifest",
    href: "/dashboard/operations-manifests/new",
    icon: FiArchive,
    roles: ["admin", "operations"],
    primary: false,
  },
  {
    label: "Rate card",
    href: "/dashboard/country-rate-card",
    icon: FiFileText,
    roles: ["admin", "operations"],
    primary: false,
  },
  {
    label: "New business account",
    href: "/dashboard/business-accounts/create",
    icon: FiUserPlus,
    roles: ["admin"],
    primary: false,
  },
];

function greeting() {
  const hour = new Date().getHours();

  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";

  return "Good evening";
}

function firstName(user: AuthenticatedUser) {
  const name = user.name?.trim();

  if (name) return name.split(/\s+/)[0];

  return user.email.split("@")[0];
}

export default function AdminDashboardHeader({
  user,
}: {
  user: AuthenticatedUser;
}) {
  const actions = quickActions.filter((action) =>
    action.roles.includes(user.role),
  );

  return (
    <section
      className={`relative overflow-hidden ${panelSurface} !bg-[linear-gradient(135deg,#fbfcff_0%,#f6f8ff_52%,#eef2ff_100%)]`}
    >
      {/* Shared background across the complete hero */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -left-24 -top-28 h-64 w-64 rounded-full bg-[#0D1282]/[0.045] blur-3xl" />

        <div className="absolute left-[38%] -top-24 h-56 w-56 rounded-full bg-[#0D1282]/[0.025] blur-3xl" />

        <div className="absolute -bottom-32 right-[12%] h-64 w-64 rounded-full bg-[#0D1282]/[0.035] blur-3xl" />
      </div>

      <div className="relative grid overflow-hidden lg:grid-cols-[minmax(0,0.9fr)_minmax(440px,1.1fr)] lg:items-stretch xl:grid-cols-[minmax(0,0.88fr)_minmax(520px,1.12fr)]">
        {/* Greeting */}
        <div className="relative flex min-w-0 flex-col justify-center px-5 py-6 sm:px-6 sm:py-7 lg:min-h-[240px] lg:px-7 lg:py-7 xl:px-8">
          <div className="relative z-10">
            {/* Role + date */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {/* <span className="inline-flex items-center rounded-full border border-[#0D1282]/[0.06] bg-[#0D1282]/[0.07] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[#0D1282]">
                {describeRole(user.role)}
              </span> */}

              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                <FiCalendar
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-[#0D1282]/55"
                />

                {new Date().toLocaleDateString("en-IN", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </span>
            </div>

            {/* Greeting */}
            <h1 className="mt-3.5 text-[27px] font-semibold leading-[1.12] tracking-[-0.03em] text-slate-700 sm:text-[30px] xl:text-[32px]">
              {greeting()},
              <span className="capitalize text-slate-950">
                {" "}
                {firstName(user)}
              </span>
            </h1>

            {/* Quick actions */}
            <div className="mt-5 flex flex-wrap items-center gap-2 sm:gap-2.5">
              {actions.map((action) => {
                const Icon = action.primary ? FiPlus : action.icon;

                return (
                  <Link
                    key={action.href}
                    href={action.href}
                    className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 focus-visible:ring-offset-2 sm:min-h-11 ${
                      action.primary
                        ? "bg-[#F0DE36] text-[#0D1282] shadow-sm border border-slate-300 hover:bg-[#e5d331]"
                        : "border border-slate-300 bg-white/90 text-slate-700 hover:border-[#0D1282]/25 hover:bg-white hover:text-[#0D1282]"
                    }`}
                  >
                    <Icon
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0"
                    />

                    {action.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>

        {/* Banner / empty decorative area */}
        <div className="relative min-h-[210px] min-w-0 sm:min-h-[220px] lg:min-h-[240px]">
          <div className="absolute inset-0">
            <DashboardBanner />
          </div>
        </div>
      </div>
    </section>
  );
}