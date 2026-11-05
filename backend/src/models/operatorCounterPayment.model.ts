import mongoose from "mongoose";
import { counterPaymentMethodValues, type CounterPaymentMethod } from "./counterPayment.model.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface IOperatorCounterPayment extends mongoose.Document, TenantOwnedFields {
  shipmentDraftId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  direction: "COLLECTED" | "REFUNDED";
  sourceType: "BOOKING" | "AMENDMENT" | "CANCELLATION";
  sourceId: mongoose.Types.ObjectId;
  amountMinor: number;
  method: CounterPaymentMethod;
  reference: string;
  note: string;
  recordedBy: mongoose.Types.ObjectId;
  recordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const operatorCounterPaymentSchema = new mongoose.Schema<IOperatorCounterPayment>(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    direction: { type: String, enum: ["COLLECTED", "REFUNDED"], required: true },
    sourceType: { type: String, enum: ["BOOKING", "AMENDMENT", "CANCELLATION"], required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, enum: counterPaymentMethodValues, required: true },
    reference: { type: String, trim: true, maxlength: 80, default: "" },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    recordedAt: { type: Date, required: true, default: Date.now }
  },
  { timestamps: true }
);

operatorCounterPaymentSchema.index(
  { tenantId: 1, sourceType: 1, sourceId: 1 },
  { unique: true, name: "uniq_operator_counter_payment_tenant_source" }
);
addTenantOwnership(operatorCounterPaymentSchema);

export const OperatorCounterPayment = mongoose.model<IOperatorCounterPayment>(
  "OperatorCounterPayment",
  operatorCounterPaymentSchema
);
