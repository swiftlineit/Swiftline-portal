import OperatorPortalHome from "@/components/operators/OperatorPortalHome";

export default async function OperatorPortalPage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorPortalHome key={operatorSlug} operatorSlug={operatorSlug} />;
}
