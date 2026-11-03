import OperatorShipmentWorkspace from "@/components/operators/OperatorShipmentWorkspace";

export default async function OperatorShipmentsPage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorShipmentWorkspace key={operatorSlug} operatorSlug={operatorSlug} />;
}
