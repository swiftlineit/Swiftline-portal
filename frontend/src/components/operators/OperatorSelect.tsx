"use client";

import { FiChevronDown } from "react-icons/fi";

export type OperatorSelectOption = { value: string; label: string };

export default function OperatorSelect({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  variant = "standard"
}: {
  id: string;
  label: string;
  value: string;
  options: OperatorSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  variant?: "standard" | "outlined";
}) {
  const outlined = variant === "outlined";

  return (
    <div className={`min-w-0 ${outlined ? "relative pt-2" : ""}`}>
      <label
        htmlFor={id}
        className={outlined
          ? "absolute left-2 top-0 z-10 bg-white px-1 text-[11px] font-semibold leading-4 text-slate-600"
          : "mb-1.5 block text-sm font-medium text-slate-700"}
      >
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className={`w-full appearance-none bg-white pl-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:cursor-not-allowed disabled:text-slate-500 ${outlined
            ? "h-11 rounded-sm border border-slate-400 pt-1 disabled:bg-white"
            : "min-h-11 rounded-md border border-slate-300 py-2 disabled:bg-slate-100"}`}
        >
          {placeholder ? <option value="">{placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <FiChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      </div>
    </div>
  );
}
