import OperatorCancellationQueue from "@/components/operators/OperatorCancellationQueue";

export default async function OperatorCancellationsPage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return <OperatorCancellationQueue key={operatorSlug} operatorSlug={operatorSlug} />;
}
