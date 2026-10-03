import { getGstinError } from "@/lib/gstin";
import { getAdCodeError } from "@/lib/adCode";
import type { CsbType } from "@/lib/csbType";

export type CsbVBookingDetails = {
  gstin: string;
  accountNumber: string;
  iecCode: string;
  adCode: string;
  invoiceNumber: string;
};

export type CsbVBookingIssues = Partial<Record<keyof CsbVBookingDetails, string>>;

export function getCsbVShipmentValueError(value: number, csbType: CsbType): string {
  return csbType === "CSB_V" && value > 1_000_000
    ? "CSB-V shipment goods value cannot exceed ₹10,00,000"
    : "";
}

export function getCsbVBookingIssues(
  details: CsbVBookingDetails,
  csbType: CsbType,
): CsbVBookingIssues {
  if (csbType !== "CSB_V") return {};

  const issues: CsbVBookingIssues = {};
  const gstin = details.gstin.trim();

  if (!gstin) issues.gstin = "GSTIN number is required";
  else {
    const gstinError = getGstinError(gstin);
    if (gstinError) issues.gstin = gstinError;
  }

  if (!details.accountNumber.trim()) issues.accountNumber = "Bank account number is required";
  if (!details.iecCode.trim()) issues.iecCode = "IEC code is required";
  const adCodeError = getAdCodeError(details.adCode);
  if (adCodeError) issues.adCode = adCodeError;
  if (!details.invoiceNumber.trim()) issues.invoiceNumber = "Commercial invoice number is required";

  return issues;
}
