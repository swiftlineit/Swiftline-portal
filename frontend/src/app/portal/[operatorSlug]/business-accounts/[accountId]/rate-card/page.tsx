import OperatorRateCardPage from "@/components/operators/OperatorRateCardPage";

export default async function OperatorBusinessAccountRateCardPage({
  params
}: {
  params: Promise<{ operatorSlug: string; accountId: string }>;
}) {
  const { operatorSlug, accountId } = await params;
  return <OperatorRateCardPage key={`${operatorSlug}:${accountId}`} operatorSlug={operatorSlug} accountId={accountId} />;
}
