"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FiTruck } from "react-icons/fi";
import { EmptyState, SectionCard } from "@/components/dashboard/DashboardWidgets";
import type { ClientRecentShipment } from "@/lib/clientDashboard";
import { formatDashboardDateTime } from "@/lib/dateFormat";
import { titleCase } from "@/lib/dashboardOverview";

export default function ClientRecentShipmentsCard({
  shipments,
  canCreateShipment
}: {
  shipments: ClientRecentShipment[];
  canCreateShipment: boolean;
}) {
  return (
    <SectionCard
      icon={FiTruck}
      title="Recent shipments"
      subtitle="Latest shipment drafts from the current account and branch"
      action={canCreateShipment
        ? <Link href="/client/dpd-labels" className="text-xs font-semibold text-[#0D1282] hover:underline">Create Shipment</Link>
        : undefined}
      bodyClassName="p-0"
    >
      <RecentShipmentsTable shipments={shipments} canCreateShipment={canCreateShipment} />
    </SectionCard>
  );
}

function RecentShipmentsTable({
  shipments,
  canCreateShipment
}: {
  shipments: ClientRecentShipment[];
  canCreateShipment: boolean;
}) {
  if (!shipments.length) {
    return (
      <div className="p-5">
        <EmptyState
          icon={FiTruck}
          title="No shipments yet"
          message={canCreateShipment
            ? "Create a shipment to start building dashboard activity."
            : "Shipment creation is paused until your business rates are configured."}
          actionLabel={canCreateShipment ? "Create Shipment" : undefined}
          actionHref={canCreateShipment ? "/client/dpd-labels" : undefined}
        />
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-5 py-3">Reference</th>
            <th className="px-5 py-3">Destination</th>
            <th className="px-5 py-3">Status</th>
            <th className="px-5 py-3">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {shipments.map((shipment) => <RecentShipmentRow key={shipment.id} shipment={shipment} />)}
        </tbody>
      </table>
    </div>
  );
}

function RecentShipmentRow({ shipment }: { shipment: ClientRecentShipment }) {
  const router = useRouter();
  const destinationName = shipment.destination.companyName || shipment.destination.contactName || "Consignee";
  const destinationPlace = [shipment.destination.townOrCity, shipment.destination.countryName || shipment.destination.countryCode]
    .filter(Boolean).join(", ");
  const hasCreatedLabel = ["DPD_CREATED", "LABEL_RECEIVED"].includes(shipment.dpdStatus);
  const viewHref = hasCreatedLabel ? `/client/shipments/${shipment.id}` : `/client/dpd-labels/${shipment.id}`;
  const statusLabel = shipment.currentStatusLabel || (shipment.dpdStatus ? titleCase(shipment.dpdStatus) : shipment.statusLabel);
  const isOnHold = shipment.currentStatus === "ON_HOLD";

  return (
    <tr
      className="cursor-pointer text-slate-700 transition hover:bg-slate-50"
      onClick={() => router.push(viewHref)}
    >
      <td className="px-5 py-3">
        <Link
          href={viewHref}
          className="font-semibold text-slate-900 hover:text-[#0D1282] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
        >
          {shipment.swiftlineTrackingNumber || "AWB Pending"}
        </Link>
        <p className="mt-0.5 text-xs text-slate-500">
          {shipment.shipmentInvoice?.invoiceNumber
            ? `Tax Invoice: ${shipment.shipmentInvoice.invoiceNumber}`
            : "Tax Invoice Pending"}
        </p>
      </td>
      <td className="px-5 py-3">
        <p className="font-medium text-slate-900">{destinationName}</p>
        <p className="mt-0.5 text-xs text-slate-500">{destinationPlace || shipment.destination.postcode || "Not available"}</p>
      </td>
      <td className="px-5 py-3">
        <span className="inline-flex rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold capitalize text-slate-700">
          {statusLabel}
        </span>
        {isOnHold && shipment.holdReason ? <p className="mt-1 text-xs font-medium text-amber-600">{titleCase(shipment.holdReason)}</p> : null}
      </td>
      <td className="px-5 py-3 text-xs font-medium text-slate-500">{formatDashboardDateTime(shipment.updatedAt ?? shipment.createdAt)}</td>
    </tr>
  );
}
