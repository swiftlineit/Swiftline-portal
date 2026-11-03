import OperatorBranchDetailPage from "@/components/operators/OperatorBranchDetailPage";

export default async function OperatorBranchDetailsRoute({
  params,
  searchParams
}: {
  params: Promise<{ operatorSlug: string; branchId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { operatorSlug, branchId } = await params;
  const { tab } = await searchParams;
  const initialTab = tab === "users" ? "users" : "overview";
  return <OperatorBranchDetailPage key={`${operatorSlug}:${branchId}`} operatorSlug={operatorSlug} branchId={branchId} initialTab={initialTab} />;
}
