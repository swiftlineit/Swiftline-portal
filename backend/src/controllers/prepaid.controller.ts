import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { env } from "../config/env.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { PaymentTopUp, type IPaymentTopUp, type PaymentTopUpStatus } from "../models/paymentTopUp.model.js";
import { PrepaidAccount } from "../models/prepaidAccount.model.js";
import { PrepaidTransaction } from "../models/prepaidTransaction.model.js";
import {
  captureRazorpayPayment,
  createRazorpayOrder,
  fetchRazorpayPayment,
  getRazorpayPublicConfig
} from "../services/razorpay/client.js";
import { verifyRazorpayCheckoutSignature } from "../services/razorpay/signatures.js";
import {
  cancelPaymentTopUp,
  createPaymentTopUp,
  ensurePrepaidAccount,
  findPaymentTopUpByIdempotencyKey,
  findPaymentTopUpByRazorpayOrderId,
  markPaymentTopUpCheckoutVerified,
  creditCapturedTopUp
} from "../services/prepaid/topups.service.js";
import { dailyLimitMessage, getDailyTopUpUsage } from "../services/prepaid/dailyTopUpLimit.service.js";
import { canAccessCreditFinancials } from "../services/creditAccount.service.js";

const createTopUpSchema = z.object({
  businessAccountId: z.string().trim().optional(),
  amountMinor: z.number().int().positive(),
  purpose: z.enum(["CUSTOMER_ADVANCE", "SECURITY_DEPOSIT"]).optional().default("CUSTOMER_ADVANCE")
});

const verifyTopUpSchema = z.object({
  razorpay_order_id: z.string().trim().min(1),
  razorpay_payment_id: z.string().trim().min(1),
  razorpay_signature: z.string().trim().min(1)
});

function getAuthenticatedUserId(request: Request) {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  return user?._id && mongoose.Types.ObjectId.isValid(String(user._id))
    ? new mongoose.Types.ObjectId(String(user._id))
    : null;
}

async function getClientBusinessAccount(userId: mongoose.Types.ObjectId, businessAccountId?: string) {
  const filters: Record<string, unknown> = {
    user: userId,
    status: "active"
  };

  if (businessAccountId) {
    if (!mongoose.Types.ObjectId.isValid(businessAccountId)) return null;
    filters.businessAccount = new mongoose.Types.ObjectId(businessAccountId);
  }

  const membership = await BusinessAccountMember.findOne(filters)
    .populate("businessAccount", "accountId company.companyName status suspension.mode depositStatus")
    .sort({ createdAt: -1 })
    .exec();

  if (!membership?.businessAccount) return null;
  if (!canAccessCreditFinancials(membership.role)) return null;

  const account = membership.businessAccount as unknown as {
    _id?: mongoose.Types.ObjectId;
    accountId?: string;
    company?: { companyName?: string };
    depositStatus?: string;
    status?: string;
    suspension?: { mode?: string } | null;
  };

  if (account.status === "suspended" && account.suspension?.mode === "SECURITY_LOCK") return null;

  return account._id ? { membership, account, businessAccountId: account._id } : null;
}

function serializeTopUp(topUp: {
  _id: unknown;
  businessAccountId: unknown;
  amountMinor: number;
  currency: string;
  purpose?: string;
  internalReference: string;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: String(topUp._id),
    businessAccountId: String(topUp.businessAccountId),
    amountMinor: topUp.amountMinor,
    currency: topUp.currency,
    purpose: topUp.purpose ?? "CUSTOMER_ADVANCE",
    internalReference: topUp.internalReference,
    razorpayOrderId: topUp.razorpayOrderId,
    razorpayPaymentId: topUp.razorpayPaymentId || "",
    status: topUp.status,
    createdAt: topUp.createdAt,
    updatedAt: topUp.updatedAt
  };
}

async function reconcileRazorpayTopUp(topUp: IPaymentTopUp, createdBy?: mongoose.Types.ObjectId) {
  if (!topUp.razorpayPaymentId) return { captured: false, topUp };

  let payment = await fetchRazorpayPayment(topUp.razorpayPaymentId);
  if (
    payment.order_id !== topUp.razorpayOrderId
    || payment.amount !== topUp.amountMinor
    || payment.currency !== topUp.currency
  ) {
    throw new Error("Razorpay payment details do not match this payment request.");
  }

  if (payment.status === "authorized") {
    try {
      payment = await captureRazorpayPayment({
        paymentId: payment.id,
        amountMinor: topUp.amountMinor,
        currency: topUp.currency
      });
    } catch (captureError) {
      // A webhook or another reconciliation may have captured it concurrently.
      payment = await fetchRazorpayPayment(payment.id);
      if (payment.status !== "captured") throw captureError;
    }
  }

  if (payment.status !== "captured") return { captured: false, topUp };

  await creditCapturedTopUp({
    paymentTopUpId: topUp._id as mongoose.Types.ObjectId,
    razorpayPaymentId: payment.id,
    razorpaySignature: topUp.razorpaySignature,
    idempotencyKey: `RAZORPAY_TOPUP:${payment.id}`,
    expectedAmountMinor: payment.amount,
    expectedCurrency: topUp.currency,
    createdBy: createdBy ?? topUp.clientUserId
  });

  return {
    captured: true,
    topUp: await PaymentTopUp.findById(topUp._id).exec() ?? topUp
  };
}

export async function getClientPrepaidAccount(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const businessAccountId = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : undefined;
  const clientAccount = await getClientBusinessAccount(userId, businessAccountId);
  if (!clientAccount) return response.status(404).json({ success: false, message: "Business account not found" });

  const account = await ensurePrepaidAccount({ businessAccountId: clientAccount.businessAccountId });
  const dailyTopUp = await getDailyTopUpUsage({ businessAccountId: clientAccount.businessAccountId });

  return response.status(200).json({
    success: true,
    prepaidAccount: {
      businessAccountId: String(account.businessAccountId),
      currency: account.currency,
      cashBalanceMinor: account.cashBalanceMinor,
      reservedBalanceMinor: account.reservedBalanceMinor,
      availableBalanceMinor: account.cashBalanceMinor - account.reservedBalanceMinor,
      status: account.status,
      minimumBalanceWarningMinor: account.minimumBalanceWarningMinor,
      // Per-transaction bounds and today's remaining allowance, so the payment
      // form can enforce the same rules the server does.
      minTopUpMinor: env.RAZORPAY_MIN_TOPUP_MINOR,
      maxTopUpMinor: env.RAZORPAY_MAX_TOPUP_MINOR,
      dailyTopUp
    }
  });
}

export async function listClientPrepaidTransactions(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const businessAccountId = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : undefined;
  const clientAccount = await getClientBusinessAccount(userId, businessAccountId);
  if (!clientAccount) return response.status(404).json({ success: false, message: "Business account not found" });

  const transactions = await PrepaidTransaction.find({ businessAccountId: clientAccount.businessAccountId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()
    .exec();

  return response.status(200).json({ success: true, transactions });
}

export async function createClientPrepaidTopUp(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = createTopUpSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  if (
    parsed.data.purpose !== "SECURITY_DEPOSIT"
    && (parsed.data.amountMinor < env.RAZORPAY_MIN_TOPUP_MINOR || parsed.data.amountMinor > env.RAZORPAY_MAX_TOPUP_MINOR)
  ) {
    return response.status(400).json({
      success: false,
      message: `Top-up amount must be between ${env.RAZORPAY_MIN_TOPUP_MINOR} and ${env.RAZORPAY_MAX_TOPUP_MINOR} paise.`
    });
  }

  const idempotencyKey = request.header("Idempotency-Key") || "";
  if (!idempotencyKey) return response.status(400).json({ success: false, message: "Idempotency-Key header is required." });

  const existing = await findPaymentTopUpByIdempotencyKey(idempotencyKey);
  if (existing) {
    return response.status(200).json({
      success: true,
      duplicate: true,
      razorpay: getRazorpayPublicConfig(),
      topUp: serializeTopUp(existing)
    });
  }

  const clientAccount = await getClientBusinessAccount(userId, parsed.data.businessAccountId);
  if (!clientAccount) return response.status(404).json({ success: false, message: "Business account not found" });
  if (clientAccount.account.status === "suspended") {
    return response.status(423).json({ success: false, message: "Prepaid top-ups are paused while this account is suspended." });
  }

  const creditAccount = await BusinessCreditAccount.findOne({ businessAccountId: clientAccount.businessAccountId }).lean().exec();
  if (parsed.data.purpose === "SECURITY_DEPOSIT") {
    if (clientAccount.account.depositStatus === "received") {
      return response.status(409).json({ success: false, message: "The required security deposit has already been received." });
    }
    if (!creditAccount || creditAccount.securityDepositRequiredMinor <= 0) {
      return response.status(409).json({ success: false, message: "A security deposit is not required for this account." });
    }
    if (creditAccount.securityDepositRequiredMinor !== parsed.data.amountMinor) {
      return response.status(400).json({ success: false, message: "Enter the exact required security deposit amount." });
    }
  }

  // Fail before an order exists at Razorpay when the account is already at its
  // daily ceiling. The authoritative check runs again once the row exists.
  if (parsed.data.purpose === "CUSTOMER_ADVANCE") {
    const usage = await getDailyTopUpUsage({ businessAccountId: clientAccount.businessAccountId });
    if (parsed.data.amountMinor > usage.remainingMinor) {
      return response.status(409).json({
        success: false,
        message: dailyLimitMessage(usage.remainingMinor),
        dailyTopUp: usage
      });
    }
  }

  const internalReference = `${parsed.data.purpose === "SECURITY_DEPOSIT" ? "DEPOSIT" : "TOPUP"}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const razorpayOrder = await createRazorpayOrder({
    amountMinor: parsed.data.amountMinor,
    currency: "INR",
    receipt: internalReference,
    notes: {
      businessAccountId: String(clientAccount.businessAccountId),
      clientUserId: String(userId)
    }
  });

  const topUpResult = await createPaymentTopUp({
    businessAccountId: clientAccount.businessAccountId,
    clientUserId: userId,
    amountMinor: parsed.data.amountMinor,
    currency: "INR",
    purpose: parsed.data.purpose,
    internalReference,
    idempotencyKey,
    razorpayOrderId: razorpayOrder.id
  });

  // Two requests can pass the pre-check at once, so the row is created first and
  // then confirmed against everything created at or before it. The earlier row
  // wins; the later one is cancelled before its order is ever handed back.
  if (parsed.data.purpose === "CUSTOMER_ADVANCE" && topUpResult.created) {
    const confirmed = await getDailyTopUpUsage({
      businessAccountId: clientAccount.businessAccountId,
      upTo: { createdAt: topUpResult.topUp.createdAt, id: topUpResult.topUp._id as mongoose.Types.ObjectId }
    });
    if (confirmed.usedMinor > confirmed.limitMinor) {
      await cancelPaymentTopUp(topUpResult.topUp._id as mongoose.Types.ObjectId);
      const usage = await getDailyTopUpUsage({ businessAccountId: clientAccount.businessAccountId });
      return response.status(409).json({
        success: false,
        message: dailyLimitMessage(usage.remainingMinor),
        dailyTopUp: usage
      });
    }
  }

  return response.status(201).json({
    success: true,
    duplicate: !topUpResult.created,
    razorpay: getRazorpayPublicConfig(),
    topUp: serializeTopUp(topUpResult.topUp)
  });
}

export async function verifyClientPrepaidTopUp(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = verifyTopUpSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  if (!env.RAZORPAY_KEY_SECRET) {
    return response.status(500).json({ success: false, message: "Razorpay credentials are not configured." });
  }

  const topUp = await findPaymentTopUpByRazorpayOrderId(parsed.data.razorpay_order_id);
  if (!topUp) return response.status(404).json({ success: false, message: "Top-up not found" });

  const clientAccount = await getClientBusinessAccount(userId, String(topUp.businessAccountId));
  if (!clientAccount) return response.status(403).json({ success: false, message: "Top-up is not available for this client." });

  const verified = verifyRazorpayCheckoutSignature({
    orderId: parsed.data.razorpay_order_id,
    paymentId: parsed.data.razorpay_payment_id,
    signature: parsed.data.razorpay_signature,
    secret: env.RAZORPAY_KEY_SECRET
  });

  if (!verified) return response.status(400).json({ success: false, message: "Invalid Razorpay signature." });

  const updatedTopUp = await markPaymentTopUpCheckoutVerified({
    razorpayOrderId: parsed.data.razorpay_order_id,
    razorpayPaymentId: parsed.data.razorpay_payment_id,
    razorpaySignature: parsed.data.razorpay_signature
  });

  try {
    const reconciliation = await reconcileRazorpayTopUp(updatedTopUp ?? topUp, userId);
    if (reconciliation.captured) {
      return response.status(200).json({
        success: true,
        message: topUp.purpose === "SECURITY_DEPOSIT"
          ? "Security deposit received successfully."
          : "Payment received and Customer Advance updated.",
        topUp: serializeTopUp(reconciliation.topUp)
      });
    }
  } catch (error) {
    return response.status(502).json({
      success: false,
      message: error instanceof Error
        ? `Payment was verified, but capture confirmation failed: ${error.message}`
        : "Payment was verified, but capture confirmation failed. Refresh and try again."
    });
  }

  return response.status(200).json({
    success: true,
    message: topUp.purpose === "SECURITY_DEPOSIT"
      ? "Security deposit payment is awaiting capture confirmation."
      : "Payment is awaiting capture confirmation.",
    topUp: updatedTopUp ? serializeTopUp(updatedTopUp) : serializeTopUp(topUp)
  });
}

export async function getClientPrepaidTopUp(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const topUpId = typeof request.params.id === "string" ? request.params.id : "";
  if (!mongoose.Types.ObjectId.isValid(topUpId)) {
    return response.status(404).json({ success: false, message: "Top-up not found" });
  }

  const topUp = await PaymentTopUp.findById(topUpId).exec();
  if (!topUp) return response.status(404).json({ success: false, message: "Top-up not found" });

  const clientAccount = await getClientBusinessAccount(userId, String(topUp.businessAccountId));
  if (!clientAccount) return response.status(403).json({ success: false, message: "Top-up is not available for this client." });

  let reconciledTopUp: IPaymentTopUp = topUp;
  if (topUp.status === "PROCESSING" && topUp.razorpayPaymentId) {
    try {
      reconciledTopUp = (await reconcileRazorpayTopUp(topUp, userId)).topUp;
    } catch {
      // A temporary Razorpay failure must not prevent the client from viewing payment history.
    }
  }

  return response.status(200).json({ success: true, topUp: serializeTopUp(reconciledTopUp) });
}

export async function listClientPrepaidTopUps(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const businessAccountId = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : undefined;
  const clientAccount = await getClientBusinessAccount(userId, businessAccountId);
  if (!clientAccount) return response.status(404).json({ success: false, message: "Business account not found" });

  /**
   * Abandoned checkouts are hidden from history.
   *
   * CREATED and CHECKOUT_OPENED mean the customer opened the payment page and
   * did not pay. They are intents, not transactions, and listing them reads as
   * a payment that happened. A recent one is still shown: a payment can sit in
   * that state for a few minutes while the provider settles, and a customer
   * whose money has just left should never see an empty history.
   */
  const abandonedBefore = new Date(Date.now() - 30 * 60 * 1000);
  const abandonedStatuses: PaymentTopUpStatus[] = ["CREATED", "CHECKOUT_OPENED"];
  const visibleTopUps = {
    businessAccountId: clientAccount.businessAccountId,
    $or: [
      { status: { $nin: abandonedStatuses } },
      { status: { $in: abandonedStatuses }, createdAt: { $gte: abandonedBefore } }
    ]
  };
  const topUps = await PaymentTopUp.find(visibleTopUps)
    .sort({ createdAt: -1 })
    .limit(100)
    .exec();

  // Reconcile only recent pending payments to keep history loading predictable.
  for (const topUp of topUps.filter((item) => item.status === "PROCESSING" && item.razorpayPaymentId).slice(0, 5)) {
    try {
      await reconcileRazorpayTopUp(topUp, userId);
    } catch {
      // Webhooks can still complete the payment if the provider lookup is temporarily unavailable.
    }
  }

  const refreshedTopUps = await PaymentTopUp.find(visibleTopUps)
    .sort({ createdAt: -1 })
    .limit(100)
    .exec();

  return response.status(200).json({ success: true, topUps: refreshedTopUps.map(serializeTopUp) });
}
