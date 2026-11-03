import OperatorBusinessAccountCreate from "@/components/operators/OperatorBusinessAccountCreate";

export default async function OperatorBusinessAccountCreatePage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorBusinessAccountCreate operatorSlug={operatorSlug} />;
}
