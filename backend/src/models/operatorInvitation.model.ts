import mongoose from "mongoose";

export const operatorInvitationStatusValues = ["PENDING", "ACCEPTED", "REVOKED"] as const;
export type OperatorInvitationStatus = (typeof operatorInvitationStatusValues)[number];

export interface IOperatorInvitation extends mongoose.Document {
  tenantId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: "OPERATOR_ADMIN";
  tokenHash: string;
  status: OperatorInvitationStatus;
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  invitedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// This is an identity/control-plane record. It deliberately does not use the
// tenant query plugin because the shared auth endpoints resolve invitation
// tokens before an operator request context exists. Every query in the
// invitation service still includes the token hash and, where applicable, the
// tenant and user IDs.
const operatorInvitationSchema = new mongoose.Schema<IOperatorInvitation>({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: ["OPERATOR_ADMIN"], required: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: operatorInvitationStatusValues, required: true, default: "PENDING" },
  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

operatorInvitationSchema.index(
  { tenantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: "PENDING" }, name: "uniq_pending_operator_invitation" }
);
operatorInvitationSchema.index({ tenantId: 1, status: 1, expiresAt: 1 }, { name: "operator_invitation_expiry" });

export const OperatorInvitation = mongoose.model<IOperatorInvitation>("OperatorInvitation", operatorInvitationSchema);
