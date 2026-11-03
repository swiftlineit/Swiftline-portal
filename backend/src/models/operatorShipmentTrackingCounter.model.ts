import mongoose from "mongoose";
import { addTenantOwnership } from "./plugins/tenantOwnedSchema.plugin.js";

export interface IOperatorShipmentTrackingCounter extends mongoose.Document {
  tenantId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  dateKey: string;
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
}

const operatorShipmentTrackingCounterSchema = new mongoose.Schema<IOperatorShipmentTrackingCounter>(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, immutable: true },
    dateKey: { type: String, required: true, trim: true, match: /^\d{8}$/ },
    sequence: { type: Number, required: true, min: 1 }
  },
  { timestamps: true }
);

operatorShipmentTrackingCounterSchema.index(
  { tenantId: 1, branchId: 1, dateKey: 1 },
  { unique: true, name: "uniq_operator_tracking_counter_tenant_branch_day" }
);
addTenantOwnership(operatorShipmentTrackingCounterSchema);

export const OperatorShipmentTrackingCounter = mongoose.model<IOperatorShipmentTrackingCounter>(
  "OperatorShipmentTrackingCounter",
  operatorShipmentTrackingCounterSchema
);
