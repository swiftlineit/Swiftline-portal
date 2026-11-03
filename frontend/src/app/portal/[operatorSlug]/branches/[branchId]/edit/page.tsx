import OperatorBranchFormPage from "@/components/operators/OperatorBranchFormPage";

export default async function EditOperatorBranchRoute({
  params
}: {
  params: Promise<{ operatorSlug: string; branchId: string }>;
}) {
  const { operatorSlug, branchId } = await params;
  return <OperatorBranchFormPage key={`${operatorSlug}:${branchId}`} operatorSlug={operatorSlug} branchId={branchId} />;
}
