import OperatorBranchFormPage from "@/components/operators/OperatorBranchFormPage";

export default async function NewOperatorBranchRoute({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorBranchFormPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
