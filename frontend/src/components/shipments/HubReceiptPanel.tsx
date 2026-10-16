import type { ShipmentHubReceipt } from "@/lib/shipmentTracking";

export default function HubReceiptPanel({ receipt }: { receipt?: ShipmentHubReceipt | null }) {
  if (!receipt) return null;
  const partial = receipt.notReceivedParcelNumbers.length > 0;
  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${partial ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
      <h2 className={`text-sm font-semibold ${partial ? "text-amber-950" : "text-emerald-950"}`}>
        Delhi hub receipt: {receipt.receivedParcels} of {receipt.totalParcels} parcels received
      </h2>
      {partial ? (
        <p className="mt-2 text-sm leading-6 text-amber-900">
          Not received at Delhi hub: <span className="font-medium break-words">{receipt.notReceivedParcelNumbers.join(", ")}</span>. Export processing waits for the remaining parcels.
        </p>
      ) : null}
    </section>
  );
}
