import OperatorBranchUserProfilePage from "@/components/operators/OperatorBranchUserProfilePage";

export default async function OperatorBranchUserProfileRoute({
  params
}: {
  params: Promise<{ operatorSlug: string; branchId: string; membershipId: string }>;
}) {
  const { operatorSlug, branchId, membershipId } = await params;
  return <OperatorBranchUserProfilePage key={`${operatorSlug}:${branchId}:${membershipId}`} operatorSlug={operatorSlug} branchId={branchId} membershipId={membershipId} />;
}
