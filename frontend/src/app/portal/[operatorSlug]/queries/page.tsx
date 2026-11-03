import OperatorQueriesPage from "@/components/operators/OperatorQueriesPage";

export default async function OperatorQueriesRoute({ params }: { params: Promise<{ operatorSlug: string }> }) {
  const { operatorSlug } = await params;
  return <OperatorQueriesPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
