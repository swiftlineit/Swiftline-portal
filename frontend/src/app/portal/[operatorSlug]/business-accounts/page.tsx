import OperatorBusinessAccountsPage from "@/components/operators/OperatorBusinessAccountsPage";

export default async function OperatorBusinessAccountsRoute({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorBusinessAccountsPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
