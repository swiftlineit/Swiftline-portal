import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface ICashReceiptRead extends mongoose.Document, TenantOwnedFields {
  cashReceiptId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  readAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const cashReceiptReadSchema = new mongoose.Schema<ICashReceiptRead>({
  cashReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "CashReceipt", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  readAt: { type: Date, required: true, default: Date.now }
}, { timestamps: true });

cashReceiptReadSchema.index({ tenantId: 1, cashReceiptId: 1, userId: 1 }, { unique: true, name: "tenant_cash_receipt_read_user" });
addTenantOwnership(cashReceiptReadSchema);

export const CashReceiptRead = mongoose.model<ICashReceiptRead>("CashReceiptRead", cashReceiptReadSchema);
