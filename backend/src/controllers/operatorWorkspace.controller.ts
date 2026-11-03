import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";

type ClientRequest = Request & { user?: { _id?: unknown; role?: string } };

function getClientUserId(request: ClientRequest): mongoose.Types.ObjectId | null {
  const userId = request.user?._id;
  if (!userId || request.user?.role !== "client" || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
  return new mongoose.Types.ObjectId(String(userId));
}

async function findOperatorWorkspaces(userId: mongoose.Types.ObjectId) {
  const memberships = await TenantMembership.find({ userId, status: "ACTIVE" })
    .select("tenantId role").lean().exec();
  if (!memberships.length) return [];

  const tenants = await Tenant.find({
    _id: { $in: memberships.map((membership) => membership.tenantId) },
    kind: "OPERATOR",
    status: { $in: ["DRAFT", "ACTIVE"] }
  }).select("_id companyName slug status").lean().exec();
  const tenantById = new Map(tenants.map((tenant) => [String(tenant._id), tenant]));
  const workspaces = memberships.flatMap((membership) => {
    const tenant = tenantById.get(String(membership.tenantId));
    return tenant ? [{
      slug: tenant.slug,
      companyName: tenant.companyName,
      status: tenant.status,
      role: membership.role
    }] : [];
  }).sort((left, right) => left.companyName.localeCompare(right.companyName));
  return workspaces;
}

/** Workspaces are discovered from the signed-in identity, never a supplied slug. */
export async function listMyOperatorWorkspaces(request: Request, response: Response): Promise<Response> {
  const userId = getClientUserId(request as ClientRequest);
  if (!userId) {
    return response.status(403).json({ success: false, message: "Client access is required." });
  }

  const workspaces = await findOperatorWorkspaces(userId);

  return response.status(200).json({ success: true, workspaces });
}

/**
 * Returns routing entitlements only. Business account, shipment, invoice, and
 * credit data remain behind their existing tenant-scoped endpoints.
 */
export async function getMyClientWorkspaceAccess(request: Request, response: Response): Promise<Response> {
  const userId = getClientUserId(request as ClientRequest);
  if (!userId) {
    return response.status(403).json({ success: false, message: "Client access is required." });
  }

  const [swiftlineMembership, operatorWorkspaces] = await Promise.all([
    BusinessAccountMember.exists({ user: userId, status: { $in: ["active", "suspended"] } }),
    env.OPERATOR_PORTAL_ENABLED ? findOperatorWorkspaces(userId) : Promise.resolve([])
  ]);

  return response.status(200).json({
    success: true,
    swiftline: Boolean(swiftlineMembership),
    operators: operatorWorkspaces
  });
}
