import { apiUrl } from "@/lib/api";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import type { RazorpayPublicConfig } from "@/lib/clientDashboard";
import type { ShipmentAmendment } from "@/lib/dpdLabels";

export type ShipmentPaymentAudience = "client" | "staff";
export type ShipmentPaymentSource = "BUSINESS_WALLET" | "DIRECT_RAZORPAY" | "CASH_RECEIPT";

export type ShipmentPaymentIntent = {
  id: string;
  shipmentDraftId: string;
  amountMinor: number;
  currency: string;
  pricingHash: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  status: string;
};

export class ShipmentPaymentApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ShipmentPaymentApiError";
  }
}

export type CashReceiptDraft = {
  id: string;
  businessAccountId: string;
  accountId: string;
  receiptNumber: string;
  status: "DRAFT" | "FINALIZED" | "REVERSED";
  totalReceivedMinor: number;
  pricingHash: string;
  customerName: string;
  receiptDate: string;
  destination: string;
  service: string;
  pieces: number;
  weightKg: number;
  cashCustodyReference: string;
  customerReference: string;
  createdByName: string;
  issuedAt: string | null;
};

export async function getPendingShipmentAmendment(input: {
  audience: ShipmentPaymentAudience;
  shipmentDraftId: string;
}) {
  const path = input.audience === "client"
    ? `/api/v1/client/shipments/${encodeURIComponent(input.shipmentDraftId)}/amendments/pending`
    : `/api/v1/shipment-amendments/draft/${encodeURIComponent(input.shipmentDraftId)}/pending`;
  const response = await authenticatedFetch(path);
  const payload = await json<{ success: true; amendment: ShipmentAmendment | null }>(response, "Unable to check pending shipment amendments.");
  return payload.amendment;
}

async function authenticatedFetch(path: string, init: RequestInit = {}) {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  const send = () => fetch(apiUrl(path), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      Authorization: `Bearer ${token}`
    }
  });
  let response = await send();
  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    response = await send();
  }
  return response;
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { success?: boolean; message?: string };
  if (!response.ok || !payload.success) throw new ShipmentPaymentApiError(payload.message || fallback, response.status);
  return payload as T;
}

function route(audience: ShipmentPaymentAudience, shipmentDraftId: string) {
  const prefix = audience === "client" ? "/api/v1/client/dpd-labels/drafts" : "/api/v1/shipment-drafts";
  return `${prefix}/${encodeURIComponent(shipmentDraftId)}`;
}

function stableIdempotencyKey(shipmentDraftId: string, pricingHash: string) {
  const storageKey = `swiftline-shipment-payment:${shipmentDraftId}:${pricingHash}`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const key = `shipment-${crypto.randomUUID()}`;
  window.sessionStorage.setItem(storageKey, key);
  return key;
}

export function clearShipmentPaymentIdempotencyKey(shipmentDraftId: string, pricingHash: string) {
  window.sessionStorage.removeItem(`swiftline-shipment-payment:${shipmentDraftId}:${pricingHash}`);
}

export async function createDirectShipmentPayment(input: {
  audience: ShipmentPaymentAudience;
  shipmentDraftId: string;
  acceptedPricingHash: string;
}) {
  const response = await authenticatedFetch(`${route(input.audience, input.shipmentDraftId)}/direct-payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": stableIdempotencyKey(input.shipmentDraftId, input.acceptedPricingHash)
    },
    body: JSON.stringify({ acceptedPricingHash: input.acceptedPricingHash })
  });
  return json<{
    success: true;
    duplicate?: boolean;
    razorpay: RazorpayPublicConfig;
    payment: ShipmentPaymentIntent;
  }>(response, "Shipment payment could not be started.");
}

export async function verifyDirectShipmentPayment(input: {
  audience: ShipmentPaymentAudience;
  shipmentDraftId: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) {
  const response = await authenticatedFetch(`${route(input.audience, input.shipmentDraftId)}/direct-payment/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: input.razorpay_payment_id,
      razorpay_signature: input.razorpay_signature
    })
  });
  return json<{ success: true; message: string; payment: ShipmentPaymentIntent }>(response, "Shipment payment could not be verified.");
}

function amendmentRoute(audience: ShipmentPaymentAudience, amendmentId: string) {
  const prefix = audience === "client" ? "/api/v1/client/shipment-amendments" : "/api/v1/shipment-amendments";
  return `${prefix}/${encodeURIComponent(amendmentId)}`;
}

export async function fundShipmentAmendmentFromWallet(input: {
  audience: ShipmentPaymentAudience;
  amendmentId: string;
}) {
  const response = await authenticatedFetch(`${amendmentRoute(input.audience, input.amendmentId)}/fund-wallet`, {
    method: "POST"
  });
  return json<{ success: true; message: string }>(response, "Amendment could not be funded from the business wallet.");
}

export async function createDirectShipmentAmendmentPayment(input: {
  audience: ShipmentPaymentAudience;
  amendmentId: string;
}) {
  const response = await authenticatedFetch(`${amendmentRoute(input.audience, input.amendmentId)}/direct-payment`, {
    method: "POST"
  });
  return json<{
    success: true;
    duplicate?: boolean;
    razorpay: RazorpayPublicConfig;
    payment: ShipmentPaymentIntent;
  }>(response, "Amendment payment could not be started.");
}

export async function verifyDirectShipmentAmendmentPayment(input: {
  audience: ShipmentPaymentAudience;
  amendmentId: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) {
  const response = await authenticatedFetch(`${amendmentRoute(input.audience, input.amendmentId)}/direct-payment/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: input.razorpay_payment_id,
      razorpay_signature: input.razorpay_signature
    })
  });
  return json<{ success: true; message: string; payment: ShipmentPaymentIntent }>(response, "Amendment payment could not be verified.");
}

export async function saveStaffCashReceiptDraft(input: {
  shipmentDraftId: string;
  acceptedPricingHash: string;
  totalReceivedMinor: number;
  customerName: string;
  receiptDate: string;
  cashCustodyReference: string;
  customerReference?: string;
}) {
  const response = await authenticatedFetch(`${route("staff", input.shipmentDraftId)}/cash-receipt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return json<{ success: true; receipt: CashReceiptDraft }>(response, "Cash receipt draft could not be saved.");
}

export async function getStaffCashReceiptDraft(shipmentDraftId: string) {
  const response = await authenticatedFetch(`${route("staff", shipmentDraftId)}/cash-receipt`);
  return json<{
    success: true;
    receipt: CashReceiptDraft | null;
    defaults: { customerName: string; receiptDate: string; recordedByName: string };
  }>(response, "Cash receipt details could not be loaded.");
}

export async function getClientShipmentCashReceipt(shipmentDraftId: string) {
  const response = await authenticatedFetch(`/api/v1/client/shipments/${encodeURIComponent(shipmentDraftId)}/cash-receipt`);
  return json<{ success: true; receipt: CashReceiptDraft | null }>(response, "Shipment cash receipt could not be loaded.");
}

export async function downloadClientCashReceipt(input: { receiptId: string; businessAccountId: string; receiptNumber: string }) {
  const query = new URLSearchParams({ businessAccountId: input.businessAccountId });
  const response = await authenticatedFetch(`/api/v1/client/documents/cash-receipts/${encodeURIComponent(input.receiptId)}/pdf?${query.toString()}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || "Cash receipt PDF could not be downloaded.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `CASH-RECEIPT-${input.receiptNumber}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadStaffCashReceiptDraft(shipmentDraftId: string) {
  const response = await authenticatedFetch(`${route("staff", shipmentDraftId)}/cash-receipt/pdf`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message || "Cash receipt PDF could not be downloaded.");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `cash-receipt-draft-${shipmentDraftId}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function loadRazorpayCheckout() {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-razorpay-checkout="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(Boolean(window.Razorpay)), { once: true });
      existing.addEventListener("error", () => resolve(false), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.dataset.razorpayCheckout = "true";
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export async function openShipmentRazorpayCheckout(input: {
  razorpay: RazorpayPublicConfig;
  payment: ShipmentPaymentIntent;
  prefill?: { name?: string; email?: string; contact?: string };
}) {
  if (!input.razorpay.keyId) throw new Error("Razorpay is not configured for online shipment payments.");
  if (!await loadRazorpayCheckout() || !window.Razorpay) {
    throw new Error("Razorpay checkout could not be loaded in this browser.");
  }
  return new Promise<RazorpayCheckoutResponse>((resolve, reject) => {
    const checkout = new window.Razorpay!({
      key: input.razorpay.keyId,
      amount: input.payment.amountMinor,
      currency: input.payment.currency,
      name: input.razorpay.merchantName,
      description: `Shipment ${input.payment.id.slice(-8).toUpperCase()}`,
      order_id: input.payment.razorpayOrderId,
      prefill: input.prefill,
      theme: { color: "#1e3a8a" },
      handler: resolve,
      modal: { ondismiss: () => reject(new Error("Payment checkout was closed before payment completed.")) }
    });
    checkout.open();
  });
}
