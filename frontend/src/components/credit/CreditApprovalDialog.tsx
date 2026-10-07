"use client";

import { FormEvent, useState } from "react";
import { FiChevronDown, FiX } from "react-icons/fi";
import {
  approveCreditAccount,
  CreditAccount,
  CreditApprovalInput,
  formatCreditMoney,
  MAX_CREDIT_LIMIT_LABEL,
  MAX_CREDIT_LIMIT_RUPEES
} from "@/lib/creditAccounts";

type FormState = {
  limitRupees: string; paymentTermsDays: CreditApprovalInput["paymentTermsDays"];
  billingCycle: CreditApprovalInput["billingCycle"]; validFrom: string; validUntil: string;
  gracePeriodDays: string; maxOverdueDays: string; warningPercent: string;
  depositRupees: string; riskCategory: CreditApprovalInput["riskCategory"];
  internalRemarks: string; reason: string;
};

const inputClass = "h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";
const selectClass = "h-9 w-full appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-7 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";
const textareaClass = "min-h-[52px] w-full resize-none rounded-lg border border-slate-200 p-2.5 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/10";
const allowedPaymentTerms = [0, 7, 15, 30, 45] as const;

function normalizePaymentTerms(value: number): CreditApprovalInput["paymentTermsDays"] {
  return allowedPaymentTerms.find((days) => days === value) ?? 30;
}

function initialState(account: CreditAccount): FormState {
  return {
    limitRupees: String(
      (account.limitIncreaseRequest?.requestedLimitMinor
        || account.approvedCreditLimitMinor
        || account.requestedCreditLimitMinor
        || 0) / 100 || ""
    ),
    paymentTermsDays: normalizePaymentTerms(account.paymentTermsDays),
    billingCycle: account.billingCycle || "MONTHLY",
    validFrom: account.validFrom?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    validUntil: account.validUntil?.slice(0, 10) || "",
    gracePeriodDays: String(account.gracePeriodDays ?? 0), maxOverdueDays: String(account.maxOverdueDays ?? 30),
    warningPercent: String(account.creditWarningThresholdPercent ?? 70),
    depositRupees: String((account.securityDepositRequiredMinor || 0) / 100 || ""),
    riskCategory: account.riskCategory || "MEDIUM", internalRemarks: account.internalRemarks || "", reason: ""
  };
}

export default function CreditApprovalDialog({ account, onClose, onSaved }: {
  account: CreditAccount; onClose: () => void; onSaved: (message: string) => Promise<void>;
}) {
  const [form, setForm] = useState(() => initialState(account));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const company = account.businessAccount?.companyName || account.businessAccount?.accountId || "Business account";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const limitMinor = Math.round(Number(form.limitRupees) * 100);
    const depositMinor = Math.round(Number(form.depositRupees || 0) * 100);
    if (!Number.isInteger(limitMinor) || limitMinor <= 0) { setError("Enter an approved credit limit greater than zero."); return; }
    if (Number(form.limitRupees) > MAX_CREDIT_LIMIT_RUPEES) { setError(`Approved credit limit cannot exceed ${MAX_CREDIT_LIMIT_LABEL}.`); return; }
    if (!Number.isInteger(depositMinor) || depositMinor < 0) { setError("Enter a valid security deposit amount."); return; }
    if (form.reason.trim().length < 5) { setError("Provide a reason for this credit decision."); return; }

    setBusy(true); setError("");
    try {
      const result = await approveCreditAccount(account.businessAccountId, {
        approvedCreditLimitMinor: limitMinor, paymentTermsDays: form.paymentTermsDays,
        billingCycle: form.billingCycle, validFrom: form.validFrom, validUntil: form.validUntil,
        gracePeriodDays: Number(form.gracePeriodDays), maxOverdueDays: Number(form.maxOverdueDays),
        creditWarningThresholdPercent: Number(form.warningPercent), securityDepositRequiredMinor: depositMinor,
        riskCategory: form.riskCategory, internalRemarks: form.internalRemarks, reason: form.reason
      });
      await onSaved(result.message);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to approve this credit facility.");
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="credit-approval-title">
      <div className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-3">
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
              style={{ backgroundColor: "#0D1282" }}
            >
              {company.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h2 id="credit-approval-title" className="text-base font-bold leading-tight text-slate-900">{company}</h2>
              <p className="text-xs text-slate-500">{account.businessAccount?.accountId} · Credit facility</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            title="Close"
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:bg-slate-50"
          >
            <FiX aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {account.limitIncreaseRequest ? (
              <div className="rounded-lg border-l-4 border-[#0D1282] bg-[#EEF0FB] px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[#0D1282]">
                  Limit increase requested
                </p>
                <p className="mt-0.5 text-sm text-slate-800">
                  {formatCreditMoney(account.limitIncreaseRequest.currentLimitMinor, account.currency)}
                  {" → "}
                  <strong>{formatCreditMoney(account.limitIncreaseRequest.requestedLimitMinor, account.currency)}</strong>
                  {" · "}{account.limitIncreaseRequest.reason}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Saving any limit here answers this request.
                </p>
              </div>
            ) : null}
            {account.requestReason ? (
              <div className="rounded-lg border-l-4 border-[#F0DE36] bg-[#FDF8DC] px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[#7A6A00]">Customer Request</p>
                <p className="mt-0.5 text-sm text-slate-800">{account.requestReason}</p>
              </div>
            ) : null}

            <Section title="Facility terms">
              <Field label="Approved Limit (INR)"><input type="number" min="1" max={MAX_CREDIT_LIMIT_RUPEES} step="0.01" value={form.limitRupees} onChange={(event) => setForm({ ...form, limitRupees: event.target.value })} className={inputClass} /></Field>
              <Field label="Payment Terms">
                <SelectWrap>
                  <select value={form.paymentTermsDays} onChange={(event) => setForm({ ...form, paymentTermsDays: normalizePaymentTerms(Number(event.target.value)) })} className={selectClass}>
                    {allowedPaymentTerms.map((days) => <option key={days} value={days}>{days ? `${days} days` : "Due immediately"}</option>)}
                  </select>
                </SelectWrap>
              </Field>
              <Field label="Billing Cycle">
                <SelectWrap>
                  <select value={form.billingCycle} onChange={(event) => setForm({ ...form, billingCycle: event.target.value as FormState["billingCycle"] })} className={selectClass}>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </select>
                </SelectWrap>
              </Field>
              <Field label="Valid From"><input type="date" value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })} className={inputClass} /></Field>
              <Field label="Valid Until"><input type="date" value={form.validUntil} onChange={(event) => setForm({ ...form, validUntil: event.target.value })} className={inputClass} /></Field>
            </Section>

            <Section title="Risk & controls">
              <Field label="Risk Category">
                <SelectWrap>
                  <select value={form.riskCategory} onChange={(event) => setForm({ ...form, riskCategory: event.target.value as FormState["riskCategory"] })} className={selectClass}>
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </select>
                </SelectWrap>
              </Field>
              <Field label="Grace Period (Days)"><input type="number" min="0" max="90" value={form.gracePeriodDays} onChange={(event) => setForm({ ...form, gracePeriodDays: event.target.value })} className={inputClass} /></Field>
              <Field label="Max Overdue Days"><input type="number" min="0" max="365" value={form.maxOverdueDays} onChange={(event) => setForm({ ...form, maxOverdueDays: event.target.value })} className={inputClass} /></Field>
              <Field label="Warning Threshold (%)">
                <input type="number" min="1" max="100" value={form.warningPercent} onChange={(event) => setForm({ ...form, warningPercent: event.target.value })} className={inputClass} />
                <p className="mt-1 text-[11px] leading-4 text-slate-500">
                  Show a warning when this percentage of the approved credit is used. For example, 70 means 70% used.
                </p>
              </Field>
              <Field label="Required Deposit (INR)"><input type="number" min="0" step="0.01" value={form.depositRupees} onChange={(event) => setForm({ ...form, depositRupees: event.target.value })} className={inputClass} /></Field>
            </Section>

            <Section title="Notes">
              <Field label="Internal Remarks" span2><textarea rows={2} value={form.internalRemarks} onChange={(event) => setForm({ ...form, internalRemarks: event.target.value })} className={textareaClass} /></Field>
              <Field label="Decision Reason" span2 required><textarea required rows={2} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} className={textareaClass} /></Field>
            </Section>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
            {/* Kept beside Save: the form scrolls, and an error at the top of it
                was out of view from the button that produced it. */}
            {error ? (
              <p
                role="alert"
                className="mr-auto flex items-center gap-2 text-sm font-semibold text-[#D71313]"
              >
                <FiX className="shrink-0" size={14} aria-hidden="true" />
                {error}
              </p>
            ) : null}
            <button type="button" onClick={onClose} disabled={busy} className="h-9 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50">Cancel</button>
            <button
              type="submit"
              disabled={busy}
              className="h-9 rounded-lg px-5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: "#0D1282" }}
            >
              {busy ? "Saving..." : "Approve Credit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
      <div className="mb-2.5 flex items-center gap-2">
        {/* <span className="h-3 w-1 rounded-full" style={{ backgroundColor: "#0D1282" }} /> */}
        {/* <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</h3> */}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
    </div>
  );
}

function SelectWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <FiChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={13} />
    </div>
  );
}

function Field({ label, children, span2, required }: { label: string; children: React.ReactNode; span2?: boolean; required?: boolean }) {
  return (
    <label className={`block ${span2 ? "col-span-2 sm:col-span-3 lg:col-span-5" : ""}`}>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
        {required ? <span className="ml-0.5 text-[#D71313]">*</span> : null}
      </span>
      {children}
    </label>
  );
}
