import OperatorUserProfilePage from "@/components/operators/OperatorUserProfilePage";
import { notFound } from "next/navigation";

export default async function OperatorUserProfileRoute({
  params
}: {
  params: Promise<{ operatorSlug: string; audience: string; membershipId: string }>;
}) {
  const { operatorSlug, audience, membershipId } = await params;
  if (audience !== "team" && audience !== "clients") notFound();
  return (
    <OperatorUserProfilePage
      key={`${operatorSlug}:${audience}:${membershipId}`}
      operatorSlug={operatorSlug}
      audience={audience}
      membershipId={membershipId}
    />
  );
}
