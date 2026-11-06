/** Converts only the current Swiftline piece format; carrier references are untouched. */
export function compactSwiftlineParcelNumber(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  const match = /^(SLC[A-Z]{3}\d{9,})-(0[1-9]|[1-9]\d|100)$/i.exec(normalized);
  return match ? `${match[1]}${match[2]}` : null;
}

export function displaySwiftlineParcelNumber(value: string, trackingNumber?: string) {
  const normalized = value.trim().toUpperCase();
  const match = /^(SLC[A-Z]{3}\d{9,})-(0[1-9]|[1-9]\d|100)$/i.exec(normalized);
  if (!match || (trackingNumber && match[1] !== trackingNumber.trim().toUpperCase())) return normalized;
  return `${match[1]}${match[2]}`;
}

export type SwiftlineParcelIdentifierAuditRecord = {
  shipmentDraftId: string;
  trackingNumber?: string | null;
  trackingNumbers?: readonly string[];
  carrierShipmentId?: string | null;
  carrierShipmentIds?: readonly string[];
  parcelNumbers: readonly string[];
};

/** Finds normalized parcel IDs that resolve to more than one shipment identity. */
export function findSwiftlineParcelIdentifierCollisions(records: readonly SwiftlineParcelIdentifierAuditRecord[]) {
  const owners = new Map<string, Map<string, Set<string>>>();
  const add = (value: string | null | undefined, shipmentDraftId: string, source: string) => {
    const identifier = value?.trim().toUpperCase();
    if (!identifier) return;
    const shipments = owners.get(identifier) ?? new Map<string, Set<string>>();
    const sources = shipments.get(shipmentDraftId) ?? new Set<string>();
    sources.add(source);
    shipments.set(shipmentDraftId, sources);
    owners.set(identifier, shipments);
  };

  for (const record of records) {
    add(record.trackingNumber, record.shipmentDraftId, "TRACKING_NUMBER");
    for (const trackingNumber of record.trackingNumbers ?? []) {
      add(trackingNumber, record.shipmentDraftId, "TRACKING_NUMBER");
    }
    add(record.carrierShipmentId, record.shipmentDraftId, "CARRIER_SHIPMENT_ID");
    for (const carrierShipmentId of record.carrierShipmentIds ?? []) {
      add(carrierShipmentId, record.shipmentDraftId, "CARRIER_SHIPMENT_ID");
    }
    for (const parcelNumber of record.parcelNumbers) {
      add(displaySwiftlineParcelNumber(parcelNumber), record.shipmentDraftId, "PARCEL_NUMBER");
    }
  }

  return [...owners.entries()]
    .filter(([, shipments]) => shipments.size > 1)
    .map(([identifier, shipments]) => ({
      identifier,
      shipments: [...shipments.entries()]
        .map(([shipmentDraftId, sources]) => ({ shipmentDraftId, sources: [...sources].sort() }))
        .sort((left, right) => left.shipmentDraftId.localeCompare(right.shipmentDraftId))
    }))
    .sort((left, right) => left.identifier.localeCompare(right.identifier));
}
