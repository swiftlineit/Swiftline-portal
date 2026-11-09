"use client";

import ClientDpdDraftReview from "@/components/shipments/ClientDpdDraftReview";

export default function OperatorShipmentDraftForm({
  operatorSlug,
  shipmentDraftId
}: {
  operatorSlug: string;
  shipmentDraftId: string;
}) {
  return <ClientDpdDraftReview operatorSlug={operatorSlug} initialDraftId={shipmentDraftId} />;
}
