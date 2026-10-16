import type { PickupShipment } from "@/lib/pickups";

export default function PickupHubReceiptSummary({ shipment }: { shipment: PickupShipment }) {
  if (!shipment.hubReceiptRecordedAt) return null;
  const received = shipment.parcels.filter((parcel) => parcel.hubReceiptOutcome === "RECEIVED").length;
  const notReceived = shipment.parcels.filter((parcel) => parcel.hubReceiptOutcome === "NOT_RECEIVED");
  return (
    <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${notReceived.length ? "border-amber-200 bg-amber-50 text-amber-950" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
      <p className="font-semibold">{received} of {shipment.parcels.length} parcels received at Delhi hub when this pickup closed</p>
      {notReceived.length ? (
        <div className="mt-1.5 space-y-1">
          {notReceived.map((parcel) => (
            <p key={parcel.parcelNumber} className="break-all">
              {parcel.parcelNumber} - {parcel.hubReceivedAt ? "received later" : "not received at pickup completion"}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
