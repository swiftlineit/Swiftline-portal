"use client";

import { useState, type FormEvent } from "react";
import {
  emptyBusinessAddress,
  updateOperatorBusinessAccountBillingAddress,
  type BusinessAccount,
  type BusinessAddress
} from "@/lib/businessAccounts";

function accountContactName(account: BusinessAccount) {
  return [account.contact.title, account.contact.firstName, account.contact.lastName]
    .filter(Boolean)
    .join(" ");
}

function formatAddress(address?: BusinessAddress | null) {
  if (!address) return "";
  return [
    address.addressLine1,
    address.addressLine2,
    address.city,
    address.stateOrProvince,
    address.postalCode,
    address.country
  ].map((part) => part?.trim()).filter(Boolean).join(", ");
}

function TextField({
  label,
  value,
  onChange,
  required = false,
  maxLength = 80
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  maxLength?: number;
}) {
  const id = `operator-invoice-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label htmlFor={id} className="block min-w-0 text-sm font-medium text-slate-700">
      {label}{required ? <span aria-hidden="true" className="text-rose-600"> *</span> : null}
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        maxLength={maxLength}
        className="mt-1.5 min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15"
      />
    </label>
  );
}

export default function OperatorBusinessAccountBillingAddress({
  account,
  operatorSlug,
  canEdit,
  onUpdated
}: {
  account: BusinessAccount;
  operatorSlug: string;
  canEdit: boolean;
  onUpdated: (account: BusinessAccount) => void;
}) {
  const savedAddress = account.company.billingAddress ?? emptyBusinessAddress;
  const [draft, setDraft] = useState<BusinessAddress>(() => ({ ...savedAddress }));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const recipientName = accountContactName(account);
  const addressLine = formatAddress(savedAddress);

  function cancelEdit() {
    setDraft({ ...(account.company.billingAddress ?? emptyBusinessAddress) });
    setError("");
    setEditing(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await updateOperatorBusinessAccountBillingAddress(
        account.accountId,
        draft,
        operatorSlug
      );
      setDraft({ ...(result.account.company.billingAddress ?? emptyBusinessAddress) });
      onUpdated(result.account);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The billing address could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <h2 className="font-semibold text-slate-950">Invoice recipient</h2>
          <p className="mt-1 text-sm text-slate-600">Tax invoices use the account contact and this billing address.</p>
        </div>
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => { setError(""); setEditing(true); }}
            className="inline-flex min-h-10 items-center justify-center self-start rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282] sm:self-auto"
          >
            {addressLine ? "Edit billing address" : "Add billing address"}
          </button>
        ) : null}
      </div>

      <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bill to</p>
          <p className="mt-1 break-words text-sm font-medium text-slate-900">{recipientName || "Account contact not recorded"}</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billing address</p>
          {addressLine ? (
            <p className="mt-1 break-words text-sm leading-6 text-slate-900">{addressLine}</p>
          ) : (
            <p className="mt-1 text-sm leading-6 text-amber-800">
              Add an address to complete the Bill To section on future tax invoices.
            </p>
          )}
        </div>
      </div>

      {editing ? (
        <form onSubmit={save} className="space-y-4 border-t border-slate-200 bg-slate-50/70 p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <TextField label="Address line 1" value={draft.addressLine1} required maxLength={500} onChange={(value) => setDraft((current) => ({ ...current, addressLine1: value }))} />
            </div>
            <div className="sm:col-span-2">
              <TextField label="Address line 2" value={draft.addressLine2} maxLength={200} onChange={(value) => setDraft((current) => ({ ...current, addressLine2: value }))} />
            </div>
            <TextField label="City" value={draft.city} required onChange={(value) => setDraft((current) => ({ ...current, city: value }))} />
            <TextField label="State or province" value={draft.stateOrProvince} required onChange={(value) => setDraft((current) => ({ ...current, stateOrProvince: value }))} />
            <TextField label="Postal code" value={draft.postalCode} required maxLength={20} onChange={(value) => setDraft((current) => ({ ...current, postalCode: value }))} />
            <TextField label="Country" value={draft.country} required onChange={(value) => setDraft((current) => ({ ...current, country: value }))} />
          </div>
          {error ? <p role="alert" className="text-sm font-medium text-rose-700">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={cancelEdit} disabled={saving} className="min-h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving} className="min-h-10 rounded-md bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#10166F] disabled:cursor-wait disabled:opacity-60">{saving ? "Saving…" : "Save address"}</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
