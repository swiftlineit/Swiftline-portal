"use client";

import { DashboardLoading } from "@/components/DashboardShell";
import ShipmentTrackingPage from "@/components/shipments/ShipmentTrackingPage";
import { SHIPMENT_VIEW_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

export default function AdminTrackingPage() {
  const { user, loading } = useAdminUser(SHIPMENT_VIEW_AREA);
  if (loading || !user) return <DashboardLoading />;
  return (
    <ShipmentTrackingPage
      mode="admin"
      title="Shipment Tracking"
      description="Find a shipment by consignee name or by its Swiftline, carrier, or parcel tracking number."
    />
  );
}
