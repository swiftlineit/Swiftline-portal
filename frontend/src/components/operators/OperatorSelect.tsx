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
  disabled = false
}: {
  id: string;
  label: string;
  value: string;
  options: OperatorSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className="min-h-11 w-full appearance-none rounded-md border border-slate-300 bg-white py-2 pl-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
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
