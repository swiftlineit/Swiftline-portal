import OperatorUsersPage from "@/components/operators/OperatorUsersPage";

export default async function OperatorUsersRoute({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorUsersPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
