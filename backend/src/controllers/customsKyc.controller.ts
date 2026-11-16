import type { Request, Response } from "express";
import mongoose from "mongoose";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { availableClientAccountIds } from "../services/businessAccountSuspension.service.js";
import { buildCustomsKycOverview } from "../services/customsKyc.service.js";

/**
 * Customs and KYC for one of the caller's accounts.
 *
 * The account is chosen from their own memberships, never taken on trust from
 * the query, so a supplied id can only narrow what they may already see.
 */
export async function getClientCustomsKyc(request: Request, response: Response): Promise<Response> {
  const userId = (request as Request & { user?: { _id?: unknown } }).user?._id;
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  const allMemberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount assignedBranches")
    .lean()
    .exec();
  const availableIds = new Set((await availableClientAccountIds(
    allMemberships.map((item) => item.businessAccount as mongoose.Types.ObjectId)
  )).map(String));
  const memberships = allMemberships.filter((item) => availableIds.has(String(item.businessAccount)));
  if (!memberships.length) {
    return response.status(200).json({
      success: true,
      overview: { account: null, shipments: [], summary: { shipmentsNeedingDocuments: 0, shipmentsHeldAtCustoms: 0 } }
    });
  }

  const requested = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";
  const membership = requested
    ? memberships.find((item) => String(item.businessAccount) === requested)
    : memberships[0];
  if (!membership) {
    return response.status(403).json({ success: false, message: "This business account is not available for your login." });
  }

  return response.status(200).json({
    success: true,
    overview: await buildCustomsKycOverview({
      businessAccountId: membership.businessAccount as mongoose.Types.ObjectId,
      branchIds: (membership.assignedBranches ?? []) as mongoose.Types.ObjectId[]
    })
  });
}
