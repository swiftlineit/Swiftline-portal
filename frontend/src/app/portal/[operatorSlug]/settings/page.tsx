import OperatorSettingsPage from "@/components/operators/OperatorSettingsPage";

export default async function OperatorSettingsRoute({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorSettingsPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
