/**
 * ALS has supplied its own branded consignment/POD PDF alongside the DPD
 * barcode shipping label (HTML). Older bookings stored both as DPD documents.
 * Keep those files for audit, but only the verified shipping-label format may
 * be offered for printing or used as proof that a DPD label is ready.
 */
export function isAlsDpdShippingLabelFormat(format: string): boolean {
  return format === "HTML";
}

export function isVisibleShipmentLabel(label: { labelType?: string; format: string }): boolean {
  return label.labelType !== "DPD" || isAlsDpdShippingLabelFormat(label.format);
}
