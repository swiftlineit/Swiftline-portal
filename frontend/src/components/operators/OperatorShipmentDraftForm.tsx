"use client";

import ClientDpdDraftReviewPage from "@/app/client/dpd-labels/[draftId]/page";

export default function OperatorShipmentDraftForm({
  operatorSlug,
  shipmentDraftId
}: {
  operatorSlug: string;
  shipmentDraftId: string;
}) {
  return <ClientDpdDraftReviewPage operatorSlug={operatorSlug} initialDraftId={shipmentDraftId} />;
}
