"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FiArrowLeft, FiArrowRight, FiCheck, FiCopy, FiEdit3, FiEye, FiMail, FiPauseCircle, FiPlayCircle, FiPlus, FiRefreshCw, FiUserPlus, FiX } from "react-icons/fi";
import { DashboardLoading } from "@/components/DashboardShell";
import { useAdminUser } from "@/lib/useAdminUser";
import {
  activateOperatorPortal,
  inviteOperatorAdministrator,
  issueOperatorAdministratorLink,
  createOperatorDraft,
  endOperatorSupportSession,
  listOperatorDrafts,
  startOperatorSupportSession,
  updateOperatorSlug,
  updateOperatorStatus,
  type OperatorDraft,
  type OperatorAdministrator
} from "@/lib/operatorRegistry";
import { getOperatorSupportGrant, storeOperatorSupportGrant } from "@/lib/operatorSupport";

export default function OperatorRegistry() {
  const { user, loading, error } = useAdminUser();
  const [operators, setOperators] = useState<OperatorDraft[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [customSlug, setCustomSlug] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editingSlug, setEditingSlug] = useState("");
  const [editError, setEditError] = useState("");

  const load = useCallback(async (targetPage: number, showLoading = true) => {
    if (showLoading) setListLoading(true);
    setListError("");
    try {
      const result = await listOperatorDrafts(targetPage);
      setOperators(result.operators);
      setPage(result.pagination.page);
      setTotalPages(result.pagination.totalPages);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Unable to load operators.");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    listOperatorDrafts(page)
      .then((result) => {
        if (!active) return;
        setOperators(result.operators);
        setTotalPages(result.pagination.totalPages);
        setListError("");
      })
      .catch((error: unknown) => {
        if (active) setListError(error instanceof Error ? error.message : "Unable to load operators.");
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => { active = false; };
  }, [user, page]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setSaving(true);
    try {
      await createOperatorDraft({
        companyName: companyName.trim(),
        ...(customSlug.trim() ? { slug: customSlug.trim() } : {})
      });
      setCompanyName("");
      setCustomSlug("");
      await load(1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to create this operator.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSlugSave(operator: OperatorDraft) {
    setEditError("");
    setSaving(true);
    try {
      await updateOperatorSlug(operator.id, editingSlug.trim());
      setEditingId("");
      await load(page);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Unable to update this URL identifier.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <DashboardLoading />;
  if (!user) return error ? <p role="alert" className="text-sm text-red-700">{error}</p> : <DashboardLoading />;

  return (
    <div className="mx-auto w-full max-w-x8l space-y-6 pb-10 text-slate-950">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Operators</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          Register businesses that will run their own portal. New operators stay in draft until their data and access setup is complete.
        </p>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <section className="order-2 overflow-hidden rounded-2xl border border-slate-200 bg-white lg:order-1" aria-labelledby="operator-list-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-6">
            <h2 id="operator-list-title" className="text-base font-semibold">Registered operators</h2>
            <span className="text-xs font-medium text-slate-500">{operators.length} on this page</span>
          </div>
          {listError ? (
            <div role="alert" className="px-5 py-8 text-sm text-red-700 sm:px-6">
              <p>{listError}</p>
              <button type="button" onClick={() => void load(page)} className="mt-3 font-semibold underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-blue-700">Try again</button>
            </div>
          ) : listLoading ? (
            <p className="px-5 py-8 text-sm text-slate-600 sm:px-6" role="status">Loading operators…</p>
          ) : operators.length === 0 ? (
            <p className="px-5 py-10 text-sm text-slate-600 sm:px-6">No operators yet. Create a draft using the form.</p>
          ) : (
            <ul className="divide-y divide-slate-200">
              {operators.map((operator) => (
                <li key={operator.id} className="px-5 py-5 sm:px-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold sm:text-base">{operator.companyName}</h3>
                      <p className="mt-1 break-all text-xs text-slate-600">/portal/{operator.slug}</p>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${operator.status === "ACTIVE" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : operator.status === "SUSPENDED" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{operator.status}</span>
                  </div>
                  <OperatorAdministrators operator={operator} onChanged={() => load(page, false)} />
                  {operator.status !== "DRAFT" ? <OperatorStatusControl operator={operator} onChanged={() => load(page, false)} /> : null}
                  {operator.status === "ACTIVE" ? <OperatorSupportAccess operator={operator} /> : null}
                  {editingId === operator.id ? (
                    <div className="mt-4 space-y-2">
                      <label htmlFor={`slug-${operator.id}`} className="block text-xs font-medium text-slate-700">New URL identifier</label>
                      <div className="flex flex-wrap gap-2">
                        <input id={`slug-${operator.id}`} value={editingSlug} onChange={(event) => setEditingSlug(event.target.value)} maxLength={63}
                          className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
                        <button type="button" disabled={saving || !editingSlug.trim()} onClick={() => void handleSlugSave(operator)}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50"><FiCheck aria-hidden="true" /> Save</button>
                        <button type="button" disabled={saving} onClick={() => { setEditingId(""); setEditError(""); }}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"><FiX aria-hidden="true" /> Cancel</button>
                      </div>
                      {editError && <p role="alert" className="text-xs text-red-700">{editError}</p>}
                    </div>
                  ) : (
                    <button type="button" onClick={() => { setEditingId(operator.id); setEditingSlug(operator.slug); setEditError(""); }}
                      className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
                      <FiEdit3 aria-hidden="true" /> Edit URL identifier
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 sm:px-6">
              <button type="button" disabled={page <= 1 || listLoading} onClick={() => { setListLoading(true); setPage(page - 1); }}
                className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-[#0D1282] disabled:text-slate-400"><FiArrowLeft aria-hidden="true" /> Previous</button>
              <span className="text-xs text-slate-600">Page {page} of {totalPages}</span>
              <button type="button" disabled={page >= totalPages || listLoading} onClick={() => { setListLoading(true); setPage(page + 1); }}
                className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-[#0D1282] disabled:text-slate-400">Next <FiArrowRight aria-hidden="true" /></button>
            </div>
          )}
        </section>

        <section className="order-1 rounded-2xl border border-slate-200 bg-white p-5 lg:order-2 sm:p-6" aria-labelledby="create-operator-title">
          <div className="flex items-center gap-2">
            <FiPlus aria-hidden="true" className="text-[#0D1282]" />
            <h2 id="create-operator-title" className="text-base font-semibold">Create operator draft</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600">This reserves a portal URL. It does not create staff, clients, shipments or live access.</p>
          <form onSubmit={(event) => void handleCreate(event)} className="mt-5 space-y-4">
            <div>
              <label htmlFor="operator-company" className="mb-1.5 block text-sm font-medium">Company name</label>
              <input id="operator-company" required maxLength={160} value={companyName} onChange={(event) => setCompanyName(event.target.value)}
                placeholder="Example: Atlas Cargo" className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
            </div>
            <div>
              <label htmlFor="operator-slug" className="mb-1.5 block text-sm font-medium">URL identifier <span className="font-normal text-slate-500">(optional)</span></label>
              <input id="operator-slug" maxLength={63} value={customSlug} onChange={(event) => setCustomSlug(event.target.value)}
                placeholder="Uses the company name by default" className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
              <p className="mt-1.5 text-xs leading-5 text-slate-600">The address will be /portal/your-identifier. Old identifiers remain reserved when changed.</p>
            </div>
            {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
            <button type="submit" disabled={saving || !companyName.trim()}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
              <FiPlus aria-hidden="true" /> {saving ? "Creating…" : "Create draft"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function OperatorAdministrators({ operator, onChanged }: { operator: OperatorDraft; onChanged: () => Promise<void> }) {
  const administrators = operator.administrators ?? [];
  const [formOpen, setFormOpen] = useState(operator.status === "DRAFT" && administrators.length === 0);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [linkingUserId, setLinkingUserId] = useState("");
  const [activationLink, setActivationLink] = useState<{ userId: string; url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [activationConfirm, setActivationConfirm] = useState(false);
  const [activationSaving, setActivationSaving] = useState(false);
  const [activationError, setActivationError] = useState("");
  const activeAdministrator = administrators.find((administrator) => administrator.status === "ACTIVE");

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    setActivationLink(null);
    setCopied(false);
    try {
      const result = await inviteOperatorAdministrator(operator.id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim()
      });
      setNotice(result.emailSent
        ? `Invitation email sent to ${result.administrator.email}.`
        : result.emailSkipped
          ? "The invitation is ready, but email delivery is disabled. Issue a copyable link below."
          : "The invitation is ready, but email delivery failed. Issue a copyable link below.");
      setFormOpen(false);
      setFirstName("");
      setLastName("");
      setEmail("");
      await onChanged();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to invite this operator administrator.");
    } finally {
      setSaving(false);
    }
  }

  async function handleIssueLink(administrator: OperatorAdministrator) {
    setLinkingUserId(administrator.userId);
    setError("");
    setNotice("");
    setActivationLink(null);
    setCopied(false);
    try {
      const result = await issueOperatorAdministratorLink(operator.id, administrator.userId);
      setActivationLink({ userId: administrator.userId, url: result.activationUrl, expiresAt: result.expiresAt });
      try {
        await navigator.clipboard.writeText(result.activationUrl);
        setCopied(true);
        setNotice("A fresh invitation link was copied. The previous link is no longer valid.");
      } catch {
        setNotice("A fresh invitation link is ready below. The previous link is no longer valid.");
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to issue an invitation link.");
    } finally {
      setLinkingUserId("");
    }
  }

  async function handleCopyLink() {
    if (!activationLink) return;
    try {
      await navigator.clipboard.writeText(activationLink.url);
      setCopied(true);
      setNotice("Invitation link copied.");
    } catch {
      setCopied(false);
      setNotice("Clipboard access is unavailable. Select and copy the link from the field.");
    }
  }

  async function handleActivatePortal() {
    setActivationError("");
    setActivationSaving(true);
    try {
      await activateOperatorPortal(operator.id);
      setActivationConfirm(false);
      setNotice("Operator portal activated. Its staff and client routes are now available.");
      await onChanged();
    } catch (caughtError) {
      setActivationError(caughtError instanceof Error ? caughtError.message : "Unable to activate this operator portal.");
    } finally {
      setActivationSaving(false);
    }
  }

  return (
    <section className="mt-4 border-t border-slate-200 pt-4" aria-label={`${operator.companyName} administrators`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">Initial administrator</h4>
          <p className="mt-1 text-xs leading-5 text-slate-600">Administrator access is separate from Swiftline staff permissions.</p>
        </div>
        {operator.status === "DRAFT" && administrators.length === 0 && !formOpen ? (
          <button type="button" onClick={() => { setFormOpen(true); setError(""); }}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
            <FiUserPlus aria-hidden="true" /> Invite administrator
          </button>
        ) : null}
      </div>

      {administrators.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {administrators.map((administrator) => (
            <li key={administrator.userId} className="rounded-lg bg-slate-50 px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-slate-900">{administrator.name || `${administrator.firstName} ${administrator.lastName}`.trim()}</p>
                  <p className="mt-0.5 break-all text-xs text-slate-600">{administrator.email}</p>
                  {administrator.status === "INVITED" ? (
                    <p className="mt-1 text-xs leading-5 text-slate-600">{administrator.requiresSignIn ? "Accept using the existing portal password." : "Create a password from the invitation link."}</p>
                  ) : null}
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${administrator.status === "ACTIVE" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : administrator.status === "SUSPENDED" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                  {administrator.status === "INVITED" ? "INVITATION PENDING" : administrator.status === "ACTIVE" ? "INVITE ACCEPTED" : "SUSPENDED"}
                </span>
              </div>
              {administrator.status === "INVITED" && operator.status === "DRAFT" ? (
                <div className="mt-3">
                  <button type="button" disabled={Boolean(linkingUserId)} onClick={() => void handleIssueLink(administrator)}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60">
                    {linkingUserId === administrator.userId ? <FiRefreshCw className="animate-spin" aria-hidden="true" /> : <FiCopy aria-hidden="true" />}
                    Reissue and copy link
                  </button>
                  <p className="mt-1.5 text-xs leading-5 text-slate-600">A new link invalidates any link issued earlier.</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {operator.status === "DRAFT" ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
          {activeAdministrator ? (
            <>
              <p className="text-xs leading-5 text-slate-600">The initial administrator has accepted access. Activating enables this operator&apos;s portal routes.</p>
              {!activationConfirm ? (
                <button type="button" disabled={activationSaving} onClick={() => { setActivationError(""); setActivationConfirm(true); }}
                  className="mt-3 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60">
                  <FiCheck aria-hidden="true" /> Activate portal
                </button>
              ) : (
                <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3" role="group" aria-label={`Confirm activation for ${operator.companyName}`}>
                  <p className="text-sm font-semibold text-blue-950">Activate {operator.companyName}&apos;s portal?</p>
                  <p className="mt-1 text-xs leading-5 text-blue-900">This enables operator staff and client access. It does not create shipments or change Swiftline account workflows.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" disabled={activationSaving} onClick={() => void handleActivatePortal()}
                      className="inline-flex min-h-10 items-center justify-center rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60">
                      {activationSaving ? "Activating…" : "Confirm portal activation"}
                    </button>
                    <button type="button" disabled={activationSaving} onClick={() => setActivationConfirm(false)}
                      className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs leading-5 text-slate-600">Portal activation becomes available after the initial administrator accepts the invitation.</p>
          )}
          {activationError ? <p role="alert" className="mt-2 text-sm text-red-700">{activationError}</p> : null}
        </div>
      ) : null}

      {operator.status === "DRAFT" && formOpen ? (
        <form onSubmit={(event) => void handleInvite(event)} className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`admin-first-${operator.id}`} className="mb-1.5 block text-xs font-medium text-slate-700">First name</label>
            <input id={`admin-first-${operator.id}`} required maxLength={80} autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)}
              className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
          </div>
          <div>
            <label htmlFor={`admin-last-${operator.id}`} className="mb-1.5 block text-xs font-medium text-slate-700">Last name</label>
            <input id={`admin-last-${operator.id}`} required maxLength={80} autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)}
              className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`admin-email-${operator.id}`} className="mb-1.5 block text-xs font-medium text-slate-700">Email address</label>
            <input id={`admin-email-${operator.id}`} type="email" required maxLength={320} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)}
              className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
          </div>
          <p className="text-xs leading-5 text-slate-600 sm:col-span-2">New users create a password from the invite. Existing client users sign in with their current account to accept access.</p>
          {error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{error}</p> : null}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" disabled={saving || !firstName.trim() || !lastName.trim() || !email.trim()}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
              <FiMail aria-hidden="true" /> {saving ? "Sending invitation…" : "Invite administrator"}
            </button>
            <button type="button" disabled={saving} onClick={() => { setFormOpen(false); setError(""); }}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50">
              <FiX aria-hidden="true" /> Cancel
            </button>
          </div>
        </form>
      ) : null}

      {activationLink ? (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <label htmlFor={`activation-link-${operator.id}`} className="mb-1.5 block text-xs font-semibold text-blue-950">Administrator activation link</label>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input id={`activation-link-${operator.id}`} readOnly value={activationLink.url}
              className="min-h-10 min-w-0 flex-1 rounded-lg border border-blue-200 bg-white px-3 text-xs text-slate-800 outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
            <button type="button" onClick={() => void handleCopyLink()}
              className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-blue-300 bg-white px-3 text-sm font-semibold text-blue-950 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
              <FiCopy aria-hidden="true" /> {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-blue-900">Expires {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(activationLink.expiresAt))}.</p>
        </div>
      ) : null}
      {error && !formOpen ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 text-sm leading-5 text-slate-700">{notice}</p> : null}
    </section>
  );
}

function OperatorStatusControl({ operator, onChanged }: { operator: OperatorDraft; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const suspending = operator.status === "ACTIVE";
  const nextStatus = suspending ? "SUSPENDED" : "ACTIVE";

  async function handleChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await updateOperatorStatus(operator.id, nextStatus, reason.trim());
      setOpen(false);
      setReason("");
      await onChanged();
      setNotice(suspending ? "Operator workspace suspended." : "Operator workspace reactivated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the operator status.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4">
      {!open ? (
        <button type="button" onClick={() => { setOpen(true); setError(""); setNotice(""); }}
          className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 ${suspending
            ? "border-red-300 bg-red-50 text-red-800 hover:bg-red-100 focus-visible:outline-red-700"
            : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 focus-visible:outline-emerald-700"}`}>
          {suspending ? <FiPauseCircle aria-hidden="true" /> : <FiPlayCircle aria-hidden="true" />}
          {suspending ? "Suspend workspace" : "Reactivate workspace"}
        </button>
      ) : (
        <form onSubmit={(event) => void handleChange(event)} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4">
          <div>
            <h4 className="text-sm font-semibold">{suspending ? "Suspend" : "Reactivate"} {operator.companyName}?</h4>
            <p className="mt-1 text-xs leading-5 text-slate-600">{suspending
              ? "Staff and clients will lose access to this workspace immediately. Previously queued emails may still be delivered."
              : "Staff and clients with active memberships will regain access to this workspace."}</p>
          </div>
          <div>
            <label htmlFor={`status-reason-${operator.id}`} className="mb-1.5 block text-xs font-semibold text-slate-800">Reason</label>
            <textarea id={`status-reason-${operator.id}`} required minLength={3} maxLength={500} rows={2} value={reason}
              onChange={(event) => setReason(event.target.value)} placeholder="Record why this status is changing"
              className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200" />
          </div>
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving || reason.trim().length < 3}
              className="min-h-10 rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#101a69] disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Saving…" : suspending ? "Confirm suspension" : "Confirm reactivation"}
            </button>
            <button type="button" disabled={saving} onClick={() => { setOpen(false); setReason(""); setError(""); }}
              className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
          </div>
        </form>
      )}
      {notice ? <p role="status" className="mt-2 text-xs text-slate-700">{notice}</p> : null}
    </div>
  );
}

function OperatorSupportAccess({ operator }: { operator: OperatorDraft }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const existing = getOperatorSupportGrant();
      if (existing) await endOperatorSupportSession(existing).catch(() => undefined);
      const result = await startOperatorSupportSession(operator.id, reason.trim());
      storeOperatorSupportGrant(result.support);
      router.push(`/portal/${encodeURIComponent(result.support.operatorSlug)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start operator support access.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4">
      {!formOpen ? (
        <button type="button" onClick={() => { setError(""); setFormOpen(true); }}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-400 bg-amber-50 px-3 text-sm font-semibold text-amber-950 transition hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800">
          <FiEye aria-hidden="true" /> Open read-only support access
        </button>
      ) : (
        <form onSubmit={(event) => void handleStart(event)} className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 sm:p-4">
          <div>
            <h4 className="text-sm font-semibold text-amber-950">Start audited support access</h4>
            <p className="mt-1 text-xs leading-5 text-amber-900">View this operator&apos;s portal for 30 minutes. Opened resources are logged, and portal changes are blocked.</p>
          </div>
          <div>
            <label htmlFor={`support-reason-${operator.id}`} className="mb-1.5 block text-xs font-semibold text-slate-800">Reason for access</label>
            <textarea id={`support-reason-${operator.id}`} required minLength={10} maxLength={500} rows={3} value={reason}
              onChange={(event) => setReason(event.target.value)} placeholder="Describe the support request or investigation"
              className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-5 text-slate-900 outline-none placeholder:text-slate-500 focus:border-amber-700 focus:ring-2 focus:ring-amber-200" />
          </div>
          {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving || reason.trim().length < 10}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-amber-800 px-3 text-sm font-semibold text-white transition hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-900 disabled:cursor-not-allowed disabled:opacity-50">
              <FiEye aria-hidden="true" /> {saving ? "Starting access…" : "Start read-only access"}
            </button>
            <button type="button" disabled={saving} onClick={() => { setFormOpen(false); setReason(""); setError(""); }}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50">
              <FiX aria-hidden="true" /> Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
