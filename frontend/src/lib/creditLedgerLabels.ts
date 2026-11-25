/**
 * Plain-language names for credit ledger activity.
 *
 * The ledger used to print the raw enum, so a row read
 * "BOOKING CONVERTED" - accurate, and meaningless to anyone who had not read
 * the booking service. Each entry here answers the question a person actually
 * has in front of a ledger: what happened, and which way did the money go.
 */
export type CreditLedgerDirection = "charge" | "credit" | "neutral";

type LedgerLabel = {
  /** What happened, in the words a person would use. */
  label: string;
  /** Why the row exists, and where the money went. */
  detail: string;
  /** Whether this increased what the customer owes, reduced it, or neither. */
  direction: CreditLedgerDirection;
};

const labels: Record<string, LedgerLabel> = {
  CREDIT_REQUESTED: { label: "Credit requested", detail: "Customer applied for a credit facility", direction: "neutral" },
  CREDIT_APPROVED: { label: "Credit approved", detail: "Finance approved the credit limit", direction: "neutral" },
  CREDIT_ACTIVATED: { label: "Credit activated", detail: "Facility is live and available to spend", direction: "neutral" },
  CREDIT_REJECTED: { label: "Credit declined", detail: "The credit request was not approved", direction: "neutral" },
  CREDIT_HOLD_APPLIED: { label: "Credit put on hold", detail: "Spending paused by Swiftline", direction: "neutral" },
  CREDIT_HOLD_RELEASED: { label: "Hold lifted", detail: "Spending resumed", direction: "neutral" },
  LIMIT_CHANGED: { label: "Credit limit changed", detail: "Finance revised the approved limit", direction: "neutral" },
  MIGRATION_OPENING_BALANCE: { label: "Opening balance", detail: "Balance carried in when the account was set up", direction: "neutral" },

  CUSTOMER_ADVANCE_RECEIVED: { label: "Advance received", detail: "Money added to the customer's advance balance", direction: "credit" },

  BOOKING_RESERVED: { label: "Shipment booked", detail: "Funds held for a new shipment", direction: "charge" },
  BOOKING_CONVERTED: { label: "Shipment confirmed", detail: "Held funds charged now the shipment is going ahead", direction: "charge" },
  BOOKING_RELEASED: { label: "Booking released", detail: "Held funds returned - the shipment did not proceed", direction: "credit" },
  BOOKING_REVIEW_REQUIRED: { label: "Booking held for review", detail: "Funds held while Swiftline reviews the shipment", direction: "neutral" },

  AMENDMENT_INCREASE_APPLIED: { label: "Shipment amended - charge increased", detail: "The change made this shipment cost more", direction: "charge" },
  AMENDMENT_REDUCTION_APPLIED: { label: "Shipment amended - charge reduced", detail: "The change made this shipment cost less", direction: "credit" },
  FINAL_CHARGE_INCREASE_APPLIED: { label: "Final weight - charge increased", detail: "Weighed heavier than booked, so the price went up", direction: "charge" },
  FINAL_CHARGE_REDUCTION_APPLIED: { label: "Final weight - charge reduced", detail: "Weighed lighter than booked, so the price came down", direction: "credit" },
  SHIPMENT_CANCELLATION_APPLIED: { label: "Shipment cancelled", detail: "Charges reversed, less any cancellation fee", direction: "credit" },

  BILLING_STATEMENT_ISSUED: { label: "Statement issued", detail: "Shipments grouped into a bill with a due date", direction: "neutral" },
  STATEMENT_PAYMENT_APPLIED: { label: "Payment received", detail: "Payment applied to an outstanding statement", direction: "credit" },
  EXCESS_PAYMENT_TO_ADVANCE: { label: "Overpayment kept as advance", detail: "Paid more than was owed - the rest funds future shipments", direction: "credit" },
  STATEMENT_WRITTEN_OFF: { label: "Statement written off", detail: "Finance cleared the balance without payment", direction: "credit" },

  CREDIT_SUSPENDED: { label: "Credit suspended", detail: "Facility suspended by Swiftline", direction: "neutral" },
  CREDIT_REACTIVATED: { label: "Credit reactivated", detail: "Facility available again", direction: "neutral" },
  CREDIT_CLOSED: { label: "Credit closed", detail: "Facility closed permanently", direction: "neutral" },
  CREDIT_EXPIRED: { label: "Credit expired", detail: "Facility passed its validity date", direction: "neutral" }
};

/** Falls back to a readable version of the raw type for anything not yet named. */
export function creditLedgerLabel(type: string): LedgerLabel {
  return labels[type] ?? {
    label: type.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()),
    detail: "",
    direction: "neutral"
  };
}

/**
 * How a booking was paid for, when the row records it.
 *
 * Returns null for rows that are not a booking, so callers can skip the chip
 * rather than render an empty one.
 */
export function creditLedgerFunding(entry: { advanceAmountMinor?: number | null; creditAmountMinor?: number | null }) {
  const advance = entry.advanceAmountMinor ?? 0;
  const credit = entry.creditAmountMinor ?? 0;
  if (advance <= 0 && credit <= 0) return null;
  if (advance > 0 && credit > 0) return "Credit + Advance";
  return credit > 0 ? "Credit" : "Advance";
}
