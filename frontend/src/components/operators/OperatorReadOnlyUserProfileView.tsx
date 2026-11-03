import type { ReactNode } from "react";
import Link from "next/link";
import { FiArrowLeft, FiBriefcase, FiMail, FiPhone, FiUser } from "react-icons/fi";

export type OperatorReadOnlyUserProfileData = {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  designation: string;
  userStatus: string;
  role: string;
  accessStatus: string;
  createdAt: string;
  lastLogin: string | null;
  account?: { accountId: string; companyName: string } | null;
  branches: Array<{ id?: string; name: string; code?: string }>;
  allBranchesAccess?: boolean;
};

function initials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0]?.slice(0, 2) || email.slice(0, 2) || "U").toUpperCase();
}

function displayDate(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function displayLabel(value?: string | null): string {
  return value
    ? value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase())
    : "Not available";
}

function statusStyle(status: string): string {
  switch (status.toLowerCase()) {
    case "active": return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    case "invited": return "bg-amber-50 text-amber-800 ring-amber-200";
    case "suspended":
    case "removed":
    case "declined": return "bg-rose-50 text-rose-800 ring-rose-200";
    default: return "bg-slate-100 text-slate-700 ring-slate-200";
  }
}

function ProfileField({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-4">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-2 break-words text-sm font-medium leading-5 text-slate-950">
        {children || <span className="font-normal text-slate-500">Not provided</span>}
      </dd>
    </div>
  );
}

function ProfileSection({
  icon,
  title,
  subtitle,
  children
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-4 sm:px-6">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0D1282]/[0.06] text-[#0D1282]">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-950">{title}</h2>
          <p className="mt-0.5 text-sm leading-5 text-slate-600">{subtitle}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

export function OperatorUserProfilePageHeader({
  backHref,
  backLabel,
  description
}: {
  backHref: string;
  backLabel: string;
  description: string;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-slate-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-3xl">User profile</h1>
        <p className="mt-2 text-sm leading-6 text-slate-700">{description}</p>
      </div>
      <Link
        href={backHref}
        className="inline-flex min-h-10 shrink-0 items-center gap-2 self-end rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] sm:self-auto"
      >
        <FiArrowLeft aria-hidden="true" className="h-4 w-4" /> {backLabel}
      </Link>
    </header>
  );
}

export default function OperatorReadOnlyUserProfileView({
  profile,
  backHref,
  backLabel,
  description = "Read-only personal details and operator workspace access."
}: {
  profile: OperatorReadOnlyUserProfileData;
  backHref: string;
  backLabel: string;
  description?: string;
}) {
  const name = profile.name || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "User profile";
  const branches = profile.allBranchesAccess
    ? "All operator branches"
    : profile.branches.map((branch) => branch.code ? `${branch.name} (${branch.code})` : branch.name).join(", ");

  return (
    <main className="min-h-[calc(100dvh-5rem)] bg-[#EEEDED] py-6 text-slate-900 sm:py-8">
      <div className="mx-auto w-full max-w-[1440px] space-y-5 px-3 sm:px-6 lg:px-8">
        <OperatorUserProfilePageHeader backHref={backHref} backLabel={backLabel} description={description} />
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div aria-hidden="true" className="h-20 bg-[#59A5F5] sm:h-24" />
          <div className="flex flex-col gap-4 px-4 pb-5 sm:flex-row sm:items-end sm:justify-between sm:px-7">
            <div className="flex min-w-0 items-end gap-4">
              <div aria-hidden="true" className="-mt-10 flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-white bg-[#F0DE36] text-xl font-bold text-[#0D1282] shadow-sm sm:h-24 sm:w-24 sm:text-2xl">
                {initials(name, profile.email)}
              </div>
              <div className="min-w-0 pb-1">
                <h1 className="break-words text-xl font-semibold tracking-[-0.02em] text-slate-950 sm:text-2xl">{name}</h1>
                <div className="mt-1 flex flex-col gap-x-4 gap-y-1 text-sm text-slate-600 sm:flex-row sm:flex-wrap sm:items-center">
                  {profile.email ? <span className="inline-flex min-w-0 items-center gap-1.5 break-all"><FiMail aria-hidden="true" className="h-4 w-4 shrink-0" />{profile.email}</span> : null}
                  {profile.phone ? <span className="inline-flex items-center gap-1.5"><FiPhone aria-hidden="true" className="h-4 w-4 shrink-0" />{profile.phone}</span> : null}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:mb-1 sm:justify-end">
              <span className={`inline-flex rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${statusStyle(profile.accessStatus)}`}>
                {displayLabel(profile.accessStatus)} access
              </span>
              <span className="inline-flex rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                {displayLabel(profile.role)}
              </span>
            </div>
          </div>
        </section>

        <ProfileSection icon={<FiUser aria-hidden="true" className="h-5 w-5" />} title="User details" subtitle="Read-only personal and login information">
          <dl className="grid gap-3 p-4 sm:grid-cols-2 sm:gap-4 sm:p-6 xl:grid-cols-3">
            <ProfileField label="First name">{profile.firstName}</ProfileField>
            <ProfileField label="Last name">{profile.lastName}</ProfileField>
            <ProfileField label="Phone">{profile.phone}</ProfileField>
            <ProfileField label="Email">{profile.email}</ProfileField>
            <ProfileField label="Login status">{displayLabel(profile.userStatus)}</ProfileField>
            <ProfileField label="Member since">{displayDate(profile.createdAt)}</ProfileField>
            <ProfileField label="Last login">{displayDate(profile.lastLogin)}</ProfileField>
          </dl>
        </ProfileSection>

        <ProfileSection icon={<FiBriefcase aria-hidden="true" className="h-5 w-5" />} title="Workspace access" subtitle="Operator role and assigned business access">
          <dl className="grid gap-3 p-4 sm:grid-cols-2 sm:gap-4 sm:p-6 xl:grid-cols-3">
            <ProfileField label="Role">{displayLabel(profile.role)}</ProfileField>
            <ProfileField label="Access status">{displayLabel(profile.accessStatus)}</ProfileField>
            {profile.account ? (
              <ProfileField label="Business account">
                <span className="block">{profile.account.companyName || profile.account.accountId}</span>
                <span className="mt-1 block text-xs font-normal text-slate-600">{profile.account.accountId}</span>
              </ProfileField>
            ) : null}
            {profile.designation || profile.account ? (
              <ProfileField label="Company / designation">
                {[profile.account?.companyName, profile.designation].filter(Boolean).join(" · ")}
              </ProfileField>
            ) : null}
            <ProfileField label="Assigned branches">
              {branches || <span className="font-normal text-slate-500">No branches assigned</span>}
            </ProfileField>
          </dl>
        </ProfileSection>
      </div>
    </main>
  );
}
