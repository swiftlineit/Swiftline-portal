import OperatorShipmentCreate from "@/components/operators/OperatorShipmentCreate";

export default async function OperatorShipmentCreatePage({
  params,
  searchParams
}: {
  params: Promise<{ operatorSlug: string }>;
  searchParams: Promise<{ draftId?: string | string[] }>;
}) {
  const [{ operatorSlug }, query] = await Promise.all([params, searchParams]);
  const initialDraftId = typeof query.draftId === "string" ? query.draftId : "";
  return <OperatorShipmentCreate operatorSlug={operatorSlug} initialDraftId={initialDraftId} />;
}
