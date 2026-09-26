import { getGstinError } from "@/lib/gstin";
import type { CsbType } from "@/lib/csbType";

export type CsbVBookingDetails = {
  gstin: string;
  accountNumber: string;
  invoiceNumber: string;
};

export type CsbVBookingIssues = Partial<Record<keyof CsbVBookingDetails, string>>;

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

  if (!details.accountNumber.trim()) issues.accountNumber = "Account number is required";
  if (!details.invoiceNumber.trim()) issues.invoiceNumber = "Commercial invoice number is required";

  return issues;
}
