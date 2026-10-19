"use client";

import { FiPackage } from "react-icons/fi";
import { StagePipelineChart } from "@/components/dashboard/DashboardCharts";
import { EmptyState, SectionCard } from "@/components/dashboard/DashboardWidgets";
import { buildShipmentPipeline } from "@/lib/clientDashboardOverview";
import type { ClientShipmentSummary } from "@/lib/clientDashboard";

export default function ClientShipmentPipelineCard({
  summary,
  refreshing,
  canCreateShipment
}: {
  summary: ClientShipmentSummary;
  refreshing: boolean;
  canCreateShipment: boolean;
}) {
  const pipeline = buildShipmentPipeline(summary);

  return (
    <SectionCard
      className="lg:col-span-2"
      icon={FiPackage}
      title="Shipment pipeline"
      subtitle="Where your shipment drafts are sitting right now"
    >
      {summary.totalShipments ? (
        <>
          <StagePipelineChart stages={pipeline} unitLabel="shipments" dimmed={refreshing} />
        </>
      ) : (
        <EmptyState
          icon={FiPackage}
          title="No shipments yet"
          message={canCreateShipment
            ? "Create a shipment to start building dashboard activity."
            : "Shipment creation is paused until your business rates are configured."}
          actionLabel={canCreateShipment ? "Create Shipment" : undefined}
          actionHref={canCreateShipment ? "/client/dpd-labels" : undefined}
        />
      )}
    </SectionCard>
  );
}
