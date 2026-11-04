import type { ReactNode } from "react";
import OperatorPortalHeader from "@/components/operators/OperatorPortalHeader";
import OperatorSupportBoundary from "@/components/operators/OperatorSupportBoundary";
import OperatorWorkspaceAvailabilityBoundary from "@/components/operators/OperatorWorkspaceAvailabilityBoundary";

export default async function OperatorPortalLayout({
  children,
  params
}: {
  children: ReactNode;
  params: Promise<{ operatorSlug: string }>;
}) {
  const { operatorSlug } = await params;
  return (
    <OperatorWorkspaceAvailabilityBoundary operatorSlug={operatorSlug}>
      <OperatorSupportBoundary operatorSlug={operatorSlug}>
        <OperatorPortalHeader operatorSlug={operatorSlug} />
        {children}
      </OperatorSupportBoundary>
    </OperatorWorkspaceAvailabilityBoundary>
  );
}
