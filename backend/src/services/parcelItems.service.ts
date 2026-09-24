// Per-parcel content items.
//
// A parcel can hold several distinct goods ("cookies", "clothes"). CSB-V needs an
// HSN code for each one; CSB-IV does not, so a code may be absent there. Those
// items live in `parcel.items`.
//
// `parcel.contentsDescription` is kept as the DERIVED single-line summary of those
// items for legacy payloads and documents that still expose one parcel-level
// description. Item-aware exports and the ALS shipment payload read `items`
// directly so they do not lose later item descriptions.

// HS codes are declared at 4, 6, 8 or 10 digit precision. Ten digits appear on
// the customs invoice for tariff lines that need the fuller classification.
const hsnCodePattern = /^\d{4}(?:\d{2}(?:\d{2}(?:\d{2})?)?)?$/;

// Unit of measure per item line on the customs invoice. "Pcs" is the common case.
export const parcelItemUnitTypeValues = ["Pkt", "Pcs", "Set", "Box", "Kg", "Pair"] as const;
export type ParcelItemUnitType = (typeof parcelItemUnitTypeValues)[number];
export const defaultParcelItemUnitType: ParcelItemUnitType = "Pcs";

// Must stay <= the `contentsDescription` maxlength in shipmentDraft.model.ts and
// the length the DPD payload validator enforces.
export const contentsDescriptionMaxLength = 120;
/** Maximum combined goods-description length allowed when booking a shipment. */
export const shipmentDescriptionMaxLength = 240;
export const maxParcelsPerShipment = 100;
export const maxParcelItems = 50;

export type ParcelItemInput = {
  description?: unknown;
  hsnCode?: unknown;
  unitType?: unknown;
  quantity?: unknown;
  unitRate?: unknown;
};

export function isValidHsnCode(value: unknown): boolean {
  return typeof value === "string" && hsnCodePattern.test(value.trim());
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Line amount for a customs invoice row: quantity x unit rate.
 * Always derived, never stored, so it cannot drift from its inputs.
 */
export function getParcelItemAmount(item: { quantity?: unknown; unitRate?: unknown }): number {
  return roundMoney(numeric(item.quantity) * numeric(item.unitRate));
}

/** Declared goods value for the whole shipment: every item line summed. */
export function getDeclaredGoodsValue(
  parcels: Array<{ items?: Array<{ quantity?: unknown; unitRate?: unknown }> | null }>
): number {
  const total = parcels.reduce((sum, parcel) => (
    sum + (Array.isArray(parcel.items) ? parcel.items : [])
      .reduce((parcelSum, item) => parcelSum + getParcelItemAmount(item), 0)
  ), 0);
  return roundMoney(total);
}

/**
 * Joins item descriptions into the single-line summary stored in
 * `contentsDescription`. Truncation happens on an item boundary so the summary
 * never ends mid-word, and the result always fits the 120 char column.
 */
export function composeContentsDescription(items: ParcelItemInput[]): string {
  const descriptions = items
    .map((item) => (typeof item.description === "string" ? item.description.trim() : ""))
    .filter(Boolean);
  if (!descriptions.length) return "";

  const parts: string[] = [];
  for (const description of descriptions) {
    const candidate = [...parts, description].join(", ");
    if (candidate.length > contentsDescriptionMaxLength) break;
    parts.push(description);
  }

  // A single first item longer than the limit still has to be represented, so it
  // is hard-cut rather than dropped entirely.
  if (!parts.length) return (descriptions[0] ?? "").slice(0, contentsDescriptionMaxLength);
  return parts.join(", ");
}

type ShipmentDescriptionParcel = {
  items?: ParcelItemInput[] | null;
  contentsDescription?: unknown;
};

/**
 * Builds the full goods-description text that the EDI row exporter produces.
 * Descriptions from every item and parcel are separated with ", ". This is
 * deliberately separate from composeContentsDescription, which protects the
 * legacy 120-character per-parcel storage column.
 */
export function composeShipmentDescription(parcels: ShipmentDescriptionParcel[]): string {
  const descriptions: string[] = [];

  for (const parcel of parcels) {
    const itemDescriptions = (parcel.items ?? [])
      .map((item) => (typeof item.description === "string" ? item.description.trim() : ""))
      .filter(Boolean);

    if (itemDescriptions.length) {
      descriptions.push(...itemDescriptions);
      continue;
    }

    const legacyDescription = typeof parcel.contentsDescription === "string"
      ? parcel.contentsDescription.trim()
      : "";
    if (legacyDescription) descriptions.push(legacyDescription);
  }

  return descriptions.join(", ");
}

export function getShipmentDescriptionCharacterCount(parcels: ShipmentDescriptionParcel[]): number {
  return composeShipmentDescription(parcels).length;
}

/** Returns the final-booking validation message, or an empty string when valid. */
export function getShipmentDescriptionLimitMessage(parcels: ShipmentDescriptionParcel[]): string {
  const count = getShipmentDescriptionCharacterCount(parcels);
  if (count <= shipmentDescriptionMaxLength) return "";

  return `Item descriptions can be a maximum of ${shipmentDescriptionMaxLength} characters. The current combined description is ${count} characters, which exceeds the limit by ${count - shipmentDescriptionMaxLength}.`;
}

/**
 * Rebuilds a parcel's items from whatever is stored. Drafts created before items
 * existed carry only `contentsDescription`, so they surface as a single item with
 * an empty HSN code- no migration required.
 */
export function normalizeParcelItems(parcel: {
  items?: ParcelItemInput[] | null;
  contentsDescription?: unknown;
}): Array<{ description: string; hsnCode: string; unitType: string; quantity: number; unitRate: number }> {
  const stored = Array.isArray(parcel.items) ? parcel.items : [];
  const items = stored
    .map((item) => ({
      description: typeof item.description === "string" ? item.description.trim() : "",
      hsnCode: typeof item.hsnCode === "string" ? item.hsnCode.trim() : "",
      // Older items carry no unit fields; they read as one unit of zero value so
      // the customs invoice can still render them.
      unitType: typeof item.unitType === "string" && item.unitType.trim()
        ? item.unitType.trim()
        : defaultParcelItemUnitType,
      quantity: numeric(item.quantity),
      unitRate: numeric(item.unitRate)
    }))
    .filter((item) => item.description || item.hsnCode);

  if (items.length) return items;

  const legacy = typeof parcel.contentsDescription === "string" ? parcel.contentsDescription.trim() : "";
  return legacy
    ? [{ description: legacy, hsnCode: "", unitType: defaultParcelItemUnitType, quantity: 0, unitRate: 0 }]
    : [];
}
