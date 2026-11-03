import OperatorClientRateCardPage from "@/components/operators/OperatorClientRateCardPage";

export default async function OperatorRateCardViewPage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorClientRateCardPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
