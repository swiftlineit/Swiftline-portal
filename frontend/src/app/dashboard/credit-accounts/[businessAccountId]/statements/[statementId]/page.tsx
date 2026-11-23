import { redirect } from "next/navigation";

export default async function StaffCreditStatementPage({ params }: { params: Promise<{ businessAccountId: string }> }) {
  const { businessAccountId } = await params;
  redirect(`/dashboard/prepaid-accounts/${encodeURIComponent(businessAccountId)}#wallet-ledger`);
}
