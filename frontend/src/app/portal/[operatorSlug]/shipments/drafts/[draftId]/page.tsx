import OperatorShipmentDraftForm from "@/components/operators/OperatorShipmentDraftForm";

export default async function OperatorShipmentDraftReviewPage({
  params
}: {
  params: Promise<{ operatorSlug: string; draftId: string }>;
}) {
  const { operatorSlug, draftId } = await params;
  return <OperatorShipmentDraftForm key={draftId} operatorSlug={operatorSlug} shipmentDraftId={draftId} />;
}
