import { env } from "../../config/env.js";

type RazorpayOrderResponse = {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
};

export type RazorpayPaymentResponse = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
};

export type RazorpayRefundResponse = {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
};

function getRazorpayCredentials() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay credentials are not configured.");
  }

  return {
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET
  };
}

export function getRazorpayPublicConfig() {
  const credentials = getRazorpayCredentials();
  return { keyId: credentials.keyId };
}

export async function createRazorpayOrder(input: {
  amountMinor: number;
  currency: "INR";
  receipt: string;
  notes?: Record<string, string>;
}) {
  const credentials = getRazorpayCredentials();
  const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64");

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {}
    })
  });

  const data = await response.json() as Partial<RazorpayOrderResponse> & { error?: { description?: string } };
  if (!response.ok || !data.id || typeof data.amount !== "number") {
    throw new Error(data.error?.description || "Razorpay order could not be created.");
  }

  return data as RazorpayOrderResponse;
}

export async function fetchRazorpayPayment(paymentId: string) {
  const credentials = getRazorpayCredentials();
  const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64");
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await response.json() as Partial<RazorpayPaymentResponse> & { error?: { description?: string } };

  if (!response.ok || !data.id || typeof data.amount !== "number" || !data.status) {
    throw new Error(data.error?.description || "Razorpay payment status could not be verified.");
  }

  return data as RazorpayPaymentResponse;
}

export async function captureRazorpayPayment(input: {
  paymentId: string;
  amountMinor: number;
  currency: "INR";
}) {
  const credentials = getRazorpayCredentials();
  const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64");
  const response = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(input.paymentId)}/capture`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency
      })
    }
  );
  const data = await response.json() as Partial<RazorpayPaymentResponse> & { error?: { description?: string } };

  if (!response.ok || !data.id || data.status !== "captured") {
    throw new Error(data.error?.description || "Razorpay payment could not be captured.");
  }

  return data as RazorpayPaymentResponse;
}

/** Idempotent refund for a captured payment whose shipment never became durable. */
export async function createRazorpayRefund(input: {
  paymentId: string;
  amountMinor: number;
  idempotencyKey: string;
}) {
  const credentials = getRazorpayCredentials();
  const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64");
  const response = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(input.paymentId)}/refund`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "X-Razorpay-Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({ amount: input.amountMinor, speed: "normal" }),
    },
  );
  const data = await response.json() as Partial<RazorpayRefundResponse> & { error?: { description?: string } };
  if (!response.ok || !data.id || typeof data.amount !== "number") {
    throw new Error(data.error?.description || "Razorpay refund could not be created.");
  }
  return data as RazorpayRefundResponse;
}
