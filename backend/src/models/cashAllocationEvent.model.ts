import mongoose from "mongoose";
import { isMinorUnitInteger } from "./financialTypes.js";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const cashAllocationEventTypeValues = ["RECEIPT_FINALIZED", "ALLOCATED", "RELEASED", "REFUNDED", "REVERSED"] as const;
export type CashAllocationEventType = (typeof cashAllocationEventTypeValues)[number];

export interface ICashAllocationEvent extends mongoose.Document, TenantOwnedFields {
  cashReceiptId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  eventType: CashAllocationEventType;
  amountMinor: number;
  shipmentDraftId?: mongoose.Types.ObjectId | null;
  creditStatementId?: mongoose.Types.ObjectId | null;
  idempotencyKey: string;
  reason: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const cashAllocationEventSchema = new mongoose.Schema<ICashAllocationEvent>({
  cashReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "CashReceipt", required: true, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
  eventType: { type: String, enum: cashAllocationEventTypeValues, required: true, index: true },
  amountMinor: { type: Number, required: true, min: 1, validate: { validator: isMinorUnitInteger, message: "amountMinor must be an integer minor-unit amount" } },
  shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", default: null, index: true },
  creditStatementId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditBillingStatement", default: null, index: true },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 256 },
  reason: { type: String, trim: true, maxlength: 500, default: "" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: { createdAt: true, updatedAt: false } });

cashAllocationEventSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, name: "tenant_cash_allocation_idempotency" });
cashAllocationEventSchema.index({ tenantId: 1, cashReceiptId: 1, createdAt: 1 }, { name: "tenant_cash_allocation_history" });

const rejectCashAllocationMutation = () => {
  throw new Error("Cash allocation events are append-only.");
};
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  cashAllocationEventSchema.pre(operation as mongoose.MongooseQueryMiddleware, { document: false, query: true }, rejectCashAllocationMutation);
}
cashAllocationEventSchema.pre("save", function rejectExistingCashAllocationSave() {
  if (!this.isNew) rejectCashAllocationMutation();
});

addTenantOwnership(cashAllocationEventSchema, { allowReadOnlyAuditAppend: true });

export const CashAllocationEvent = mongoose.model<ICashAllocationEvent>("CashAllocationEvent", cashAllocationEventSchema);
