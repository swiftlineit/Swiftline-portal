import mongoose from "mongoose";

export const tenantMembershipRoleValues = ["OPERATOR_ADMIN", "OPERATIONS", "FINANCE", "CLIENT"] as const;
export const tenantMembershipStatusValues = ["INVITED", "ACTIVE", "SUSPENDED", "REMOVED"] as const;
export type TenantMembershipRole = (typeof tenantMembershipRoleValues)[number];
export type TenantMembershipStatus = (typeof tenantMembershipStatusValues)[number];

export interface ITenantMembership extends mongoose.Document {
  tenantId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: TenantMembershipRole;
  status: TenantMembershipStatus;
  assignedBranches: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const tenantMembershipSchema = new mongoose.Schema<ITenantMembership>({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: tenantMembershipRoleValues, required: true },
  status: { type: String, enum: tenantMembershipStatusValues, required: true, default: "INVITED" },
  assignedBranches: [{ type: mongoose.Schema.Types.ObjectId, ref: "Branch" }]
}, { timestamps: true });

// One membership per person and operator; changing roles retains the same record.
tenantMembershipSchema.index({ tenantId: 1, userId: 1 }, { unique: true, name: "uniq_tenant_membership" });
tenantMembershipSchema.index({ userId: 1, status: 1 }, { name: "tenant_membership_user_status" });

export const TenantMembership = mongoose.model<ITenantMembership>("TenantMembership", tenantMembershipSchema);
