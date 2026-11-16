import type { Request, Response } from "express";
import mongoose from "mongoose";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { availableClientAccountIds } from "../services/businessAccountSuspension.service.js";
import { listClientActivity } from "../services/clientActivity.service.js";

/**
 * Account activity, for the people who own the account.
 *
 * Restricted to owners and admins. The feed names who did what- which
 * shipments a colleague created, which invoices they downloaded- and that is
 * management information, not something every booking user should read about
 * their co-workers.
 */
const activityRoles = ["account_owner", "account_admin"];

export async function getClientActivity(request: Request, response: Response): Promise<Response> {
  const userId = (request as Request & { user?: { _id?: unknown } }).user?._id;
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  const allMemberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount assignedBranches role")
    .lean()
    .exec();
  const availableIds = new Set((await availableClientAccountIds(
    allMemberships.map((item) => item.businessAccount as mongoose.Types.ObjectId)
  )).map(String));
  const memberships = allMemberships.filter((item) => availableIds.has(String(item.businessAccount)));

  const requested = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";
  const membership = requested
    ? memberships.find((item) => String(item.businessAccount) === requested)
    : memberships.find((item) => activityRoles.includes(item.role));

  if (!membership) {
    return response.status(403).json({ success: false, message: "Account activity is available to account owners and administrators." });
  }
  if (!activityRoles.includes(membership.role)) {
    return response.status(403).json({ success: false, message: "Account activity is available to account owners and administrators." });
  }

  const limit = Math.min(200, Math.max(1, Number.parseInt(String(request.query.limit ?? "100"), 10) || 100));

  return response.status(200).json({
    success: true,
    entries: await listClientActivity({
      businessAccountId: membership.businessAccount as mongoose.Types.ObjectId,
      branchIds: (membership.assignedBranches ?? []) as mongoose.Types.ObjectId[],
      limit
    })
  });
}
