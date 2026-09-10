"use client";

import { useRef } from "react";
import { FiAlertCircle, FiCheckCircle, FiFileText } from "react-icons/fi";
import InfoTooltip from "@/components/ui/InfoTooltip";
import { getDocumentLabel } from "@/components/business-accounts/FormFieldControls";
import type { DocumentType } from "@/lib/businessAccounts";
import { BsUpload } from "react-icons/bs";

export default function PublicBusinessAccountDocumentCard({
  type,
  required,
  info,
  file,
  error,
  onChange,
}: {
  type: DocumentType;
  required: boolean;
  info?: string;
  file: File | null;
  error?: string;
  onChange: (file: File | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-xl border transition ${error ? "border-red-200 bg-red-50/30" : file ? "border-emerald-200 bg-white" : "border-[#D6E5E7] bg-white hover:border-[#B8D0D4]"}`}
    >
      <div className="flex items-start gap-3 px-3.5 pb-3 pt-3.5">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${file ? "bg-emerald-50 text-emerald-700" : "bg-[#EEF6F6] text-[#0D1282]"}`}
        >
          {file ? (
            <FiCheckCircle className="h-4.5 w-4.5" />
          ) : (
            <FiFileText className="h-4.5 w-4.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="text-sm font-bold text-slate-900">
              {getDocumentLabel(type)}
            </p>
            <span
              className={`rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${required ? " text-red-500 text-[16px]" : " text-slate-500"}`}
            >
              {required ? "*" : "Optional"}
            </span>
            {info ? <InfoTooltip text={info} /> : null}
          </div>
        </div>
      </div>
      <div className="border-t border-[#E8EFEF] bg-[#FAFCFC] px-3.5 py-3">
        {file ? (
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0 flex-1 overflow-hidden">
              <p
                className="block max-w-full truncate text-xs font-semibold text-slate-800"
                title={file.name}
              >
                {file.name}
              </p>
              <p className="mt-0.5 text-[10px] text-slate-500">
                {(file.size / 1024).toFixed(0)} KB
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex h-8 items-center justify-center rounded-md border border-[#C7DADD] bg-white px-2.5 text-[11px] font-semibold text-[#0D1282] transition hover:bg-[#EEF6F6]"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => onChange(null)}
                className="inline-flex h-8 items-center justify-center rounded-md px-2 text-[11px] font-semibold text-[#D71313] transition hover:bg-red-50"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label={`Choose ${getDocumentLabel(type)}`}
            className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-dashed px-3 text-left transition ${error ? "border-red-300 bg-red-50" : "border-[#BBD5DA] bg-white hover:border-[#0D1282]/40 hover:bg-[#F1F8F8]"}`}
          >
            <span className="text-xs font-semibold text-slate-700">
              Choose document
            </span>
            <span className="shrink-0 rounded-md  px-2.5 py-1.5 text-xl font-semibold">
              <BsUpload />
            </span>
          </button>
        )}
        {error ? (
          <p
            role="alert"
            className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-[#D71313]"
          >
            <FiAlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        ) : null}
      </div>
      <input
        ref={fileRef}
        id={`public-doc-${type}`}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        className="sr-only"
      />
    </div>
  );
}
