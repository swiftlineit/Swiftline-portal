import type { ReactNode } from "react";
import OperatorPortalHeader from "@/components/operators/OperatorPortalHeader";
import OperatorSupportBoundary from "@/components/operators/OperatorSupportBoundary";

export default async function OperatorPortalLayout({
  children,
  params
}: {
  children: ReactNode;
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return (
    <OperatorSupportBoundary operatorSlug={operatorSlug}>
      <OperatorPortalHeader operatorSlug={operatorSlug} />
      {children}
    </OperatorSupportBoundary>
  );
}
