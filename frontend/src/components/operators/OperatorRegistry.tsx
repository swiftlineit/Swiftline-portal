"use client";

import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FiArrowLeft, FiArrowRight, FiCheck, FiChevronDown, FiCopy, FiEdit3, FiEye, FiMail, FiPlus, FiRefreshCw, FiTrash2, FiUserPlus, FiX } from "react-icons/fi";
import { DashboardLoading } from "@/components/DashboardShell";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { useAdminUser } from "@/lib/useAdminUser";
import {
  activateOperatorPortal,
  inviteOperatorAdministrator,
  issueOperatorAdministratorLink,
  createOperatorDraft,
  deleteOperatorDraft,
  endOperatorSupportSession,
  listOperatorDrafts,
  startOperatorSupportSession,
  updateOperatorSlug,
  updateOperatorStatus,
  type OperatorDraft,
  type OperatorAdministrator
} from "@/lib/operatorRegistry";
import { getOperatorSupportGrant, storeOperatorSupportGrant } from "@/lib/operatorSupport";

type OperatorWorkspaceAction = "edit" | "support" | "status";

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
  const [workspaceAction, setWorkspaceAction] = useState<{ operatorId: string; action: Exclude<OperatorWorkspaceAction, "edit"> } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OperatorDraft | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deletingId, setDeletingId] = useState("");

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

  async function handleDraftDelete() {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    setDeleteError("");
    try {
      await deleteOperatorDraft(deleteTarget.id);
      setDeleteTarget(null);
      setEditingId("");
      const nextPage = operators.length === 1 && page > 1 ? page - 1 : page;
      await load(nextPage);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Unable to delete this operator draft.");
    } finally {
      setDeletingId("");
    }
  }

  function handleWorkspaceAction(operator: OperatorDraft, action: OperatorWorkspaceAction) {
    if (action === "edit") {
      setEditingId(operator.id);
      setEditingSlug(operator.slug);
      setEditError("");
      setWorkspaceAction(null);
      return;
    }
    setEditingId("");
    setEditError("");
    setWorkspaceAction({ operatorId: operator.id, action });
  }

  const draftOperators = operators.filter((operator) => operator.status === "DRAFT");
  const activatedOperators = operators.filter((operator) => operator.status !== "DRAFT");

  function renderOperatorRows(items: OperatorDraft[]) {
    return (
      <ul className="divide-y divide-slate-200">
        {items.map((operator) => (
          <li key={operator.id} className="px-4 py-3 sm:px-5">
            <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <h3 className="break-words text-sm font-semibold sm:text-base">{operator.companyName}</h3>
                </div>
                <p className="mt-1 break-all text-xs text-slate-600">/portal/{operator.slug}</p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
                {editingId === operator.id ? (
                  <div className="flex basis-full flex-wrap gap-2">
                    <label className="sr-only" htmlFor={`slug-${operator.id}`}>New URL identifier</label>
                    <input id={`slug-${operator.id}`} value={editingSlug} onChange={(event) => setEditingSlug(event.target.value)} maxLength={63}
                      className="min-h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200 lg:w-44 lg:flex-none" />
                    <button type="button" disabled={saving || !editingSlug.trim()} onClick={() => void handleSlugSave(operator)}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50"><FiCheck aria-hidden="true" /> Save</button>
                    <button type="button" disabled={saving} onClick={() => { setEditingId(""); setEditError(""); }}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"><FiX aria-hidden="true" /> Cancel</button>
                    {editError && <p role="alert" className="basis-full text-xs text-red-700">{editError}</p>}
                  </div>
                ) : (
                  <>
                    <button type="button" onClick={() => { setEditingId(operator.id); setEditingSlug(operator.slug); setEditError(""); }}
                      className="inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
                      <FiEdit3 aria-hidden="true" /> Edit URL
                    </button>
                    <button type="button" onClick={() => { setDeleteError(""); setDeleteTarget(operator); }}
                      aria-label={`Delete ${operator.companyName} draft`}
                      className="inline-flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700">
                      <FiTrash2 aria-hidden="true" /> Delete
                    </button>
                  </>
                )}
              </div>
            </div>
            <OperatorAdministrators operator={operator} onChanged={() => load(page, false)} />
          </li>
        ))}
      </ul>
    );
  }

  if (loading) return <DashboardLoading />;
  if (!user) return error ? <p role="alert" className="text-sm text-red-700">{error}</p> : <DashboardLoading />;

  return (
    <div className="w-full min-w-0 space-y-5 pb-8 text-slate-950">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Operators</h1>
          <p className="mt-1.5 text-sm leading-6 text-slate-600">
            Manage operator workspaces, access, and portal addresses.
          </p>
        </div>
        {!listLoading ? <span className="pb-1 text-sm font-medium text-slate-600">{operators.length} on this page</span> : null}
      </header>

      <div className="grid items-stretch gap-5 lg:grid-cols-2">
      <section className="flex h-full min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-4 sm:p-5 lg:order-2 lg:min-h-[320px]" aria-labelledby="create-operator-title">
        <div>
          <h2 id="create-operator-title" className="text-base font-semibold">Create operator draft</h2>
          <p className="mt-1.5 text-sm leading-5 text-slate-600">Reserve a portal address before setup.</p>
        </div>
        <form onSubmit={(event) => void handleCreate(event)} className="mt-5 flex flex-1 flex-col">
          <div className="space-y-5">
            <div className="relative">
              <label htmlFor="operator-company" className="absolute -top-2 left-3 z-10 bg-white px-1.5 text-sm font-medium text-slate-800">Company name <span className="text-red-600">*</span></label>
              <input id="operator-company" required maxLength={160} value={companyName} onChange={(event) => setCompanyName(event.target.value)}
                placeholder="Enter company name" className="min-h-[54px] w-full rounded-md border border-slate-300 bg-white px-4 pt-1 text-sm outline-none transition focus:border-blue-700 focus:ring-2 focus:ring-blue-100" />
            </div>
            <div className="relative">
              <label htmlFor="operator-slug" className="absolute -top-2 left-3 z-10 bg-white px-1.5 text-sm font-medium text-slate-800">URL identifier <span className="font-normal text-slate-500">(optional)</span></label>
              <input id="operator-slug" maxLength={63} value={customSlug} onChange={(event) => setCustomSlug(event.target.value)}
                placeholder="Uses the company name by default" className="min-h-[54px] w-full rounded-md border border-slate-300 bg-white px-4 pt-1 text-sm outline-none transition focus:border-blue-700 focus:ring-2 focus:ring-blue-100" />
            </div>
          </div>
          {formError && <p role="alert" className="mt-3 text-sm text-red-700">{formError}</p>}
          <button type="submit" disabled={saving || !companyName.trim()}
            className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-auto">
            <FiPlus aria-hidden="true" /> {saving ? "Creating…" : "Create draft"}
          </button>
        </form>
      </section>

      <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white lg:order-1 lg:min-h-[320px]" aria-labelledby="draft-operators-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <h2 id="draft-operators-title" className="text-base font-semibold">Drafts</h2>
          <span aria-label={`${draftOperators.length} drafts`} className="inline-flex min-w-7 items-center justify-center rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{draftOperators.length}</span>
        </div>
        {!listLoading && !listError && draftOperators.length > 0 ? (
          <div className="hidden grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600 lg:grid">
            <span>Operator and portal</span>
            <span>Actions</span>
          </div>
        ) : null}
          {listError ? (
            <div role="alert" className="px-4 py-7 text-sm text-red-700 sm:px-5">
              <p>{listError}</p>
              <button type="button" onClick={() => void load(page)} className="mt-2 font-semibold underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-blue-700">Try again</button>
            </div>
          ) : listLoading ? (
            <p className="px-4 py-7 text-sm text-slate-600 sm:px-5" role="status">Loading operators...</p>
          ) : draftOperators.length > 0 ? renderOperatorRows(draftOperators) : (
            <div className="flex flex-1 items-center justify-center px-5 py-10 text-center text-sm text-slate-600">No drafts</div>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 sm:px-5">
              <button type="button" disabled={page <= 1 || listLoading} onClick={() => { setWorkspaceAction(null); setEditingId(""); setEditError(""); setListLoading(true); setPage(page - 1); }}
                className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-[#0D1282] disabled:text-slate-400"><FiArrowLeft aria-hidden="true" /> Previous</button>
              <span className="text-xs text-slate-600">Page {page} of {totalPages}</span>
              <button type="button" disabled={page >= totalPages || listLoading} onClick={() => { setWorkspaceAction(null); setEditingId(""); setEditError(""); setListLoading(true); setPage(page + 1); }}
                className="inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-[#0D1282] disabled:text-slate-400">Next <FiArrowRight aria-hidden="true" /></button>
            </div>
          )}
      </section>
      </div>

      {activatedOperators.length > 0 ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-labelledby="activated-operators-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5">
            <h2 id="activated-operators-title" className="text-base font-semibold">Activated workspaces</h2>
            <span className="text-xs font-medium text-slate-500">{activatedOperators.length} on this page</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] table-fixed text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                <tr>
                  <th scope="col" className="w-[25%] px-5 py-3">Workspace name and URL</th>
                  <th scope="col" className="w-[30%] px-5 py-3">Administrator name and email</th>
                  <th scope="col" className="w-[22%] px-5 py-3">Invite status</th>
                  <th scope="col" className="w-[23%] px-5 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {activatedOperators.map((operator) => {
                  const administrators = operator.administrators ?? [];
                  const editing = editingId === operator.id;
                  const action = workspaceAction?.operatorId === operator.id ? workspaceAction.action : null;
                  return (
                    <Fragment key={operator.id}>
                      <tr className="align-top">
                        <td className="px-5 py-4">
                          {editing ? (
                            <form onSubmit={(event) => { event.preventDefault(); void handleSlugSave(operator); }} className="space-y-2">
                              <label htmlFor={`active-slug-${operator.id}`} className="sr-only">URL identifier</label>
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="text-xs text-slate-500">/portal/</span>
                                <input id={`active-slug-${operator.id}`} value={editingSlug} onChange={(event) => setEditingSlug(event.target.value)} maxLength={63}
                                  className="min-h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-2.5 text-sm outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-100" />
                                <button type="submit" disabled={saving || !editingSlug.trim()} aria-label={`Save URL for ${operator.companyName}`}
                                  className="inline-flex min-h-9 items-center justify-center rounded-lg bg-[#0D1282] px-2.5 text-sm font-semibold text-white hover:bg-[#101a69] disabled:opacity-50"><FiCheck aria-hidden="true" /><span className="sr-only">Save URL</span></button>
                                <button type="button" disabled={saving} onClick={() => { setEditingId(""); setEditError(""); }} aria-label={`Cancel editing ${operator.companyName}`}
                                  className="inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 px-2.5 text-sm text-slate-700 hover:bg-slate-50"><FiX aria-hidden="true" /><span className="sr-only">Cancel</span></button>
                              </div>
                              {editError ? <p role="alert" className="text-xs text-red-700">{editError}</p> : null}
                            </form>
                          ) : (
                            <>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="break-words font-semibold text-slate-900">{operator.companyName}</p>
                                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${operator.status === "ACTIVE" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                                  {operator.status === "ACTIVE" ? "ACTIVE" : "SUSPENDED"}
                                </span>
                              </div>
                              <p className="mt-1 break-all font-mono text-xs text-slate-600">/portal/{operator.slug}</p>
                            </>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          {administrators.length > 0 ? (
                            <div className="space-y-2">
                              {administrators.map((administrator) => (
                                <div key={administrator.userId}>
                                  <p className="break-words font-medium text-slate-900">{administrator.name || `${administrator.firstName} ${administrator.lastName}`.trim() || "Name unavailable"}</p>
                                  <p className="mt-0.5 break-all text-xs text-slate-600">{administrator.email || "Email unavailable"}</p>
                                </div>
                              ))}
                            </div>
                          ) : <span className="text-slate-500">No administrator</span>}
                        </td>
                        <td className="px-5 py-4">
                          {administrators.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {administrators.map((administrator) => {
                                const statusLabel = administrator.status === "ACTIVE" ? "Accepted" : administrator.status === "INVITED" ? "Invitation pending" : "Suspended";
                                const statusStyle = administrator.status === "ACTIVE" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : administrator.status === "INVITED" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-100 text-slate-700";
                                return <span key={administrator.userId} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyle}`}>{statusLabel}</span>;
                              })}
                            </div>
                          ) : <span className="text-slate-500">Not invited</span>}
                        </td>
                        <td className="px-5 py-4">
                          <OperatorWorkspaceActionSelect operator={operator} onAction={(selected) => handleWorkspaceAction(operator, selected)} />
                        </td>
                      </tr>
                      {action ? (
                        <tr>
                          <td colSpan={4} className="bg-slate-50 px-5 py-4">
                            {action === "support" ? (
                              <OperatorSupportAccess operator={operator} onCancel={() => setWorkspaceAction(null)} />
                            ) : (
                              <OperatorStatusControl operator={operator} onChanged={() => load(page, false)} onCancel={() => setWorkspaceAction(null)} />
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Delete operator draft?"
          description={(
            <>
              <p><strong>{deleteTarget.companyName}</strong> will be removed. Pending links stop working, and its reserved URL is released. Existing login accounts stay unchanged.</p>
              {deleteError ? <p role="alert" className="mt-3 text-red-700">{deleteError}</p> : null}
            </>
          )}
          confirmLabel="Delete draft"
          busy={deletingId === deleteTarget.id}
          busyLabel="Deleting…"
          onConfirm={handleDraftDelete}
          onCancel={() => { if (!deletingId) { setDeleteTarget(null); setDeleteError(""); } }}
        />
      ) : null}
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
          <h4 className="text-sm font-semibold text-slate-900">Administrator</h4>
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
                    <p className="mt-1 text-xs leading-5 text-slate-600">{administrator.requiresSignIn ? "Sign in to accept." : "Set a password to accept."}</p>
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
                  <p className="mt-1.5 text-xs leading-5 text-slate-600">Earlier links stop working.</p>
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
              <p className="text-xs leading-5 text-slate-600">Administrator accepted. Activate to open the workspace.</p>
              {!activationConfirm ? (
                <button type="button" disabled={activationSaving} onClick={() => { setActivationError(""); setActivationConfirm(true); }}
                  className="mt-3 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#0D1282] px-3 text-sm font-semibold text-white hover:bg-[#101a69] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60">
                  <FiCheck aria-hidden="true" /> Activate portal
                </button>
              ) : (
                <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3" role="group" aria-label={`Confirm activation for ${operator.companyName}`}>
                  <p className="text-sm font-semibold text-blue-950">Activate {operator.companyName}&apos;s portal?</p>
                  <p className="mt-1 text-xs leading-5 text-blue-900">Operator staff and clients will be able to sign in.</p>
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
          <p className="text-xs leading-5 text-slate-600 sm:col-span-2">New users set a password; existing users sign in.</p>
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

function OperatorWorkspaceActionSelect({ operator, onAction }: { operator: OperatorDraft; onAction: (action: OperatorWorkspaceAction) => void }) {
  const [selection, setSelection] = useState("");

  return (
    <div className="relative w-full max-w-[210px]">
      <label htmlFor={`workspace-action-${operator.id}`} className="sr-only">Actions for {operator.companyName}</label>
      <select
        id={`workspace-action-${operator.id}`}
        value={selection}
        onChange={(event) => {
          const action = event.target.value as OperatorWorkspaceAction | "";
          setSelection("");
          if (action) onAction(action);
        }}
        className="min-h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white py-2 pl-3 pr-9 text-sm font-semibold text-slate-800 outline-none transition hover:border-slate-400 focus:border-blue-700 focus:ring-2 focus:ring-blue-100"
      >
        <option value="">Select action</option>
        <option value="edit">Edit</option>
        <option value="support" disabled={operator.status !== "ACTIVE"}>Open read-only access{operator.status !== "ACTIVE" ? " (activate first)" : ""}</option>
        <option value="status">{operator.status === "ACTIVE" ? "Suspend" : "Activate"}</option>
      </select>
      <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
    </div>
  );
}

function OperatorStatusControl({ operator, onChanged, onCancel }: { operator: OperatorDraft; onChanged: () => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const activating = operator.status === "SUSPENDED";
  const nextStatus = activating ? "ACTIVE" : "SUSPENDED";

  async function handleChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    let completed = false;
    try {
      await updateOperatorStatus(operator.id, nextStatus, reason.trim());
      setReason("");
      await onChanged();
      completed = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the operator status.");
    } finally {
      setSaving(false);
      if (completed) onCancel();
    }
  }

  return (
    <form onSubmit={(event) => void handleChange(event)} className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 sm:p-4">
      <div>
        <h4 className="text-sm font-semibold">{activating ? "Activate" : "Suspend"} {operator.companyName}?</h4>
        <p className="mt-1 text-xs leading-5 text-slate-600">{activating
          ? "Staff and clients with active memberships will regain access to this workspace."
          : "Staff and clients will lose access immediately. Previously queued emails may still be delivered."}</p>
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
          {saving ? "Saving…" : activating ? "Confirm activation" : "Confirm suspension"}
        </button>
        <button type="button" disabled={saving} onClick={() => { setReason(""); setError(""); onCancel(); }}
          className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
      </div>
    </form>
  );
}

function OperatorSupportAccess({ operator, onCancel }: { operator: OperatorDraft; onCancel: () => void }) {
  const router = useRouter();
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
        <button type="button" disabled={saving} onClick={() => { setReason(""); setError(""); onCancel(); }}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50">
          <FiX aria-hidden="true" /> Cancel
        </button>
      </div>
    </form>
  );
}
