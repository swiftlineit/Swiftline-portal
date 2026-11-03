import OperatorCreditPage from "@/components/operators/OperatorCreditPage";

export default async function OperatorCreditRoute({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorCreditPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
