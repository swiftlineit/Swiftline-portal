import OperatorBranchesPage from "@/components/operators/OperatorBranchesPage";

export default async function OperatorBranchesRoute({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorBranchesPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
