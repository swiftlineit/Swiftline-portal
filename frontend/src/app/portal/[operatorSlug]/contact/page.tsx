import OperatorContactPage from "@/components/operators/OperatorContactPage";

export default async function OperatorContactRoute({ params }: { params: Promise<{ operatorSlug: string }> }) {
  const { operatorSlug } = await params;
  return <OperatorContactPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
