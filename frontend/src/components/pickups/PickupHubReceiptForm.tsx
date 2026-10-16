"use client";

import { useState } from "react";
import type { PickupDetail, PickupReceivedParcel } from "@/lib/pickups";

export default function PickupHubReceiptForm({ pickup, busy, onComplete }: {
  pickup: PickupDetail;
  busy: boolean;
  onComplete: (receivedParcels: PickupReceivedParcel[]) => Promise<void>;
}) {
  const parcels = pickup.shipments.flatMap((shipment) => shipment.parcels.map((parcel) => ({
    shipmentDraftId: shipment.shipmentDraftId,
    parcelNumber: parcel.parcelNumber,
    hubReceivedAt: parcel.hubReceivedAt
  })));
  const [selected, setSelected] = useState(() => new Set(parcels.map((parcel) => `${parcel.shipmentDraftId}:${parcel.parcelNumber}`)));
  const receivedParcels = parcels.filter((parcel) => selected.has(`${parcel.shipmentDraftId}:${parcel.parcelNumber}`));

  return (
    <div className="mt-3 space-y-3">
      {parcels.length ? (
        <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-white p-3">
          {pickup.shipments.map((shipment) => (
            <div key={shipment._id}>
              <p className="mb-1.5 text-xs font-semibold text-slate-700">{shipment.trackingNumber}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {shipment.parcels.map((parcel) => {
                  const key = `${shipment.shipmentDraftId}:${parcel.parcelNumber}`;
                  return (
                    <label key={key} className="flex min-w-0 items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        checked={selected.has(key)}
                        disabled={busy || Boolean(parcel.hubReceivedAt)}
                        onChange={(event) => setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })}
                        className="h-4 w-4 shrink-0 accent-emerald-700"
                      />
                      <span className="break-all font-medium">{parcel.parcelNumber}</span>
                      {parcel.hubReceivedAt ? <span className="ml-auto shrink-0 text-emerald-700">Already received</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <p className="text-xs leading-5 text-slate-600">
        {parcels.length
          ? `${receivedParcels.length} of ${parcels.length} parcels selected. Uncheck any parcel not received at the hub; the requester will see it in the completion email.`
          : "This request has no linked shipments. Completing it records the pickup outcome only."}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void onComplete(receivedParcels.map(({ shipmentDraftId, parcelNumber }) => ({ shipmentDraftId, parcelNumber })))}
        className="h-10 w-full rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-60"
      >
        Complete pickup at Delhi hub
      </button>
    </div>
  );
}
