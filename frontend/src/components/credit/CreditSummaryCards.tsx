import { CreditAccount, formatCreditMoney } from "@/lib/creditAccounts";
import { formatDashboardDate } from "@/lib/dateFormat";

/**
 * The billing figures a customer opens this page to read.
 *
 * Two rows, split by what the numbers mean. The facility row is what was
 * granted and what is left to spend; it reads the same every day. The owed row
 * is what is actually due, which is the half that moves and the half somebody
 * is usually chasing.
 *
 * Both rows auto-fit, so a row is always full regardless of how many cards it
 * holds - the card count varies with what the caller can see.
 */
const gridClass = "grid gap-3 grid-cols-[repeat(auto-fit,minmax(190px,1fr))]";

export default function CreditSummaryCards({ account }: { account: CreditAccount }) {
  const billing = account.billing ?? null;
  const money = (valueMinor?: number) => formatCreditMoney(valueMinor, account.currency);

  /** What the facility grants, and what is still spendable against it. */
  const facilityCards = [
    { label: "Approved Limit", value: money(account.approvedCreditLimitMinor), detail: "Finance-approved credit" },
    { label: "Used Credit", value: money(account.usedCreditMinor), detail: "Reserved, unbilled and outstanding" },
    {
      label: "Available Credit",
      value: money(account.availableCreditMinor),
      detail: account.restriction?.level === "ALL_BOOKINGS_BLOCKED"
        ? "Bookings currently blocked"
        : account.restriction?.level === "CREDIT_BLOCKED"
          ? "Credit blocked - advance only"
          : "Left to spend on credit"
    },
    {
      label: "Customer Advance",
      value: money(account.availableAdvanceMinor),
      // Advance is spent before credit on every booking, which is not obvious
      // from the number alone.
      detail: "Customer advance funds, spent first"
    }
  ];

  /**
   * Amounts owed, at each stage of reaching a bill.
   *
   * Rendered plainly rather than in the blue facility tiles: money owed needs to
   * look different from an approved limit, and a red figure among identical blue
   * ones is easy to miss.
   *
   * Only Overdue depends on statement data. The rest come from the account
   * itself, so they are shown to everyone who can see the page - gating them
   * behind statement data hid real balances from the admin view entirely.
   */
  const owedCards: Array<{ label: string; value: string; detail: string; tone: string }> = [
    {
      label: "Unbilled",
      value: money(account.unbilledCreditMinor),
      detail: "Shipped, not yet on a statement",
      tone: "text-slate-950"
    },
    {
      label: "Billed Outstanding",
      value: money(account.invoicedOutstandingMinor),
      detail: billing?.nextDueAt ? `Due ${formatDashboardDate(billing.nextDueAt)}` : "Invoiced and not yet paid",
      tone: "text-red-600"
    },
    {
      label: "Total Owed",
      value: money(account.totalOwedMinor),
      detail: "Unbilled plus invoiced",
      tone: "text-slate-950"
    }
  ];

  if (billing) {
    const overdueMinor = billing.overdueAmountMinor ?? 0;
    owedCards.push({
      label: "Overdue",
      value: money(overdueMinor),
      detail: billing.overdueStatementCount
        ? `${billing.overdueStatementCount} statement${billing.overdueStatementCount === 1 ? "" : "s"} past due`
        : "Nothing past its due date",
      // Only coloured when there is something to be alarmed about.
      tone: overdueMinor > 0 ? "text-red-700" : "text-slate-950"
    });
  }

  return (
    <div className="space-y-3">
      <section id="credit-summary" className={gridClass}>
        {facilityCards.map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-slate-300 bg-linear-to-r from-blue-500 via-blue-400 to-blue-400 p-4 text-white"
          >
            <p className="text-xs font-semibold uppercase">{card.label}</p>
            <p className="mt-3 text-lg font-semibold wrap-break-word">{card.value}</p>
            <p className="mt-1 text-xs">{card.detail}</p>
          </div>
        ))}
      </section>

      <section className={gridClass}>
        {owedCards.map((card) => (
          <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase text-slate-500">{card.label}</p>
            <p className={`mt-3 text-lg font-semibold wrap-break-word ${card.tone}`}>{card.value}</p>
            <p className="mt-1 text-xs text-slate-500">{card.detail}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
