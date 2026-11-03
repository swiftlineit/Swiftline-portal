import OperatorTrackingPage from "@/components/operators/OperatorTrackingPage";

export default async function OperatorTrackingRoute({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorTrackingPage key={operatorSlug} operatorSlug={operatorSlug} />;
}
