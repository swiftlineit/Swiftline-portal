import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface IBusinessAccountInvitation extends mongoose.Document, TenantOwnedFields {
  user: mongoose.Types.ObjectId;
  businessAccount: mongoose.Types.ObjectId;
  member: mongoose.Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const businessAccountInvitationSchema = new mongoose.Schema<IBusinessAccountInvitation>(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    businessAccount: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccountMember", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true }
);

businessAccountInvitationSchema.index({ businessAccount: 1, user: 1, acceptedAt: 1, revokedAt: 1 });

addTenantOwnership(businessAccountInvitationSchema);

export const BusinessAccountInvitation = mongoose.model<IBusinessAccountInvitation>(
  "BusinessAccountInvitation",
  businessAccountInvitationSchema
);
