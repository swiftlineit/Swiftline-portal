import OperatorManifestWorkspace from "@/components/operators/OperatorManifestWorkspace";

export default async function OperatorManifestsPage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorManifestWorkspace key={operatorSlug} operatorSlug={operatorSlug} />;
}
