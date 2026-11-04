import OperatorShipmentCreate from "@/components/operators/OperatorShipmentCreate";

export default async function OperatorShipmentDraftReviewPage({
  params
}: {
  params: Promise<{ operatorSlug: string; draftId: string }>;
}) {
  const { operatorSlug, draftId } = await params;
  return <OperatorShipmentCreate key={`${operatorSlug}:${draftId}`} operatorSlug={operatorSlug} initialDraftId={draftId} />;
}
