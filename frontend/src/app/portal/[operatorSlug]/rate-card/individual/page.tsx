import OperatorIndividualRateCardPage from "@/components/operators/OperatorIndividualRateCardPage";

export default async function OperatorIndividualRateCardViewPage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorIndividualRateCardPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
