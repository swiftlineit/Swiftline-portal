import type { ManifestDetail, OperationsBag, OperationsConsignment } from "./operationsManifests";

export type BagParcelRow = {
  bag: OperationsBag;
  consignment: OperationsConsignment;
  parcelNumber: string;
  weightKg: number | null;
  valueMinor: number | null;
  contents: string;
};

export type BagView = {
  bag: OperationsBag;
  parcels: BagParcelRow[];
  recordedValueMinor: number;
  valueIncomplete: boolean;
};

/** The accepted scan, not the shipment's first bag, owns a parcel's location. */
export function parcelBagId(consignment: OperationsConsignment, parcelNumber: string) {
  const scan = consignment.activeParcelScans?.find((entry) => entry.parcelNumber === parcelNumber);
  return scan?.bagId ?? (consignment.bagIds.length === 1 ? consignment.bagIds[0] : null);
}

export function buildOperationsBagViews(detail: ManifestDetail): BagView[] {
  const bags = detail.bags.filter((bag) => bag.status !== "CANCELLED")
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  const views = bags.map((bag) => ({ bag, parcels: [] as BagParcelRow[], recordedValueMinor: 0, valueIncomplete: false }));
  const byBag = new Map(views.map((view) => [view.bag.id, view]));
  for (const consignment of detail.consignments) {
    for (const parcelNumber of consignment.scannedParcelNumbers) {
      const view = byBag.get(parcelBagId(consignment, parcelNumber) ?? "");
      if (!view) continue;
      const snapshot = consignment.parcelWeightSnapshots?.find((item) => item.parcelNumber === parcelNumber);
      const parcelValue = consignment.parcelValues.find((item) => item.parcelNumber === parcelNumber);
      const valueMinor = parcelValue ? parcelValue.valueMinor : snapshot?.valueMinor ?? null;
      view.parcels.push({
        bag: view.bag,
        consignment,
        parcelNumber,
        weightKg: snapshot?.weightKg ?? null,
        valueMinor,
        contents: snapshot?.items?.map((item) => item.description).filter(Boolean).join(", ")
          || snapshot?.contentsDescription || "Parcel contents unavailable",
      });
      if (!valueMinor) view.valueIncomplete = true;
      else view.recordedValueMinor += valueMinor;
    }
  }
  return views;
}

export function searchOperationsBagViews(views: BagView[], search: string): BagView[] {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return views;
  return views.flatMap((view) => {
    if (view.bag.bagNumber.toLocaleLowerCase().includes(term)) return [view];
    const parcels = view.parcels.filter((row) => [
      row.parcelNumber,
      row.consignment.consignmentNumber,
      row.consignment.displayConsignmentNumber,
      row.consignment.consigneeSnapshot.name,
      row.consignment.consigneeSnapshot.formatted,
      row.contents,
      ...row.consignment.expectedParcelNumbers.filter((parcel) => !row.consignment.scannedParcelNumbers.includes(parcel)),
    ].some((value) => value?.toLocaleLowerCase().includes(term)));
    if (!parcels.length) return [];
    return [{ ...view, parcels }];
  });
}

export function outstandingParcels(view: BagView) {
  const consignments = [...new Map(view.parcels.map((row) => [row.consignment.id, row.consignment])).values()];
  return consignments.flatMap((consignment) => consignment.expectedParcelNumbers
    .filter((parcel) => !consignment.scannedParcelNumbers.includes(parcel))
    .map((parcel) => {
      const disposition = consignment.parcelDispositions.find((entry) => entry.parcelNumber === parcel);
      const label = disposition?.disposition === "DEFERRED_TO_NEXT_MANIFEST"
        ? "Next manifest"
        : disposition?.disposition === "HELD"
          ? "Held"
          : disposition?.disposition === "CANCELLED"
            ? "Cancelled"
            : "Not scanned";
      return {
        parcel,
        label,
        consignmentNumber: consignment.displayConsignmentNumber || consignment.consignmentNumber,
        shipmentDraftId: consignment.shipmentDraftId,
      };
    }));
}
