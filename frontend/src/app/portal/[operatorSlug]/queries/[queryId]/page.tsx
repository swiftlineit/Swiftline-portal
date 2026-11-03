import OperatorQueriesPage from "@/components/operators/OperatorQueriesPage";

export default async function OperatorQueryDetailRoute({ params }: { params: Promise<{ operatorSlug: string; queryId: string }> }) {
  const { operatorSlug, queryId } = await params;
  return <OperatorQueriesPage key={`${operatorSlug}:${queryId}`} operatorSlug={operatorSlug} queryId={queryId} />;
}
