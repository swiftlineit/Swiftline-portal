import { getVolumetricDivisor } from "@/lib/shipmentPricing";

export function revisedVolumetricKg(
  dimensions: { len: string; wid: string; hei: string },
  serviceType: string,
) {
  const length = Number(dimensions.len);
  const width = Number(dimensions.wid);
  const height = Number(dimensions.hei);
  if (![length, width, height].every((value) => Number.isFinite(value) && value > 0)) return null;
  const divisor = getVolumetricDivisor(
    serviceType.trim().toUpperCase() === "CARGO" ? "CARGO" : "COURIER",
  );
  const volumetric = length * width * height / divisor;
  return Number.isFinite(volumetric) ? volumetric.toFixed(3) : null;
}

export function revisedChargeableKg(actual: string, volumetric: string) {
  const weights = [actual, volumetric]
    .filter((value) => value.trim() !== "")
    .map(Number);
  if (!weights.length || weights.some((value) => !Number.isFinite(value) || value < 0)) return "";
  // Match the portal's pricing rule: settle floating precision before rounding
  // the greater weight up to the whole kilogram billed.
  return String(Math.ceil(Number(Math.max(...weights).toFixed(3))));
}

export function revisedBoxAmount(
  chargeable: string,
  ratePerKg: string,
  gstRatePercent: number,
) {
  if (ratePerKg.trim() === "") return null;
  if (chargeable.trim() === "") return "";
  const weight = Number(chargeable);
  const rate = Number(ratePerKg);
  if (!Number.isFinite(weight) || weight < 0 || !Number.isFinite(rate) || rate < 0) return "";

  // Rate-card freight is GST-inclusive. Box Amount on the invoice is taxable
  // freight, so extract GST at the invoice's saved account-specific rate.
  const grossMinor = Math.round((weight * rate + Number.EPSILON) * 100);
  const gstRate = gstRatePercent > 0 ? gstRatePercent / 100 : 0;
  const gstMinor = gstRate > 0
    ? Math.round(grossMinor * gstRate / (1 + gstRate))
    : 0;
  return ((grossMinor - gstMinor) / 100).toFixed(2);
}

export function revisedAutomaticBoxAmounts<T extends {
  chargeable: string;
  rate: string;
  amount: string;
  amountManual: boolean;
}>(parcels: T[], gstRatePercent: number): T[] {
  const grossMinors: number[] = [];
  const next = parcels.map((parcel, index) => {
    if (parcel.amountManual) return parcel;
    const amount = revisedBoxAmount(parcel.chargeable, parcel.rate, gstRatePercent);
    if (amount === null) return parcel;
    if (amount !== "") {
      grossMinors[index] = Math.round((Number(parcel.chargeable) * Number(parcel.rate) + Number.EPSILON) * 100);
    }
    return { ...parcel, amount };
  });

  // The pricing service splits GST on the combined inclusive freight, then
  // allocates a possible one-paisa remainder to the first priced box.
  const grossMinor = grossMinors.reduce((sum, value) => sum + (value || 0), 0);
  const rate = Number.isFinite(gstRatePercent) && gstRatePercent > 0 ? gstRatePercent / 100 : 0;
  const taxableTargetMinor = grossMinor - Math.round(grossMinor * rate / (1 + rate));
  const allocatedMinor = next.reduce((sum, parcel, index) => (
    sum + (grossMinors[index] ? Math.round(Number(parcel.amount) * 100) : 0)
  ), 0);
  const adjustmentIndex = grossMinors.findIndex((value) => value > 0);
  if (adjustmentIndex >= 0 && taxableTargetMinor !== allocatedMinor) {
    const parcel = next[adjustmentIndex];
    next[adjustmentIndex] = {
      ...parcel,
      amount: ((Math.round(Number(parcel.amount) * 100) + taxableTargetMinor - allocatedMinor) / 100).toFixed(2),
    };
  }
  return next;
}

export function revisedTaxableFromRows(
  parcels: Array<{ amount: string }>,
  lines: Array<{ amount: string; kind: "CHARGE" | "DEDUCTION" }>,
) {
  const minor = (value: string) => Math.round((Number(value) || 0) * 100);
  const totalMinor = parcels.reduce((sum, parcel) => sum + minor(parcel.amount), 0)
    + lines.reduce((sum, line) => sum + (line.kind === "DEDUCTION" ? -minor(line.amount) : minor(line.amount)), 0);
  return (totalMinor / 100).toFixed(2);
}

export function revisedTaxTotals(
  taxableMinor: number,
  gstRatePercent: number,
  taxType: "CGST_SGST" | "IGST",
) {
  const rate = Number.isFinite(gstRatePercent) && gstRatePercent > 0 ? gstRatePercent : 0;
  const taxMinor = Math.round(taxableMinor * rate / 100);
  if (taxType === "CGST_SGST") {
    const cgst = Math.floor(taxMinor / 2);
    return { cgst, sgst: taxMinor - cgst, igst: 0, taxMinor, totalMinor: taxableMinor + taxMinor };
  }
  return { cgst: 0, sgst: 0, igst: taxMinor, taxMinor, totalMinor: taxableMinor + taxMinor };
}
