import mongoose from "mongoose";
import { getTenantContext } from "./tenantScope.service.js";
import { OperatorCounterPayment } from "../models/operatorCounterPayment.model.js";
import type { CounterPaymentMethod } from "../models/counterPayment.model.js";

export class OperatorCounterPaymentConflictError extends Error {
  constructor() {
    super("A different payment record already exists for this individual shipment.");
    this.name = "OperatorCounterPaymentConflictError";
  }
}

export async function recordOperatorCounterCollection(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  amountMinor: number;
  payment: { method: CounterPaymentMethod; reference?: string; note?: string };
  recordedBy: mongoose.Types.ObjectId;
}) {
  return recordOperatorCounterPayment({
    ...input,
    sourceType: "BOOKING",
    sourceId: input.shipmentDraftId,
    direction: "COLLECTED"
  });
}

export async function recordOperatorCounterPayment(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  sourceType: "BOOKING" | "AMENDMENT" | "CANCELLATION";
  sourceId: mongoose.Types.ObjectId;
  direction: "COLLECTED" | "REFUNDED";
  amountMinor: number;
  payment: { method: CounterPaymentMethod; reference?: string; note?: string };
  recordedBy: mongoose.Types.ObjectId;
}) {
  const context = getTenantContext();
  if (!context || context.kind !== "OPERATOR") {
    throw new Error("Operator counter payments require an authenticated operator tenant.");
  }

  const values = {
    branchId: input.branchId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    direction: input.direction,
    amountMinor: input.amountMinor,
    method: input.payment.method,
    reference: input.payment.reference?.trim() ?? "",
    note: input.payment.note?.trim() ?? "",
    recordedBy: input.recordedBy
  };
  const existing = await OperatorCounterPayment.findOne({
    sourceType: input.sourceType,
    sourceId: input.sourceId
  }).exec();
  if (existing) {
    if (!matchesCollection(existing, values)) throw new OperatorCounterPaymentConflictError();
    return { payment: existing, created: false };
  }

  try {
    const [payment] = await OperatorCounterPayment.create([{
      tenantId: context.tenantId,
      shipmentDraftId: input.shipmentDraftId,
      ...values
    }]);
    if (!payment) throw new Error("The operator payment record could not be saved.");
    return { payment, created: true };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const racedPayment = await OperatorCounterPayment.findOne({
      sourceType: input.sourceType,
      sourceId: input.sourceId
    }).exec();
    if (!racedPayment || !matchesCollection(racedPayment, values)) {
      throw new OperatorCounterPaymentConflictError();
    }
    return { payment: racedPayment, created: false };
  }
}

function matchesCollection(
  payment: Pick<InstanceType<typeof OperatorCounterPayment>, "branchId" | "sourceType" | "sourceId" | "direction" | "amountMinor" | "method" | "reference" | "note">,
  values: {
    branchId: mongoose.Types.ObjectId;
    sourceType: "BOOKING" | "AMENDMENT" | "CANCELLATION";
    sourceId: mongoose.Types.ObjectId;
    direction: "COLLECTED" | "REFUNDED";
    amountMinor: number;
    method: CounterPaymentMethod;
    reference: string;
    note: string;
  }
) {
  return payment.branchId.equals(values.branchId)
    && payment.sourceType === values.sourceType
    && payment.sourceId.equals(values.sourceId)
    && payment.direction === values.direction
    && payment.amountMinor === values.amountMinor
    && payment.method === values.method
    && payment.reference === values.reference
    && payment.note === values.note;
}
