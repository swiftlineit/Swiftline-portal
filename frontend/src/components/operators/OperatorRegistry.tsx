"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck, FiEdit3, FiPlus, FiX } from "react-icons/fi";
import { DashboardLoading } from "@/components/DashboardShell";
import { useAdminUser } from "@/lib/useAdminUser";
import {
  createOperatorDraft,
  listOperatorDrafts,
  updateOperatorSlug,
  type OperatorDraft
} from "@/lib/operatorRegistry";

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

  const load = useCallback(async (targetPage: number) => {
    setListLoading(true);
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
    <div className="mx-auto w-full max-w-6xl space-y-6 pb-10 text-slate-950">
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
