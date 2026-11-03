import mongoose from "mongoose";

export const operatorClientInvitationStatusValues = ["PENDING", "ACCEPTED", "REVOKED"] as const;
export type OperatorClientInvitationStatus = (typeof operatorClientInvitationStatusValues)[number];

export interface IOperatorClientInvitation extends mongoose.Document {
  tenantId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  businessAccountId: mongoose.Types.ObjectId;
  memberId: mongoose.Types.ObjectId;
  tokenHash: string;
  status: OperatorClientInvitationStatus;
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  invitedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// Auth resolves a single-use token before an operator request context exists.
// This control-plane record is intentionally not tenant-query-plugin scoped;
// every query must include the unguessable token hash or explicit tenant/user IDs.
const operatorClientInvitationSchema = new mongoose.Schema<IOperatorClientInvitation>({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccountMember", required: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: operatorClientInvitationStatusValues, required: true, default: "PENDING", index: true },
  expiresAt: { type: Date, required: true, index: true },
  acceptedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

operatorClientInvitationSchema.index(
  { tenantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: "PENDING" }, name: "uniq_pending_operator_client_invitation" }
);
operatorClientInvitationSchema.index(
  { tenantId: 1, businessAccountId: 1, status: 1, expiresAt: 1 },
  { name: "operator_client_invitation_expiry" }
);

export const OperatorClientInvitation = mongoose.model<IOperatorClientInvitation>(
  "OperatorClientInvitation",
  operatorClientInvitationSchema
);
