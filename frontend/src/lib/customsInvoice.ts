// The customs ("shipment") invoice: the goods declaration that travels with an
// export shipment. Distinct from the GST tax invoice in shipmentInvoices.ts,
// which bills freight and 18% GST to the customer.
//
// The document is derived from the shipment on every request, so an amendment is
// reflected automatically- there are no revisions and no version header.

import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";

// The declaration note starts empty: staff type whatever the shipment needs and
// nothing prints unless they do. Mirrors the backend constant.
export const defaultDeclarationNote = "";

export type CustomsInvoiceAudience = "client" | "admin";

export type CustomsInvoiceParty = {
  name: string;
  companyName: string;
  address: string;
  countryName: string;
  postcode: string;
  email: string;
  phone: string;
};

export type CustomsInvoiceItem = {
  serialNumber: number;
  description: string;
  hsCode: string;
  unitType: string;
  quantity: number;
  unitRate: number;
  amount: number;
};

export type CustomsInvoiceBox = {
  boxNumber: number;
  /** House airway bill (Swiftline parcel number). Empty when the shipment is not booked yet. */
  parcelNumber: string;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  actualWeightKg: number;
  items: CustomsInvoiceItem[];
};

export type CustomsInvoice = {
  invoiceNumber: string;
  invoiceDate: string;
  otherReference: string;
  aadhaarNumber: string;
  shipper: CustomsInvoiceParty;
  consignee: CustomsInvoiceParty;
  countryOfOrigin: string;
  destination: string;
  note: string;
  boxes: CustomsInvoiceBox[];
  currency: string;
  totalAmount: number;
  totalAmountInWords: string;
};

function root(audience: CustomsInvoiceAudience, draftId: string) {
  return audience === "client"
    ? `/api/v1/client/shipments/${draftId}/shipment-invoice`
    : `/api/v1/dpd-shipments/drafts/${draftId}/shipment-invoice`;
}

async function fetchWithAuth(url: string, init: RequestInit = {}) {
  const token = getAccessToken() ?? await refreshAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response = await fetch(url, { ...init, headers });
  if (response.status !== 401) return response;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return response;
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("Authorization", `Bearer ${refreshed}`);
  response = await fetch(url, { ...init, headers: retryHeaders });
  return response;
}

export async function getCustomsInvoice(draftId: string, audience: CustomsInvoiceAudience) {
  const response = await fetchWithAuth(apiUrl(root(audience, draftId)));
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "Unable to load the shipment invoice.");
  return data.invoice as CustomsInvoice;
}

/** Streams the PDF or Excel download to the browser. */
async function download(draftId: string, audience: CustomsInvoiceAudience, format: "pdf" | "xlsx") {
  const response = await fetchWithAuth(apiUrl(`${root(audience, draftId)}/${format}`));
  if (!response.ok) {
    const message = await response.json().catch(() => null);
    throw new Error(message?.message || `Unable to download the shipment invoice ${format.toUpperCase()}.`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${draftId}-shipment-invoice.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export function downloadCustomsInvoicePdf(draftId: string, audience: CustomsInvoiceAudience) {
  return download(draftId, audience, "pdf");
}

export function downloadCustomsInvoiceWorkbook(draftId: string, audience: CustomsInvoiceAudience) {
  return download(draftId, audience, "xlsx");
}

/** On-screen page for the shipment invoice. */
export function customsInvoicePageUrl(draftId: string, audience: CustomsInvoiceAudience) {
  return audience === "client"
    ? `/client/shipments/${draftId}/shipment-invoice`
    : `/dashboard/shipments/${draftId}/shipment-invoice`;
}
