"use client";

import { ShipmentTextField } from "@/components/shipments/ShipmentFormControls";
import type { CsbVBookingDetails, CsbVBookingIssues } from "@/lib/csbVBooking";

export function CsbVBookingFields({
  value,
  onChange,
  issues,
  revealError
}: {
  value: CsbVBookingDetails;
  onChange: (next: CsbVBookingDetails) => void;
  issues: CsbVBookingIssues;
  revealError: boolean;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ShipmentTextField
        label="GSTIN Number"
        value={value.gstin}
        onChange={(event) => onChange({ ...value, gstin: event.target.value.toUpperCase() })}
        error={issues.gstin}
        revealError={revealError}
        required
        maxLength={20}
        placeholder="15-character GSTIN"
      />
      <ShipmentTextField
        label="Account Number"
        value={value.accountNumber}
        onChange={(event) => onChange({ ...value, accountNumber: event.target.value })}
        error={issues.accountNumber}
        revealError={revealError}
        required
        maxLength={40}
      />
      <ShipmentTextField
        label="Commercial Invoice Number"
        value={value.invoiceNumber}
        onChange={(event) => onChange({ ...value, invoiceNumber: event.target.value })}
        error={issues.invoiceNumber}
        revealError={revealError}
        required
        maxLength={80}
      />
    </div>
  );
}
