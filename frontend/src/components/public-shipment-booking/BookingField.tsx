import {
  useState,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from "react";
import { FiChevronDown } from "react-icons/fi";
import { toast } from "react-toastify";

export function BookingField({
  label,
  error,
  required,
  revealError = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  required?: boolean;
  revealError?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const showError = Boolean(error && (touched || revealError));
  const suppliedOnBlur = props.onBlur;
  return (
    <label className="block min-w-0 text-sm font-semibold text-slate-600">
      <span>
        {label}
        {required ? (
          <span className="ml-1 text-red-600" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      <input
        {...props}
        required={required}
        aria-invalid={showError}
        onBlur={(event) => {
          setTouched(true);
          suppliedOnBlur?.(event);
          if (error) toast.error(error, { toastId: error });
        }}
        className={`mt-1.5 h-11 w-full rounded-lg border bg-white px-3 text-base tracking-[0.015em] text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-2 sm:text-sm ${showError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : "border-slate-300 focus:border-[#0D1282] focus:ring-[#0D1282]/10"}`}
      />
    </label>
  );
}

export function BookingSelect({
  label,
  error,
  required,
  revealError = false,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
  required?: boolean;
  revealError?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const showError = Boolean(error && (touched || revealError));
  const suppliedOnBlur = props.onBlur;
  return (
    <label className="block min-w-0 text-sm font-semibold text-slate-600">
      <span>
        {label}
        {required ? (
          <span className="ml-1 text-red-600" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      <span className="relative mt-1.5 block">
        <select
          {...props}
          required={required}
          aria-invalid={showError}
          onBlur={(event) => {
            setTouched(true);
            suppliedOnBlur?.(event);
            if (error) toast.error(error, { toastId: error });
          }}
          className={`h-11 w-full appearance-none rounded-lg border bg-white pl-3 pr-12 text-base tracking-[0.015em] text-slate-900 outline-none transition focus:ring-2 sm:text-sm ${showError ? "border-red-400 focus:border-red-500 focus:ring-red-100" : "border-slate-300 focus:border-[#0D1282] focus:ring-[#0D1282]/10"}`}
        >
          {children}
        </select>
        <FiChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        />
      </span>
    </label>
  );
}
