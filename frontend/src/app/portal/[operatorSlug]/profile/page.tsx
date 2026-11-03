import ProfilePage from "@/components/profile/ProfilePage";

export default async function OperatorClientProfilePage({
  params
}: {
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;

  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-50">
      <ProfilePage key={operatorSlug} operatorSlug={operatorSlug} />
    </main>
  );
}
