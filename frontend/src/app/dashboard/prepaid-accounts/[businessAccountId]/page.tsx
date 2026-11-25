import { redirect } from "next/navigation";

export default async function LegacyPaymentsLedgerPage({ params }: { params: Promise<{ businessAccountId: string }> }) {
  const { businessAccountId } = await params;
  redirect(`/dashboard/business-accounts/${encodeURIComponent(businessAccountId)}?tab=ledger#payments-ledger`);
}
