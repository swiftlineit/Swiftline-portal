"use client";

export type ShipmentRowAction =
  | "view"
  | "invoice"
  | "rebook"
  | "dpd-label"
  | "swiftline-label"
  | "delete"
  | "cancel";

export type ShipmentRowActionOption = {
  value: ShipmentRowAction;
  label: string;
};

export function getShipmentRowActionOptions(input: {
  canRebook: boolean;
  canDelete: boolean;
  canCancel: boolean;
  hasDpdLabel: boolean;
}): ShipmentRowActionOption[] {
  return [
    { value: "view", label: "View details" },
    { value: "invoice", label: "Invoice" },
    ...(input.canRebook ? [{ value: "rebook" as const, label: "Rebook" }] : []),
    ...(input.hasDpdLabel ? [{ value: "dpd-label" as const, label: "DPD label" }] : []),
    { value: "swiftline-label", label: "Swiftline label" },
    ...(input.canDelete ? [{ value: "delete" as const, label: "Delete" }] : []),
    ...(input.canCancel ? [{ value: "cancel" as const, label: "Cancel shipment" }] : [])
  ];
}

export default function ShipmentRowActions({
  shipmentLabel,
  options,
  disabled = false,
  onAction
}: {
  shipmentLabel: string;
  options: ShipmentRowActionOption[];
  disabled?: boolean;
  onAction: (action: ShipmentRowAction) => void;
}) {
  return (
    <label className="relative inline-flex min-w-36">
      <span className="sr-only">Actions for shipment {shipmentLabel}</span>
      <select
        aria-label={`Actions for shipment ${shipmentLabel}`}
        value=""
        disabled={disabled}
        onChange={(event) => {
          const action = event.target.value as ShipmentRowAction;
          if (action) onAction(action);
        }}
        className="h-9 w-full appearance-none rounded-md border border-slate-300 bg-white py-0 pl-3 pr-10 text-sm font-semibold text-slate-700 outline-none transition hover:border-slate-400 focus-visible:border-[#0D1282] focus-visible:ring-2 focus-visible:ring-[#0D1282]/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="" disabled>Actions</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
      >
        <path d="m5.5 7.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  );
}
