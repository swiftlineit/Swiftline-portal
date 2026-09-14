"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useId, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { FiBriefcase, FiCamera, FiChevronDown, FiEye, FiEyeOff, FiLock, FiMail, FiMapPin, FiPhone, FiTrash2, FiUser } from "react-icons/fi";
import { toast } from "react-toastify";
import { BiSolidEdit } from "react-icons/bi";
import { SearchableSelect } from "@/components/business-accounts/FormFieldControls";
import { useUnsavedChanges } from "@/lib/useUnsavedChanges";
import {
  OTHER_JOB_TITLE,
  departments,
  industries,
  isListedJobTitle,
  jobTitleOptions,
  shipmentVolumes
} from "@/lib/businessAccountOptions";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/dateFormat";
import {
  changeProfilePassword,
  contactTitles,
  formatProfileRole,
  getProfile,
  deleteProfileImage,
  loadProfileImageUrl,
  uploadProfileImage,
  updateProfileBusinessAccount,
  updateProfileDetails,
  validateProfileAccount,
  validateProfileUser,
  type EditableCompany,
  type Profile,
  type ProfileBusinessAccount,
  type ProfileContact
} from "@/lib/profile";

const emptyPassword = { currentPassword: "", newPassword: "", confirmPassword: "" };
const toOptions = (values: string[]) => values.map((value) => ({ value, label: value }));
const titleOptions = contactTitles.map((title) => ({
  value: title,
  label: title.replace(/^./, (letter) => letter.toUpperCase())
}));
// The same choices the business account wizard offers for these fields.
const departmentOptions = toOptions(departments);
const industryOptions = toOptions(industries);
const shipmentVolumeOptions = toOptions(shipmentVolumes);

function initials(name: string, email: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0]?.slice(0, 2) ?? email.slice(0, 2)).toUpperCase();
}

function Section({
  icon: Icon,
  title,
  subtitle,
  action,
  children
}: {
  icon: typeof FiUser;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-[#0D1282]">
            <Icon aria-hidden="true" className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** A read-only value. `locked` marks fields held by KYC that nobody may edit here. */
function ReadOnlyField({ label, value, locked = false }: { label: string; value: string; locked?: boolean }) {
  return (
    <div className="bg-gray-100/50 p-3 rounded border border-slate-100">
      <dt className="flex items-center  gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
        {locked}
      </dt>
      <dd className="mt-1.5 text-sm font-medium wrap-break text-slate-900">{value || "Not provided"}</dd>
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  required = false,
  type = "text",
  maxLength,
  error
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  maxLength?: number;
  error?: string;
}) {
  const inputId = useId();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isPassword = type === "password";

  return (
    <div className="block">
      <label htmlFor={inputId} className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
        {required ? <span className="ml-1 text-red-600">*</span> : null}
      </span>
      </label>
      <div className="relative mt-1.5">
        <input
          id={inputId}
          type={isPassword && passwordVisible ? "text" : type}
          value={value}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          className={`h-10 w-full rounded-xl border px-3 text-sm text-slate-900 outline-none transition focus:ring-2 ${isPassword ? "pr-10" : ""} ${
            error
              ? "border-red-400 focus:border-red-500 focus:ring-red-100"
              : "border-slate-300 focus:border-[#0D1282] focus:ring-blue-100"
          }`}
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setPasswordVisible((visible) => !visible)}
            aria-label={passwordVisible ? `Hide ${label}` : `Show ${label}`}
            aria-pressed={passwordVisible}
            className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center text-slate-400 transition hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]"
          >
            {passwordVisible ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {error ? <span className="mt-1 block text-xs font-medium text-red-600">{error}</span> : null}
    </div>
  );
}

/**
 * A fixed-option field, used where the account form also restricts the values.
 * A stored value outside the list is kept selectable so an older record is not
 * silently rewritten just because its option has since been renamed.
 */
function SelectField({
  label,
  value,
  options,
  onChange,
  required = false,
  error
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  required?: boolean;
  error?: string;
}) {
  const allOptions = value && !options.some((option) => option.value === value)
    ? [...options, { value, label: `${value} (current)` }]
    : options;

  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
        {required ? <span className="ml-1 text-red-600">*</span> : null}
      </span>
      <div className="relative mt-1.5">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`h-10 w-full appearance-none rounded-xl border bg-white px-3 pr-11 text-sm text-slate-900 outline-none transition focus:ring-2 ${
            error
              ? "border-red-400 focus:border-red-500 focus:ring-red-100"
              : "border-slate-300 focus:border-[#0D1282] focus:ring-blue-100"
          }`}
        >
          <option value="">Select</option>
          {allOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <FiChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        />
      </div>
      {error ? <span className="mt-1 block text-xs font-medium text-red-600">{error}</span> : null}
    </label>
  );
}

/**
 * Job title picker, matching the business account wizard: the same searchable
 * list, with "Other" revealing a free-text box.
 *
 * The list is long enough to need search, so it borrows the wizard's dropdown
 * rather than this page's native `<select>`, shrunk to the compact height the
 * rest of the profile fields use.
 */
function JobTitleField({
  value,
  onChange,
  error
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const [otherPicked, setOtherPicked] = useState(false);
  const showsOther = otherPicked || (Boolean(value) && !isListedJobTitle(value));

  return (
    <div className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Job Title
        <span className="ml-1 text-red-600">*</span>
      </span>
      <div className="mt-1.5 [&_button]:h-10 [&_button]:min-h-10 [&_button]:rounded-xl">
        <SearchableSelect
          label="Job Title"
          value={showsOther ? OTHER_JOB_TITLE : value}
          options={jobTitleOptions}
          placeholder="Select a job title"
          onChange={(next) => {
            if (next === OTHER_JOB_TITLE) {
              setOtherPicked(true);
              onChange("");
              return;
            }

            setOtherPicked(false);
            onChange(next);
          }}
          hideLabel
        />
      </div>

      {showsOther ? (
        <input
          value={value}
          maxLength={80}
          placeholder="e.g. Regional Logistics Head"
          onChange={(event) => onChange(event.target.value)}
          className={`mt-2 h-10 w-full rounded-xl border px-3 text-sm text-slate-900 outline-none transition focus:ring-2 ${
            error
              ? "border-red-400 focus:border-red-500 focus:ring-red-100"
              : "border-slate-300 focus:border-[#0D1282] focus:ring-blue-100"
          }`}
        />
      ) : null}

      {error ? <span className="mt-1 block text-xs font-medium text-red-600">{error}</span> : null}
    </div>
  );
}

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-2 rounded-2xl border border-[#0D1282] px-3.5 text-sm font-semibold text-[#0D1282] transition hover:bg-[#0D1282]/5"
    >
      <BiSolidEdit aria-hidden="true" className="h-4 w-4" />
      Edit
    </button>
  );
}

function EditActions({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-9 items-center gap-2 rounded-4xl border border-slate-300 px-3.5 text-sm font-semibold text-slate-700 transition hover:border-red-500"
      >
        {/* <FiX aria-hidden="true" className="h-4 w-4" /> */}
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-9 items-center gap-2 tracking-wide rounded-4xl bg-[#0D1282] px-3.5 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {/* <FiCheck aria-hidden="true" className="h-4 w-4" /> */}
        {busy ? "Saving..." : "Save Changes"}
      </button>
    </div>
  );
}

const grid = "grid gap-5 sm:grid-cols-2 lg:grid-cols-3";
const emergencyRelationshipOptions = [
  { value: "parent", label: "Parent" }, { value: "spouse", label: "Spouse" },
  { value: "sibling", label: "Sibling" }, { value: "child", label: "Child" },
  { value: "guardian", label: "Guardian" }, { value: "friend", label: "Friend" },
  { value: "other", label: "Other" }
];

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingUser, setEditingUser] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [userForm, setUserForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    // Staff-only contact fields. Sent as undefined for users without a staff
    // record, so the server leaves the sub-document alone.
    address: { line1: "", city: "", state: "", postalCode: "" },
    emergencyContact: { name: "", phone: "", relationship: "" }
  });
  const [accountForm, setAccountForm] = useState<{ company: EditableCompany; contact: ProfileContact } | null>(null);

  // Profile edits are inline panels rather than a page, so "dirty" is simply
  // having one of them open- closing either discards whatever was typed.
  useUnsavedChanges(editingUser || Boolean(editingAccountId), { label: "your profile" });
  const [passwordForm, setPasswordForm] = useState(emptyPassword);
  // Inline messages keyed by field, cleared whenever an edit starts.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [profileImageUrl, setProfileImageUrl] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getProfile();
      setProfile({ user: data.user, businessAccounts: data.businessAccounts });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load your profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (!profile?.user.hasProfileImage) {
      return;
    }
    void loadProfileImageUrl().then((url) => {
      objectUrl = url;
      if (active) setProfileImageUrl(url);
      else URL.revokeObjectURL(url);
    }).catch(() => { if (active) setProfileImageUrl(""); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [profile?.user.hasProfileImage]);

  async function handleProfileImage(file?: File) {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error("The profile image must be 3 MB or smaller.");
      return;
    }
    setBusy(true);
    try {
      const result = await uploadProfileImage(file);
      setProfile((current) => current ? { ...current, user: { ...current.user, hasProfileImage: true } } : current);
      window.dispatchEvent(new Event("profile-image-updated"));
      toast.success(result.message);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The profile image could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  async function handleProfileImageDelete() {
    setBusy(true);
    try {
      const result = await deleteProfileImage();
      setProfile((current) => current ? { ...current, user: { ...current.user, hasProfileImage: false } } : current);
      window.dispatchEvent(new Event("profile-image-updated"));
      toast.success(result.message);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The profile image could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  function startUserEdit() {
    if (!profile) return;
    setUserForm({
      firstName: profile.user.firstName,
      lastName: profile.user.lastName,
      phone: profile.user.phone,
      address: {
        line1: profile.user.staffProfile?.address.line1 ?? "",
        city: profile.user.staffProfile?.address.city ?? "",
        state: profile.user.staffProfile?.address.state ?? "",
        postalCode: profile.user.staffProfile?.address.postalCode ?? ""
      },
      emergencyContact: {
        name: profile.user.staffProfile?.emergencyContact.name ?? "",
        phone: profile.user.staffProfile?.emergencyContact.phone ?? "",
        relationship: profile.user.staffProfile?.emergencyContact.relationship ?? ""
      }
    });
    setFieldErrors({});
    setEditingUser(true);
  }

  function startAccountEdit(account: ProfileBusinessAccount) {
    setAccountForm({
      company: {
        registeredAddress: account.company.registeredAddress,
        city: account.company.city,
        stateOrProvince: account.company.stateOrProvince,
        postalCode: account.company.postalCode,
        website: account.company.website,
        industry: account.company.industry,
        monthlyShipmentVolume: account.company.monthlyShipmentVolume
      },
      contact: { ...account.contact }
    });
    setFieldErrors({});
    setEditingAccountId(account.id);
  }

  async function handleUserSave(event: FormEvent) {
    event.preventDefault();
    // The same rules run on the server; this points at the offending field first.
    const errors = validateProfileUser(userForm);
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setBusy(true);
    try {
      const data = await updateProfileDetails(
        profile?.user.staffProfile
          ? userForm
          : { firstName: userForm.firstName, lastName: userForm.lastName, phone: userForm.phone }
      );
      setProfile({ user: data.user, businessAccounts: data.businessAccounts });
      setEditingUser(false);
      toast.success(data.message);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Your details could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAccountSave(event: FormEvent, account: ProfileBusinessAccount) {
    event.preventDefault();
    if (!accountForm) return;
    const errors = validateProfileAccount(accountForm, {
      addressCountry: account.company.addressCountry,
      noCompany: account.company.noCompany
    });
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setBusy(true);
    try {
      const data = await updateProfileBusinessAccount(account.id, accountForm);
      setProfile({ user: data.user, businessAccounts: data.businessAccounts });
      setEditingAccountId("");
      setAccountForm(null);
      toast.success(data.message);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Company details could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await changeProfilePassword(passwordForm);
      setPasswordForm(emptyPassword);
      toast.success(result.message);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Your password could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm font-semibold text-[#0D1282]">Loading your profile...</p>;
  if (error || !profile) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
        {error || "Profile not found."}
      </div>
    );
  }

  const { user, businessAccounts } = profile;
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.name || user.email;

  return (
    <div className="mx-auto max-w-8xl space-y-5">
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
<div className="h-20 bg-linear-to-r from-blue-400 via-blue-300 to-blue-300" />
        {/*
          Stacks below `sm`, where a 320px screen cannot hold an avatar beside
          a full name and email. Every level of this row carries `min-w-0`:
          a flex item defaults to min-width:auto, so without it the name's
          `truncate` never engages and a long email pushes the card sideways-
          which is exactly what it did.
        */}
        <div className="flex flex-col gap-4 px-4 pb-5 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-end sm:gap-4">
            <div className="-mt-10 shrink-0">
              <span className="relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-[#F0DE36] text-2xl font-bold text-[#0D1282] shadow-sm">
                {profileImageUrl ? (
                  <Image src={profileImageUrl} alt={`${displayName} profile`} fill unoptimized className="object-cover" />
                ) : initials(displayName, user.email)}
              </span>
              <div className="mt-2 flex justify-center gap-1.5">
                <label className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:border-[#0D1282] hover:text-[#0D1282]">
                  <FiCamera aria-hidden="true" className="h-3.5 w-3.5" />
                  {user.hasProfileImage ? "Change" : "Add photo"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} className="sr-only" onChange={(event) => { void handleProfileImage(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                </label>
                {user.hasProfileImage ? (
                  <button type="button" disabled={busy} onClick={() => void handleProfileImageDelete()} aria-label="Remove profile image" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-red-200 bg-white text-red-600 hover:bg-red-50">
                    <FiTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="min-w-0 flex-1 pb-1">
              {/* Titled as well as truncated, so a clipped name is still
                  readable on hover rather than simply lost. */}
              <h1 className="truncate text-xl font-semibold text-slate-950 sm:text-2xl" title={displayName}>
                {displayName}
              </h1>
              <div className="mt-1 flex min-w-0 flex-col gap-1 text-sm text-slate-500 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
                <span className="flex min-w-0 items-center gap-1.5 tracking-wide">
                  <FiMail aria-hidden="true" className="h-3.5 w-3.5 shrink-0 font-semibold text-slate-700" />
                  <span className="truncate" title={user.email}>{user.email}</span>
                </span>
                {user.phone ? (
                  <span className="flex min-w-0 items-center gap-1.5 tracking-wide">
                    <FiPhone aria-hidden="true" className="h-3.5 w-3.5 shrink-0 font-semibold text-slate-700" />
                    <span className="truncate">{user.phone}</span>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        
        </div>
      </section>

      <Section
        icon={FiUser}
        title="My Details"
        subtitle="Your personal login details"
        action={editingUser ? null : <EditButton onClick={startUserEdit} />}
      >
        {editingUser ? (
          <form onSubmit={handleUserSave} className="space-y-5">
            <div className={grid}>
              <InputField label="First Name" required error={fieldErrors.firstName} maxLength={22} value={userForm.firstName} onChange={(value) => setUserForm((current) => ({ ...current, firstName: value }))} />
              <InputField label="Last Name" error={fieldErrors.lastName} maxLength={22} value={userForm.lastName} onChange={(value) => setUserForm((current) => ({ ...current, lastName: value }))} />
              <InputField label="Phone" error={fieldErrors.phone} maxLength={20} value={userForm.phone} onChange={(value) => setUserForm((current) => ({ ...current, phone: value }))} />
              <ReadOnlyField label="Email" value={user.email} locked />
              <ReadOnlyField label="Role" value={formatProfileRole(user.role)} locked />
              <ReadOnlyField label="Status" value={user.userStatus} locked />
            </div>

            {/* Staff keep their own address and emergency contact current; every
                other part of the staff record is maintained by HR or an admin. */}
            {user.staffProfile ? (
              <div className="space-y-5 border-t border-slate-100 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Address and emergency contact</h3>
                <div className={grid}>
                  <InputField label="Address" maxLength={160} value={userForm.address.line1} onChange={(value) => setUserForm((current) => ({ ...current, address: { ...current.address, line1: value } }))} />
                  <InputField label="City" maxLength={80} value={userForm.address.city} onChange={(value) => setUserForm((current) => ({ ...current, address: { ...current.address, city: value } }))} />
                  <InputField label="State" maxLength={80} value={userForm.address.state} onChange={(value) => setUserForm((current) => ({ ...current, address: { ...current.address, state: value } }))} />
                  <InputField label="PIN Code" maxLength={6} error={fieldErrors.postalCode} value={userForm.address.postalCode} onChange={(value) => setUserForm((current) => ({ ...current, address: { ...current.address, postalCode: value } }))} />
                  <InputField label="Emergency Contact Name" maxLength={80} value={userForm.emergencyContact.name} onChange={(value) => setUserForm((current) => ({ ...current, emergencyContact: { ...current.emergencyContact, name: value } }))} />
                  <InputField label="Emergency Contact Phone" maxLength={20} error={fieldErrors.emergencyContactPhone} value={userForm.emergencyContact.phone} onChange={(value) => setUserForm((current) => ({ ...current, emergencyContact: { ...current.emergencyContact, phone: value } }))} />
                  <SelectField label="Relationship" value={userForm.emergencyContact.relationship} options={emergencyRelationshipOptions} onChange={(value) => setUserForm((current) => ({ ...current, emergencyContact: { ...current.emergencyContact, relationship: value } }))} />
                </div>
              </div>
            ) : null}

            <div className="flex justify-end">
              <EditActions busy={busy} onCancel={() => setEditingUser(false)} />
            </div>
          </form>
        ) : (
          <dl className={grid}>
            <ReadOnlyField label="First Name" value={user.firstName} />
            <ReadOnlyField label="Last Name" value={user.lastName} />
            <ReadOnlyField label="Phone" value={user.phone} />
            <ReadOnlyField label="Email" value={user.email} locked />
            <ReadOnlyField label="Role" value={formatProfileRole(user.role)} locked />
            <ReadOnlyField label="Status" value={user.userStatus} locked />
            <ReadOnlyField label="Member Since" value={formatDashboardDate(user.createdAt)} />
            <ReadOnlyField label="Last Login" value={formatDashboardDateTime(user.lastLogin)} />
            {user.assignedBranches.length ? (
              <ReadOnlyField
                label="Assigned Branches"
                value={user.assignedBranches.map((branch) => `${branch.name} (${branch.code})`).join(", ")}
              />
            ) : null}
          </dl>
        )}
      </Section>

      {user.staffProfile ? (
        <>
          <Section
            icon={FiBriefcase}
            title="Employment"
            subtitle="Maintained by HR and administrators"
          >
            <dl className={grid}>
              <ReadOnlyField label="Designation" value={user.staffProfile.designation} locked />
              <ReadOnlyField label="Employee Code" value={user.staffProfile.employeeCode} locked />
              <ReadOnlyField label="Date of Joining" value={formatDashboardDate(user.staffProfile.dateOfJoining)} locked />
              <ReadOnlyField label="Date of Birth" value={formatDashboardDate(user.staffProfile.dateOfBirth)} locked />
              <ReadOnlyField label="Aadhaar Number" value={user.staffProfile.aadhaarNumber} locked />
              <ReadOnlyField label="PAN Number" value={user.staffProfile.panNumber} locked />
            </dl>
          </Section>

          <Section
            icon={FiMapPin}
            title="Address & Emergency Contact"
            subtitle="Yours to keep current - use Edit under My Details"
          >
            <dl className={grid}>
              <ReadOnlyField label="Address" value={user.staffProfile.address.line1} />
              <ReadOnlyField label="City" value={user.staffProfile.address.city} />
              <ReadOnlyField label="State" value={user.staffProfile.address.state} />
              <ReadOnlyField label="PIN Code" value={user.staffProfile.address.postalCode} />
              <ReadOnlyField label="Emergency Contact Name" value={user.staffProfile.emergencyContact.name} />
              <ReadOnlyField label="Emergency Contact Phone" value={user.staffProfile.emergencyContact.phone} />
              <ReadOnlyField label="Relationship" value={emergencyRelationshipOptions.find((option) => option.value === user.staffProfile?.emergencyContact.relationship)?.label ?? user.staffProfile.emergencyContact.relationship} />
            </dl>
          </Section>
        </>
      ) : null}

      {businessAccounts.map((account) => {
        const editing = editingAccountId === account.id;
        return (
          <Section
            key={account.id}
            icon={FiBriefcase}
            title={account.company.companyName || "Business Account"}
            subtitle={`${account.accountId} · ${formatProfileRole(account.membershipRole)}`}
            action={account.canEdit && !editing ? <EditButton onClick={() => startAccountEdit(account)} /> : null}
          >
            {editing && accountForm ? (
              <form onSubmit={(event) => handleAccountSave(event, account)} className="space-y-6">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Registration (Verified)</h3>
                  <dl className={`mt-3 ${grid}`}>
                    <ReadOnlyField label="Company Name" value={account.company.companyName} locked />
                    <ReadOnlyField label="Company Type" value={account.company.companyType} locked />
                    <ReadOnlyField label={account.company.registrationIdType || "Registration ID"} value={account.company.registrationId} locked />
                    <ReadOnlyField label="GSTIN" value={account.company.gstin} locked />
                  </dl>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Company Details</h3>
                  <div className={`mt-3 ${grid}`}>
                    <InputField label="Registered Address" required={!account.company.noCompany} error={fieldErrors.registeredAddress} maxLength={500} value={accountForm.company.registeredAddress} onChange={(value) => setAccountForm((current) => current && ({ ...current, company: { ...current.company, registeredAddress: value } }))} />
                    <InputField label="City" required={!account.company.noCompany} error={fieldErrors.city} maxLength={80} value={accountForm.company.city} onChange={(value) => setAccountForm((current) => current && ({ ...current, company: { ...current.company, city: value } }))} />
                    <InputField label="State / Province" required={!account.company.noCompany} error={fieldErrors.stateOrProvince} maxLength={80} value={accountForm.company.stateOrProvince} onChange={(value) => setAccountForm((current) => current && ({ ...current, company: { ...current.company, stateOrProvince: value } }))} />
                    <InputField label="Postal Code" required={!account.company.noCompany} error={fieldErrors.postalCode} maxLength={20} value={accountForm.company.postalCode} onChange={(value) => setAccountForm((current) => current && ({ ...current, company: { ...current.company, postalCode: value } }))} />
                    <InputField label="Website" error={fieldErrors.website} maxLength={200} value={accountForm.company.website} onChange={(value) => setAccountForm((current) => current && ({ ...current, company: { ...current.company, website: value } }))} />
                    <SelectField label="Industry" required={!account.company.noCompany} error={fieldErrors.industry} options={industryOptions} value={accountForm.company.industry} onChange={(value) => setAccountForm((current) => current && ({ ...current, company: { ...current.company, industry: value } }))} />
                    <SelectField label="Monthly Shipment Volume" required={!account.company.noCompany} error={fieldErrors.monthlyShipmentVolume} options={shipmentVolumeOptions} value={accountForm.company.monthlyShipmentVolume} onChange={(value) => setAccountForm((current) => current && ({ ...current, company: { ...current.company, monthlyShipmentVolume: value } }))} />
                  </div>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Account Contact</h3>
                  <div className={`mt-3 ${grid}`}>
                    <SelectField label="Title" required error={fieldErrors.title} options={titleOptions} value={accountForm.contact.title} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, title: value } }))} />
                    <InputField label="First Name" required error={fieldErrors.contactFirstName} maxLength={22} value={accountForm.contact.firstName} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, firstName: value } }))} />
                    <InputField label="Last Name" required error={fieldErrors.contactLastName} maxLength={22} value={accountForm.contact.lastName} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, lastName: value } }))} />
                    <InputField label="Email" required error={fieldErrors.contactEmail} type="email" maxLength={160} value={accountForm.contact.email} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, email: value } }))} />
                    <InputField label="Country Code" required error={fieldErrors.countryCode} maxLength={8} value={accountForm.contact.countryCode} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, countryCode: value } }))} />
                    <InputField label="Mobile Number" required error={fieldErrors.mobileNumber} maxLength={15} value={accountForm.contact.mobileNumber} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, mobileNumber: value } }))} />
                    <JobTitleField error={fieldErrors.jobTitle} value={accountForm.contact.jobTitle} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, jobTitle: value } }))} />
                    <SelectField label="Department" required error={fieldErrors.department} options={departmentOptions} value={accountForm.contact.department} onChange={(value) => setAccountForm((current) => current && ({ ...current, contact: { ...current.contact, department: value } }))} />
                  </div>
                </div>
                <div className="flex justify-end">
                  <EditActions busy={busy} onCancel={() => { setEditingAccountId(""); setAccountForm(null); }} />
                </div>
              </form>
            ) : (
              <div className="space-y-6">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Registration (Verified)</h3>
                  <dl className={`mt-3 ${grid}`}>
                    <ReadOnlyField label="Company Name" value={account.company.companyName} locked />
                    <ReadOnlyField label="Company Type" value={account.company.companyType} locked />
                    <ReadOnlyField label={account.company.registrationIdType || "Registration ID"} value={account.company.registrationId} locked />
                    <ReadOnlyField label="GSTIN" value={account.company.gstin} locked />
                    <ReadOnlyField label="Registration Country" value={account.company.registrationCountry} locked />
                    <ReadOnlyField label="Account Status" value={account.status} locked />
                  </dl>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Company Details</h3>
                  <dl className={`mt-3 ${grid}`}>
                    <ReadOnlyField label="Registered Address" value={account.company.registeredAddress} />
                    <ReadOnlyField label="City" value={account.company.city} />
                    <ReadOnlyField label="State / Province" value={account.company.stateOrProvince} />
                    <ReadOnlyField label="Postal Code" value={account.company.postalCode} />
                    <ReadOnlyField label="Website" value={account.company.website} />
                    <ReadOnlyField label="Industry" value={account.company.industry} />
                    <ReadOnlyField label="Monthly Shipment Volume" value={account.company.monthlyShipmentVolume} />
                  </dl>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Account Contact</h3>
                  <dl className={`mt-3 ${grid}`}>
                    <ReadOnlyField label="Contact Name" value={[account.contact.title, account.contact.firstName, account.contact.lastName].filter(Boolean).join(" ")} />
                    <ReadOnlyField label="Email" value={account.contact.email} />
                    <ReadOnlyField label="Mobile" value={`${account.contact.countryCode} ${account.contact.mobileNumber}`.trim()} />
                    <ReadOnlyField label="Job Title" value={account.contact.jobTitle} />
                    <ReadOnlyField label="Department" value={account.contact.department} />
                    <ReadOnlyField label="Member Since" value={formatDashboardDate(account.joinedAt)} />
                  </dl>
                </div>
                {account.assignedBranches.length ? (
                  <p className="flex items-center gap-2 text-xs text-slate-500">
                    <FiMapPin aria-hidden="true" className="h-3.5 w-3.5" />
                    {account.assignedBranches.map((branch) => `${branch.name} (${branch.code})`).join(", ")}
                  </p>
                ) : null}
                {!account.canEdit ? (
                  <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-600">
                    Only an account owner or account admin can update these details. Contact them to request a change.
                  </p>
                ) : null}
              </div>
            )}
          </Section>
        );
      })}

      <Section icon={FiLock} title="Change Password" subtitle="Use at least 8 characters">
        <form onSubmit={handlePasswordSave} className="space-y-5">
          <div className={grid}>
            <InputField label="Current Password" required type="password" maxLength={128} value={passwordForm.currentPassword} onChange={(value) => setPasswordForm((current) => ({ ...current, currentPassword: value }))} />
            <InputField label="New Password" required type="password" maxLength={128} value={passwordForm.newPassword} onChange={(value) => setPasswordForm((current) => ({ ...current, newPassword: value }))} />
            <InputField label="Confirm New Password" required type="password" maxLength={128} value={passwordForm.confirmPassword} onChange={(value) => setPasswordForm((current) => ({ ...current, confirmPassword: value }))} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Link
              href="/auth/forgot-password"
              className="text-sm font-semibold text-[#0D1282] hover:underline"
            >
              Forgot password?
            </Link>
            <button
              type="submit"
              disabled={busy || !passwordForm.currentPassword || passwordForm.newPassword.length < 8}
              className="inline-flex h-9 items-center gap-2 rounded-4xl bg-[#0D1282] px-3.5 text-sm font-semibold text-white transition hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {/* <FiCheck aria-hidden="true" className="h-4 w-4" /> */}
              {busy ? "Saving..." : "Update Password"}
            </button>
          </div>
        </form>
      </Section>
    </div>
  );
}
