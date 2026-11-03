import OperatorBusinessAccountDetail from "@/components/operators/OperatorBusinessAccountDetail";

export default async function OperatorBusinessAccountPage({
  params
}: {
  params: Promise<{ operatorSlug: string; accountId: string }>;
}) {
  const { operatorSlug, accountId } = await params;
  return <OperatorBusinessAccountDetail key={`${operatorSlug}:${accountId}`} operatorSlug={operatorSlug} accountId={accountId} />;
}
