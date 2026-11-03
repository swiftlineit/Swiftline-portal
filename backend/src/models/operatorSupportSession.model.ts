import mongoose from "mongoose";

export interface IOperatorSupportSession extends mongoose.Document {
  tokenHash: string;
  operatorTenantId: mongoose.Types.ObjectId;
  actorUserId: mongoose.Types.ObjectId;
  reason: string;
  expiresAt: Date;
  endedAt?: Date | null;
  endedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const operatorSupportSessionSchema = new mongoose.Schema<IOperatorSupportSession>({
  tokenHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  operatorTenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  reason: { type: String, required: true, trim: true, minlength: 10, maxlength: 500 },
  expiresAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
  endedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, required: true, default: Date.now }
}, { versionKey: false });

operatorSupportSessionSchema.index({ tokenHash: 1 }, { unique: true, name: "uniq_operator_support_token_hash" });
operatorSupportSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "operator_support_session_expiry" });

export const OperatorSupportSession = mongoose.model<IOperatorSupportSession>(
  "OperatorSupportSession",
  operatorSupportSessionSchema
);
