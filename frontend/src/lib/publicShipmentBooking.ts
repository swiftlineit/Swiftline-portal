import { apiUrl } from "@/lib/api";

export type BookingEntityType = "INDIVIDUAL" | "COMPANY";
export type PublicAddress = {
  entityType: BookingEntityType;
  companyName: string;
  contactName: string;
  email: string;
  mobileCountryCode: string;
  mobileNumber: string;
  countryCode: string;
  countryName: string;
  postcode: string;
  addressLine1: string;
  addressLine2: string;
  townOrCity: string;
  county: string;
  stateCode: string;
  deliveryInstructions: string;
};
export type PublicSender = PublicAddress & { aadhaarNumber: string };
export type PublicParcelItem = { description: string; hsnCode: string; unitType: "Pkt" | "Pcs" | "Set" | "Box" | "Kg" | "Pair"; quantity: number; unitRate: number };
export type PublicParcel = {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  shipmentContentType: "DOCUMENTS" | "PARCEL" | "MERCHANDISE" | "SAMPLES" | "GIFTS" | "RETURNS" | "OTHER";
  shipmentReference1: string;
  shipmentReference2: string;
  items: PublicParcelItem[];
};
export type PublicShipmentFormData = {
  sender: PublicSender;
  consignee: PublicAddress;
  serviceType: "COURIER" | "CARGO";
  csbType: "CSB_IV" | "CSB_V";
  csbVGstin: string;
  csbVAccountNumber: string;
  csbVInvoiceNumber: string;
  kycUseForAllParcels: boolean;
  parcels: PublicParcel[];
};

export type PublicBookingState = "DRAFT" | "QUOTED" | "PAYMENT_PENDING" | "PAYMENT_REVIEW_REQUIRED" | "FULFILLING" | "BOOKED" | "REVIEW_REQUIRED" | "REFUND_PENDING" | "REFUNDED";
export type PublicBooking = {
  reference: string;
  state: PublicBookingState;
  revision: number;
  quote: { amountMinor: number; currency: "INR"; pricingHash: string; expiresAt: string } | null;
  shipment: { trackingNumber: string; invoiceUrl: string; labelsUrl: string } | null;
};
export type PublicQuote = {
  amountMinor: number;
  currency: "INR";
  expiresAt: string;
  pricingHash: string;
  parcels: Array<{ sequence: number; actualWeightKg: number; volumetricWeightKg: number; chargeableWeightKg: number }>;
  lines: Array<{ code: string; label: string; kind: "CHARGE" | "TAX" | "DEDUCTION"; amountMinor: number; basis: string }>;
  totalWeightKg: number;
  totalVolumetricWeightKg: number;
  totalChargeableWeightKg: number;
};

async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; message?: string };
  if (!response.ok || !payload.success) {
    const error = new Error(payload.message || "The booking request could not be completed.") as Error & { details?: typeof payload };
    error.details = payload;
    throw error;
  }
  return payload as T;
}

export const startPublicBooking = () => publicRequest<{ success: true; booking: PublicBooking }>("/api/v1/public/shipment-bookings/session", { method: "POST" });
export const loadPublicBooking = (token = "") => publicRequest<{ success: true; booking: PublicBooking }>(`/api/v1/public/shipment-bookings/status${token ? `?token=${encodeURIComponent(token)}` : ""}`);
export const savePublicBookingDraft = (data: PublicShipmentFormData) => publicRequest<{ success: true; booking: PublicBooking; validationIssues: string[] }>("/api/v1/public/shipment-bookings/draft", { method: "PUT", body: JSON.stringify(data) });
export const requestPublicQuote = (recaptchaToken?: string) => publicRequest<{ success: true; booking: PublicBooking; quote: PublicQuote }>("/api/v1/public/shipment-bookings/quote", { method: "POST", body: JSON.stringify({ acceptedTerms: true, acceptedCancellationPolicy: true, acceptedProhibitedGoods: true, recaptchaToken }) });
export const createPublicPaymentOrder = () => publicRequest<{ success: true; order: { id: string; amountMinor: number; currency: "INR"; keyId: string; bookingReference: string } }>("/api/v1/public/shipment-bookings/payments/order", { method: "POST", body: JSON.stringify({}) });
export const confirmPublicPayment = (data: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) => publicRequest<{ success: true; booking: PublicBooking }>("/api/v1/public/shipment-bookings/payments/confirm", { method: "POST", body: JSON.stringify(data) });
export const loadPublicBookingPolicies = () => publicRequest<{ success: true; prohibitedGoods: string[] }>("/api/v1/public/shipment-bookings/policies");
export const uploadPublicKycDocument = (type: string, file: File, sequence?: number, documentLabel?: string) => {
  const body = new FormData();
  body.append("document", file);
  if (documentLabel) body.append("documentLabel", documentLabel);
  const path = sequence ? `/parcels/${sequence}/documents/${type}` : `/documents/${type}`;
  return publicRequest<{ success: true; kycDocuments: Record<string, { originalName: string } | null>; validationIssues: string[] }>(`/api/v1/public/shipment-bookings${path}`, { method: "POST", body });
};

export function formatRupees(amountMinor: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(amountMinor / 100);
}
