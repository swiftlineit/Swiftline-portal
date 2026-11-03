import { FiLoader } from "react-icons/fi";

export function OperatorLoadingIndicator({ label, className = "" }: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={`flex flex-col items-center justify-center gap-3 text-center ${className}`}
    >
      <FiLoader aria-hidden="true" className="h-5 w-5 animate-spin text-[#0D1282]" />
      <p className="text-sm font-medium text-slate-600">{label}</p>
    </div>
  );
}

export default function OperatorPageLoading({
  label,
  backgroundClassName = "bg-[#EEEDED]"
}: {
  label: string;
  backgroundClassName?: string;
}) {
  return (
    <main className={`min-h-[calc(100dvh-5rem)] ${backgroundClassName}`}>
      <div className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[1440px] items-center justify-center px-3 py-8 sm:px-6 lg:px-8">
        <OperatorLoadingIndicator label={label} />
      </div>
    </main>
  );
}
