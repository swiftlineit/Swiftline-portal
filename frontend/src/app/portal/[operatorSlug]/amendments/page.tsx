import OperatorAmendmentQueue from "@/components/operators/OperatorAmendmentQueue";

export default async function OperatorAmendmentsPage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorAmendmentQueue operatorSlug={operatorSlug} />;
}
