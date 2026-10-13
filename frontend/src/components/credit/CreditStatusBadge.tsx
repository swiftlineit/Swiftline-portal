import type { CreditAccountStatus } from "@/lib/creditAccounts";

// Palette: #0D1282 (indigo), #EEEDED (neutral), #F0DE36 (yellow), #D71313 (red)
// Filled = definitive/live states, outlined = transitional/in-review, muted = terminal/inactive.
const tones: Record<CreditAccountStatus, string> = {
  NOT_REQUESTED: "bg-[#F3F4F6] text-[#4B5563] border-[#D1D5DB]",
  PENDING_REVIEW: "bg-[#FEF3C7] text-[#A16207] border-[#FCD34D]",
  APPROVED: "bg-[#E8E9F6] text-[#0D1282] border-[#C4C6EC]",
  ACTIVE: "bg-[#DCFCE7] text-[#15803D] border-[#86EFAC]",
  ON_HOLD: "bg-[#FFF7ED] text-[#C2410C] border-[#FDBA74]",
  SUSPENDED: "bg-[#FFF7ED] text-[#C2410C] border-[#FDBA74]",
  EXPIRED: "bg-[#F3F4F6] text-[#6B7280] border-[#D1D5DB]",
  REJECTED: "bg-[#FEE2E2] text-[#B91C1C] border-[#FCA5A5]",
  CLOSED: "bg-[#F3F4F6] text-[#4B5563] border-[#D1D5DB]"
};
export default function CreditStatusBadge({ status }: { status: CreditAccountStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${tones[status]}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
