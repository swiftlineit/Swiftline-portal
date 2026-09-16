import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import type { CsbType } from "@/lib/csbType";
import type { ShipmentChargeLine } from "@/lib/shipmentCostEstimate";

export type ShipmentInvoiceParty = Record<string, string>;

/**
 * The charges an invoice lists below its per-box freight rows: surcharges,
 * clearance, handling, insurance and any discount.
 *
 * Freight is already itemised per box and GST is totalled separately, so both are
 * excluded here- listing them again would double them on the invoice.
 *
 * Invoices raised before route charges existed carry no `lines`. Their flat CSB-V
 * clearance charge is rebuilt from the stored amount so they print exactly as they
 * were issued.
 */
export function getShipmentLevelInvoiceLines(
  pricingSnapshot: ShipmentInvoice["pricingSnapshot"]
): ShipmentChargeLine[] {
  if (!pricingSnapshot) return [];

  if (pricingSnapshot.lines?.length) {
    return pricingSnapshot.lines.filter((line) => line.code !== "FREIGHT" && line.code !== "GST");
  }

  const csbClearanceAmount = pricingSnapshot.csbClearanceAmount ?? 0;
  if (csbClearanceAmount <= 0) return [];

  return [{
    code: "CUSTOMS_CLEARANCE",
    label: "CSB-V Clearance Charge",
    kind: "CHARGE",
    amount: csbClearanceAmount,
    amountMinor: Math.round(csbClearanceAmount * 100),
    basis: "Flat charge for the CSB-V customs route, once per shipment"
  }];
}

export type ShipmentInvoiceParcel = {
  sequence: number;
  actualWeightKg: number;
  volumetricWeightKg: number;
  chargeableWeightKg: number;
  rateFromKg: number | null;
  rateToKg: number | null;
  chargesPerKg: number | null;
  maxBoxKg: number | null;
  baseAmount: number;
  exceedsMaxBoxKg: boolean;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  contentsDescription: string;
  items?: Array<{
    description: string;
    hsnCode?: string;
    unitType?: string;
    quantity?: number;
    unitRate?: number;
  }>;
};

export function shipmentInvoiceParcelDescription(parcel: ShipmentInvoiceParcel) {
  const descriptions = (parcel.items ?? [])
    .map((item) => item.description.trim())
    .filter(Boolean);
  return descriptions.length ? descriptions.join(", ") : parcel.contentsDescription;
}

export type ShipmentInvoiceVersion = {
  revision: number;
  issuedAt: string;
  totalAmountMinor: number;
  status: "DRAFT" | "ISSUED";
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "VOID";
  isLatest: boolean;
};

export type ShipmentInvoice = {
  id: string;
  invoiceNumber: string;
  financialYear: string;
  shipmentDraftId: string;
  dpdShipmentId: string;
  businessAccountId: string;
  branchId: string;
  currency: string;
  supplier: ShipmentInvoiceParty;
  customer: ShipmentInvoiceParty;
  shipment: ShipmentInvoiceParty & {
    parcelCount?: number;
    parcelNumbers?: string[];
    parcels?: ShipmentInvoiceParcel[];
  };
  sacCode: string;
  description: string;
  taxableValueMinor: number;
  gstRatePercent: number;
  taxTreatment?: "GST_APPLICABLE" | "NO_GST";
  taxType: "CGST_SGST" | "IGST";
  cgstAmountMinor: number;
  sgstAmountMinor: number;
  igstAmountMinor: number;
  totalTaxAmountMinor: number;
  totalAmountMinor: number;
  advanceAppliedMinor: number;
  creditOutstandingMinor: number;
  // The full charge breakdown behind the taxable value. `lines` is absent on
  // invoices issued before route charges existed; those carry only the freight and
  // CSB-V clearance split, which is enough to print them as they were issued.
  pricingSnapshot?: {
    csbType?: CsbType;
    csbClearanceAmount?: number;
    freightAmount?: number;
    lines?: ShipmentChargeLine[];
  } | null;
  reverseCharge: boolean;
  status: "DRAFT" | "ISSUED";
  validationWarnings: string[];
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "VOID";
  revision: number;
  issuedAt: string;
  revisedAt?: string | null;
  isLatest: boolean;
  versions: ShipmentInvoiceVersion[];
};

export type ShipmentInvoiceAudience = "admin" | "client";

function endpoint(draftId: string, audience: ShipmentInvoiceAudience, pdf = false, revision?: number) {
  const base = audience === "client"
    ? `/api/v1/client/shipments/${draftId}/invoice`
    : `/api/v1/dpd-shipments/drafts/${draftId}/invoice`;
  const url = apiUrl(pdf ? `${base}/pdf` : base);
  return revision ? `${url}?revision=${revision}` : url;
}

async function fetchWithAuth(input: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? await refreshAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status !== 401) return response;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return response;
  headers.set("Authorization", `Bearer ${refreshed}`);
  return fetch(input, { ...init, headers });
}

/**
 * Short-lived in-memory cache for the invoice JSON, so hovering a row and then
 * opening it (or opening the same invoice twice) never pays for two identical
 * fetches. Cache only, never a source of truth: entries expire quickly and a
 * failed fetch never overwrites a good one.
 */
const invoiceCache = new Map<string, { at: number; invoice: ShipmentInvoice }>();
const INVOICE_CACHE_TTL_MS = 60_000;

function invoiceCacheKey(draftId: string, audience: ShipmentInvoiceAudience, revision?: number) {
  return `${audience}:${draftId}:${revision ?? "latest"}`;
}

export async function getShipmentInvoice(draftId: string, audience: ShipmentInvoiceAudience, revision?: number) {
  const key = invoiceCacheKey(draftId, audience, revision);
  const cached = invoiceCache.get(key);
  if (cached && Date.now() - cached.at < INVOICE_CACHE_TTL_MS) return cached.invoice;
  const response = await fetchWithAuth(endpoint(draftId, audience, false, revision));
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Unable to load shipment invoice.");
  const invoice = data.invoice as ShipmentInvoice;
  invoiceCache.set(key, { at: Date.now(), invoice });
  return invoice;
}



export async function downloadShipmentInvoicePdf(
  draftId: string,
  audience: ShipmentInvoiceAudience,
  invoiceNumber?: string,
  revision?: number
) {
  const response = await fetchWithAuth(endpoint(draftId, audience, true, revision));
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || "Unable to download shipment invoice PDF.");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const versionSuffix = revision ? `-Invoice-${revision}` : "";
  link.download = `${(invoiceNumber || "shipment-invoice").replaceAll("/", "-")}${versionSuffix}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function shipmentInvoicePageUrl(
  draftId: string,
  audience: ShipmentInvoiceAudience,
  print = false,
  revision?: number
) {
  const base = audience === "client"
    ? `/client/shipments/${draftId}/invoice`
    : `/dashboard/shipments/${draftId}/invoice`;
  const query = new URLSearchParams();
  if (print) query.set("print", "1");
  if (revision) query.set("revision", String(revision));
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
}
