import mongoose from "mongoose";
import { PrepaidAccount } from "../../models/prepaidAccount.model.js";
import { ShipmentDirectPayment } from "../../models/shipmentDirectPayment.model.js";
import { ShipmentAmendment } from "../../models/shipmentAmendment.model.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import type { AmendmentBillingAdjustment } from "../amendmentBilling.service.js";
import { createLedgerEntry } from "./ledger.service.js";
import { notifyLowWalletIfNeeded } from "./shipmentFunding.service.js";
import { ensurePrepaidAccount } from "./topups.service.js";
import { refundCapturedShipmentDirectPayment } from "./shipmentDirectPayments.service.js";

export class AmendmentPaymentError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export async function secureAmendmentDirectPayment(input: {
  amendmentId: mongoose.Types.ObjectId;
  paymentIntentId: mongoose.Types.ObjectId;
}) {
  const session = await mongoose.startSession();
  try {
    let result: InstanceType<typeof ShipmentAmendment> | null = null;
    let refundRejectedCapture = false;
    await session.withTransaction(async () => {
      refundRejectedCapture = false;
      const amendment = await ShipmentAmendment.findById(input.amendmentId).session(session).exec();
      if (!amendment) throw new AmendmentPaymentError(404, "Amendment not found.");
      const amountMinor = storedDeltaMinor(amendment);
      if (amountMinor <= 0 || amendment.paymentAmountMinor !== amountMinor) {
        throw new AmendmentPaymentError(409, "This amendment does not require an additional payment.");
      }
      // A checkout can finish after staff rejects an unpaid request. Preserve
      // that rejection and return the captured money through the same refund.
      if (amendment.status === "REJECTED") {
        const captured = await ShipmentDirectPayment.findOne({
          _id: input.paymentIntentId,
          shipmentDraftId: amendment.shipmentDraftId,
          businessAccountId: amendment.businessAccountId,
          branchId: amendment.branchId,
          amendmentId: amendment._id,
          paymentPurpose: "SHIPMENT_AMENDMENT",
          amountMinor,
          currency: "INR",
          status: { $in: ["CAPTURED", "REFUND_PENDING", "REFUNDED"] }
        }).session(session).exec();
        if (!captured) throw new AmendmentPaymentError(409, "The rejected amendment payment could not be reconciled.");
        refundRejectedCapture = true;
        result = amendment;
        return;
      }
      if (
        ["APPROVED", "APPLIED"].includes(amendment.status)
        && amendment.paymentStatus === "COMPLETED"
        && amendment.paymentSource === "DIRECT_RAZORPAY"
        && String(amendment.paymentReferenceId) === String(input.paymentIntentId)
      ) {
        result = amendment;
        return;
      }
      if (
        amendment.status === "PAYMENT_SECURED"
        && amendment.paymentStatus === "SECURED"
        && amendment.paymentSource === "DIRECT_RAZORPAY"
        && String(amendment.paymentReferenceId) === String(input.paymentIntentId)
      ) {
        const securedPayment = await ShipmentDirectPayment.findOne({
          _id: input.paymentIntentId,
          amendmentId: amendment._id,
          paymentPurpose: "SHIPMENT_AMENDMENT",
          status: "ALLOCATED",
          amountMinor
        }).session(session).exec();
        if (!securedPayment) throw new AmendmentPaymentError(409, "The amendment payment is not available for approval.");
        result = amendment;
        return;
      }
      if (amendment.status !== "AWAITING_PAYMENT" || amendment.paymentStatus !== "AWAITING_PAYMENT") {
        throw new AmendmentPaymentError(409, "This amendment is no longer awaiting payment.");
      }
      if (amendment.paymentReferenceId && String(amendment.paymentReferenceId) !== String(input.paymentIntentId)) {
        throw new AmendmentPaymentError(409, "A different payment attempt is attached to this amendment.");
      }

      const payment = await ShipmentDirectPayment.findOne({
        _id: input.paymentIntentId,
        shipmentDraftId: amendment.shipmentDraftId,
        businessAccountId: amendment.businessAccountId,
        branchId: amendment.branchId,
        amendmentId: amendment._id,
        paymentPurpose: "SHIPMENT_AMENDMENT",
        amountMinor,
        currency: "INR",
        status: { $in: ["CAPTURED", "ALLOCATED"] }
      }).session(session).exec();
      if (!payment) throw new AmendmentPaymentError(402, "Razorpay must confirm the additional amount before approval.");
      if (payment.status === "CAPTURED") {
        const allocated = await ShipmentDirectPayment.findOneAndUpdate(
          { _id: payment._id, status: "CAPTURED", amendmentId: amendment._id },
          { $set: { status: "ALLOCATED", allocatedAt: new Date() } },
          { returnDocument: "after", runValidators: true, session }
        ).exec();
        if (!allocated) throw new AmendmentPaymentError(409, "The Razorpay payment changed while it was being secured.");
      }
      amendment.status = "PAYMENT_SECURED";
      amendment.paymentStatus = "SECURED";
      amendment.paymentSource = "DIRECT_RAZORPAY";
      amendment.paymentReferenceId = payment._id as mongoose.Types.ObjectId;
      amendment.paymentSecuredAt = new Date();
      await amendment.save({ session });
      result = amendment;
    });
    if (refundRejectedCapture) {
      const refund = await refundCapturedShipmentDirectPayment({
        paymentIntentId: input.paymentIntentId,
        reason: "Payment captured after the amendment was rejected."
      });
      if (refund?.status !== "REFUNDED") {
        throw new AmendmentPaymentError(502, "The rejected amendment payment refund is pending reconciliation.");
      }
      await ShipmentAmendment.updateOne({ _id: input.amendmentId, status: "REJECTED" }, {
        $set: { paymentStatus: "RELEASED", paymentSource: "DIRECT_RAZORPAY", paymentReferenceId: input.paymentIntentId }
      }).exec();
      return ShipmentAmendment.findById(input.amendmentId).orFail().exec();
    }
    if (!result) throw new AmendmentPaymentError(409, "Amendment payment could not be secured.");
    return result;
  } finally {
    await session.endSession();
  }
}

function storedDeltaMinor(amendment: InstanceType<typeof ShipmentAmendment>) {
  const preview = amendment.fundingPreview as { deltaAmountMinor?: unknown } | null;
  const delta = preview?.deltaAmountMinor;
  if (typeof delta !== "number" || !Number.isInteger(delta)) {
    throw new AmendmentPaymentError(409, "The amendment payment amount is unavailable. Submit the amendment again.");
  }
  return delta;
}

export async function secureAmendmentWalletPayment(input: {
  amendmentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
}) {
  const session = await mongoose.startSession();
  try {
    let result: InstanceType<typeof ShipmentAmendment> | null = null;
    await session.withTransaction(async () => {
      const amendment = await ShipmentAmendment.findById(input.amendmentId).session(session).exec();
      if (!amendment) throw new AmendmentPaymentError(404, "Amendment not found.");
      if (amendment.paymentStatus === "SECURED" || amendment.paymentStatus === "COMPLETED") {
        result = amendment;
        return;
      }
      if (amendment.status !== "AWAITING_PAYMENT" || amendment.paymentStatus !== "AWAITING_PAYMENT") {
        throw new AmendmentPaymentError(409, "This amendment is not awaiting payment.");
      }
      const amountMinor = storedDeltaMinor(amendment);
      if (amountMinor <= 0 || amendment.paymentAmountMinor !== amountMinor) {
        throw new AmendmentPaymentError(409, "This amendment does not require an additional payment.");
      }

      const draft = await ShipmentDraft.findById(amendment.shipmentDraftId)
        .select("customerType")
        .session(session)
        .lean()
        .exec();
      if (!draft || draft.customerType === "INDIVIDUAL") {
        throw new AmendmentPaymentError(409, "Individual shipment amendments must be paid and recorded by Swiftline staff.");
      }

      const account = await ensurePrepaidAccount({ businessAccountId: amendment.businessAccountId }, session);
      if (account.status !== "ACTIVE") throw new AmendmentPaymentError(409, "The business wallet is not active.");
      const availableMinor = account.cashBalanceMinor - account.reservedBalanceMinor;
      if (availableMinor < amountMinor) {
        const shortfall = amountMinor - availableMinor;
        throw new AmendmentPaymentError(
          402,
          `Your wallet needs INR ${(shortfall / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} more to secure this amendment.`
        );
      }

      const updated = await PrepaidAccount.findOneAndUpdate(
        {
          _id: account._id,
          status: "ACTIVE",
          version: account.version,
          $expr: { $gte: [{ $subtract: ["$cashBalanceMinor", "$reservedBalanceMinor"] }, amountMinor] }
        },
        { $inc: { reservedBalanceMinor: amountMinor, version: 1 } },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!updated) throw new AmendmentPaymentError(409, "Wallet balance changed while payment was being secured. Please try again.");

      await createLedgerEntry({
        businessAccountId: amendment.businessAccountId,
        branchId: amendment.branchId,
        transactionType: "AMENDMENT_PAYMENT_RESERVED",
        direction: "NONE",
        amountMinor,
        currency: "INR",
        referenceType: "SHIPMENT_AMENDMENT",
        referenceId: amendment._id as mongoose.Types.ObjectId,
        idempotencyKey: `AMENDMENT_PAYMENT_RESERVED:${String(amendment._id)}`,
        paymentSource: "BUSINESS_WALLET",
        before: { cashBalanceMinor: updated.cashBalanceMinor, reservedBalanceMinor: updated.reservedBalanceMinor - amountMinor },
        after: { cashBalanceMinor: updated.cashBalanceMinor, reservedBalanceMinor: updated.reservedBalanceMinor },
        description: "Wallet funds reserved for a shipment amendment.",
        createdBy: input.userId
      }, session);

      result = await ShipmentAmendment.findOneAndUpdate(
        {
          _id: amendment._id,
          status: "AWAITING_PAYMENT",
          paymentStatus: "AWAITING_PAYMENT"
        },
        {
          $set: {
            status: "PAYMENT_SECURED",
            paymentStatus: "SECURED",
            paymentSource: "BUSINESS_WALLET",
            paymentReferenceId: amendment._id,
            paymentSecuredAt: new Date()
          }
        },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!result) throw new AmendmentPaymentError(409, "The amendment changed while payment was being secured.");
    });
    if (!result) throw new AmendmentPaymentError(409, "Amendment payment could not be secured.");
    return result;
  } finally {
    await session.endSession();
  }
}

export async function applyPrepaidAmendmentMovement(input: {
  amendmentId: mongoose.Types.ObjectId;
  adjustment: AmendmentBillingAdjustment;
  createdBy: mongoose.Types.ObjectId;
  session: mongoose.ClientSession;
}) {
  const amendment = await ShipmentAmendment.findById(input.amendmentId).session(input.session).exec();
  if (!amendment) throw new AmendmentPaymentError(404, "Amendment not found.");
  const delta = input.adjustment.deltaAmountMinor;
  if (delta > 0) {
    const draft = await ShipmentDraft.findById(amendment.shipmentDraftId)
      .select("customerType")
      .session(input.session)
      .lean()
      .exec();
    if (!draft) throw new AmendmentPaymentError(404, "Shipment not found.");
    if (amendment.paymentSource === "DIRECT_RAZORPAY") {
      if (
        amendment.status !== "PAYMENT_SECURED"
        || amendment.paymentStatus !== "SECURED"
        || amendment.paymentAmountMinor !== delta
        || !amendment.paymentReferenceId
      ) throw new AmendmentPaymentError(402, "Complete the Razorpay amendment payment before approval.");
      const payment = await ShipmentDirectPayment.findOne({
        _id: amendment.paymentReferenceId,
        amendmentId: amendment._id,
        paymentPurpose: "SHIPMENT_AMENDMENT",
        status: "ALLOCATED",
        amountMinor: delta
      }).session(input.session).exec();
      if (!payment) throw new AmendmentPaymentError(402, "The secured Razorpay payment could not be found.");
      const settledPayment = await ShipmentDirectPayment.findOneAndUpdate(
        {
          _id: payment._id,
          amendmentId: amendment._id,
          paymentPurpose: "SHIPMENT_AMENDMENT",
          status: "ALLOCATED",
          amountMinor: delta
        },
        { $set: { status: "SETTLED" } },
        { returnDocument: "after", runValidators: true, session: input.session }
      ).exec();
      if (!settledPayment) throw new AmendmentPaymentError(409, "The amendment payment changed while approval was being applied.");
      const updatedAmendment = await ShipmentAmendment.updateOne(
        { _id: amendment._id, paymentStatus: "SECURED", paymentSource: "DIRECT_RAZORPAY" },
        { $set: { paymentStatus: "COMPLETED", paymentCompletedAt: new Date() } },
        { runValidators: true, session: input.session }
      ).exec();
      if (!updatedAmendment.matchedCount) throw new AmendmentPaymentError(409, "The amendment payment could not be completed.");
      return { paymentStatus: "COMPLETED" as const, refundStatus: amendment.refundStatus };
    }
    if (draft.customerType === "INDIVIDUAL") {
      throw new AmendmentPaymentError(402, "Individual amendment increases must be paid through Razorpay before approval.");
    }
    if (
      amendment.status !== "PAYMENT_SECURED"
      || amendment.paymentStatus !== "SECURED"
      || amendment.paymentSource !== "BUSINESS_WALLET"
      || amendment.paymentAmountMinor !== delta
    ) throw new AmendmentPaymentError(402, "Pay the additional amendment amount before approval.");

    const account = await PrepaidAccount.findOneAndUpdate(
      {
        businessAccountId: amendment.businessAccountId,
        status: "ACTIVE",
        cashBalanceMinor: { $gte: delta },
        reservedBalanceMinor: { $gte: delta }
      },
      { $inc: { cashBalanceMinor: -delta, reservedBalanceMinor: -delta, version: 1 } },
      { returnDocument: "after", runValidators: true, session: input.session }
    ).exec();
    if (!account) throw new AmendmentPaymentError(409, "Reserved wallet funds could not be completed.");
    await createLedgerEntry({
      businessAccountId: amendment.businessAccountId,
      branchId: amendment.branchId,
      transactionType: "AMENDMENT_PAYMENT_COMPLETED",
      direction: "DEBIT",
      amountMinor: delta,
      currency: "INR",
      referenceType: "SHIPMENT_AMENDMENT",
      referenceId: amendment._id as mongoose.Types.ObjectId,
      idempotencyKey: `AMENDMENT_PAYMENT_COMPLETED:${String(amendment._id)}`,
      paymentSource: "BUSINESS_WALLET",
      before: { cashBalanceMinor: account.cashBalanceMinor + delta, reservedBalanceMinor: account.reservedBalanceMinor + delta },
      after: { cashBalanceMinor: account.cashBalanceMinor, reservedBalanceMinor: account.reservedBalanceMinor },
      description: "Additional shipment amendment charge completed from the wallet.",
      createdBy: input.createdBy
    }, input.session);
    await notifyLowWalletIfNeeded(account, input.session);
    await ShipmentAmendment.updateOne(
      { _id: amendment._id, paymentStatus: "SECURED" },
      { $set: { paymentStatus: "COMPLETED", paymentCompletedAt: new Date() } },
      { runValidators: true, session: input.session }
    ).exec();
    return { paymentStatus: "COMPLETED" as const, refundStatus: amendment.refundStatus };
  }

  if (delta < 0) {
    const draft = await ShipmentDraft.findById(amendment.shipmentDraftId)
      .select("customerType")
      .session(input.session)
      .lean()
      .exec();
    if (!draft) throw new AmendmentPaymentError(404, "Shipment not found.");
    if (draft.customerType === "INDIVIDUAL") {
      return { paymentStatus: amendment.paymentStatus, refundStatus: "CASH_REFUND_RECORDED" as const };
    }

    const amountMinor = Math.abs(delta);
    const current = await ensurePrepaidAccount({ businessAccountId: amendment.businessAccountId }, input.session);
    const account = await PrepaidAccount.findOneAndUpdate(
      { _id: current._id, version: current.version, status: "ACTIVE" },
      { $inc: { cashBalanceMinor: amountMinor, version: 1 } },
      { returnDocument: "after", runValidators: true, session: input.session }
    ).exec();
    if (!account) throw new AmendmentPaymentError(409, "Wallet balance changed while the amendment adjustment was being credited.");
    await createLedgerEntry({
      businessAccountId: amendment.businessAccountId,
      branchId: amendment.branchId,
      transactionType: "AMENDMENT_ADJUSTMENT_CREDITED",
      direction: "CREDIT",
      amountMinor,
      currency: "INR",
      referenceType: "SHIPMENT_AMENDMENT",
      referenceId: amendment._id as mongoose.Types.ObjectId,
      idempotencyKey: `AMENDMENT_ADJUSTMENT_CREDITED:${String(amendment._id)}`,
      paymentSource: "BUSINESS_WALLET",
      before: { cashBalanceMinor: account.cashBalanceMinor - amountMinor, reservedBalanceMinor: account.reservedBalanceMinor },
      after: { cashBalanceMinor: account.cashBalanceMinor, reservedBalanceMinor: account.reservedBalanceMinor },
      description: "Approved shipment amendment reduction credited to the business wallet.",
      createdBy: input.createdBy
    }, input.session);
    await ShipmentAmendment.updateOne(
      { _id: amendment._id },
      { $set: { refundStatus: "CREDITED_TO_WALLET" } },
      { runValidators: true, session: input.session }
    ).exec();
    return { paymentStatus: amendment.paymentStatus, refundStatus: "CREDITED_TO_WALLET" as const };
  }

  return { paymentStatus: amendment.paymentStatus, refundStatus: amendment.refundStatus };
}

export async function releaseAmendmentWalletPayment(input: {
  amendmentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  reason: string;
}) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const amendment = await ShipmentAmendment.findOne({
        _id: input.amendmentId,
        paymentStatus: "SECURED",
        paymentSource: "BUSINESS_WALLET"
      }).session(session).exec();
      if (!amendment) return;
      const amountMinor = amendment.paymentAmountMinor;
      const account = await PrepaidAccount.findOneAndUpdate(
        { businessAccountId: amendment.businessAccountId, reservedBalanceMinor: { $gte: amountMinor } },
        { $inc: { reservedBalanceMinor: -amountMinor, version: 1 } },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!account) throw new AmendmentPaymentError(409, "Reserved amendment funds could not be released.");
      await createLedgerEntry({
        businessAccountId: amendment.businessAccountId,
        branchId: amendment.branchId,
        transactionType: "AMENDMENT_PAYMENT_RELEASED",
        direction: "NONE",
        amountMinor,
        currency: "INR",
        referenceType: "SHIPMENT_AMENDMENT",
        referenceId: amendment._id as mongoose.Types.ObjectId,
        idempotencyKey: `AMENDMENT_PAYMENT_RELEASED:${String(amendment._id)}`,
        paymentSource: "BUSINESS_WALLET",
        before: { cashBalanceMinor: account.cashBalanceMinor, reservedBalanceMinor: account.reservedBalanceMinor + amountMinor },
        after: { cashBalanceMinor: account.cashBalanceMinor, reservedBalanceMinor: account.reservedBalanceMinor },
        description: input.reason,
        createdBy: input.userId
      }, session);
      await ShipmentAmendment.updateOne(
        { _id: amendment._id, paymentStatus: "SECURED" },
        { $set: { paymentStatus: "RELEASED" } },
        { runValidators: true, session }
      ).exec();
    });
  } finally {
    await session.endSession();
  }
}
