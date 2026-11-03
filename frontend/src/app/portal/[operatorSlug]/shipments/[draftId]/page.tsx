import OperatorShipmentDetail from "@/components/operators/OperatorShipmentDetail";

export default async function OperatorShipmentDetailPage({
  params
}: {
  params: Promise<{ operatorSlug: string; draftId: string }>;
}) {
  const { operatorSlug, draftId } = await params;
  return <OperatorShipmentDetail key={`${operatorSlug}:${draftId}`} operatorSlug={operatorSlug} shipmentDraftId={draftId} />;
}
