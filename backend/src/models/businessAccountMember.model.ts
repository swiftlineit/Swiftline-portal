import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const businessAccountMemberRoleValues = [
  "account_owner",
  "account_admin",
  /** Books shipments and requests pickups, but sees no money and no claims. */
  "booking_user",
  "operations",
  "finance",
  /** Raises and follows compensation claims, without booking rights. */
  "claims_user",
  "tracking_only"
] as const;

/** What each role is called wherever a person picks one. */
export const businessAccountMemberRoleLabels: Record<BusinessAccountMemberRole, string> = {
  account_owner: "Account Administrator",
  account_admin: "Account Administrator",
  booking_user: "Booking User",
  operations: "Operations User",
  finance: "Finance User",
  claims_user: "Claims User",
  tracking_only: "Tracking Only"
};

/**
 * Membership lifecycle.
 *
 * `pending_approval` sits before `invited` and exists because a business
 * account administrator can now raise an invitation themselves. Anyone they
 * name would gain immediate sight of that account's shipments, invoices and
 * claims, so the request waits for Swiftline to approve it and only then does
 * an invitation email go out. Without this state the client-side invite would
 * be a way to create portal logins with nobody at Swiftline in the loop.
 */
export const businessAccountMemberStatusValues = [
  "pending_approval",
  "invited",
  "active",
  "suspended",
  "removed",
  /** Swiftline refused the request; kept rather than deleted as a record. */
  "declined"
] as const;

export type BusinessAccountMemberRole = (typeof businessAccountMemberRoleValues)[number];
export type BusinessAccountMemberStatus = (typeof businessAccountMemberStatusValues)[number];

/**
 * Named role groups, so a new role is added in one place.
 *
 * Before these existed the same list- owner, admin, operations- was written
 * out at eleven call sites. Adding `booking_user` and `claims_user` to the
 * enum would have compiled cleanly and left both roles unable to do the one
 * thing each was created for, because no compiler checks a string array.
 */

/** Anyone who may create a shipment, and therefore quote, price and pick up. */
export const shipmentBookingRoles: BusinessAccountMemberRole[] = [
  "account_owner", "account_admin", "operations", "booking_user"
];

/** Anyone who may raise or work a compensation claim. */
export const claimHandlingRoles: BusinessAccountMemberRole[] = [
  "account_owner", "account_admin", "operations", "finance", "claims_user"
];

/** Anyone who may see money: balances, invoices, statements. */
export const financialRoles: BusinessAccountMemberRole[] = [
  "account_owner", "account_admin", "finance"
];

/** Anyone who may administer the account itself, including its people. */
export const accountAdminRoles: BusinessAccountMemberRole[] = [
  "account_owner", "account_admin"
];

export const creditPermissionValues = [
  "requestCredit", "useCreditPayment", "viewCreditBalance", "viewCreditDetails", "makeCreditPayment"
] as const;
export type CreditPermission = (typeof creditPermissionValues)[number];

export interface IBusinessAccountMember extends mongoose.Document, TenantOwnedFields {
  businessAccount: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  role: BusinessAccountMemberRole;
  assignedBranches: mongoose.Types.ObjectId[];
  status: BusinessAccountMemberStatus;
  creditPermissions: CreditPermission[];
  invitedBy: mongoose.Types.ObjectId;
  joinedAt?: Date | null;
  /**
   * Who the account asked Swiftline to give access to.
   *
   * Only set while `status` is `pending_approval`. No user record exists yet-
   * the login is created on approval- so the requested person is described
   * here rather than by a `user` reference, and a declined request therefore
   * leaves no orphan account and reserves no email address.
   */
  requestedInvite?: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const businessAccountMemberSchema = new mongoose.Schema<IBusinessAccountMember>(
  {
    businessAccount: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: businessAccountMemberRoleValues, required: true },
    assignedBranches: [{ type: mongoose.Schema.Types.ObjectId, ref: "Branch" }],
    status: { type: String, enum: businessAccountMemberStatusValues, default: "invited", index: true },
    creditPermissions: [{ type: String, enum: creditPermissionValues }],
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    joinedAt: { type: Date, default: null },
    requestedInvite: {
      type: new mongoose.Schema({
        firstName: { type: String, trim: true, maxlength: 80, required: true },
        lastName: { type: String, trim: true, maxlength: 80, required: true },
        email: { type: String, trim: true, lowercase: true, maxlength: 160, required: true },
        phone: { type: String, trim: true, maxlength: 30, required: true }
      }, { _id: false }),
      default: null
    }
  },
  { timestamps: true }
);

// A portal identity belongs to at most one current business account per
// operating tenant. This lets the same login serve a Swiftline account and an
// operator account without sharing either tenant's account data. Removed
// memberships remain as audit history and can be restored within their tenant.
businessAccountMemberSchema.index(
  { tenantId: 1, user: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["invited", "active", "suspended"] } },
    name: "uniq_current_business_membership_per_tenant_user"
  }
);

addTenantOwnership(businessAccountMemberSchema);

export const BusinessAccountMember = mongoose.model<IBusinessAccountMember>("BusinessAccountMember", businessAccountMemberSchema);
