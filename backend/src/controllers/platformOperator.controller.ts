import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { env } from "../config/env.js";
import { sendOperatorInvitationEmail } from "../services/mail.service.js";
import { inviteInitialOperatorAdmin, OperatorInvitationError, reissueInitialOperatorAdminLink } from "../services/operatorInvitation.service.js";
import { activateOperatorTenant, changeOperatorSlug, changeOperatorStatus, createDraftOperator, TenantRegistryError } from "../services/tenantRegistry.service.js";

const createSchema = z.object({
  companyName: z.string().trim().min(1).max(160),
  slug: z.string().trim().min(1).max(63).optional()
}).strict();
const updateSlugSchema = z.object({ slug: z.string().trim().min(1).max(63) }).strict();
const updateStatusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
  reason: z.string().trim().min(3).max(500)
}).strict();
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
}).strict();
const initialAdminSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(320).toLowerCase()
}).strict();

function actorId(request: Request): mongoose.Types.ObjectId | null {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function serializeOperator(tenant: { _id: unknown; companyName: string; slug: string; status: string; createdAt: Date }) {
  return {
    id: String(tenant._id), companyName: tenant.companyName, slug: tenant.slug,
    status: tenant.status, createdAt: tenant.createdAt
  };
}

function sendRegistryError(response: Response, error: unknown): Response {
  if (error instanceof TenantRegistryError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error instanceof OperatorInvitationError) {
    return response.status(error.statusCode).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }
  throw error;
}

function tenantIdFromRequest(request: Request): mongoose.Types.ObjectId | null {
  const value = typeof request.params.tenantId === "string" ? request.params.tenantId : "";
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

export async function listDraftOperators(request: Request, response: Response) {
  const parsed = pageSchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid pagination." });
  const { page, limit } = parsed.data;
  const [operators, total] = await Promise.all([
    Tenant.find({ kind: "OPERATOR" }).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).lean().exec(),
    Tenant.countDocuments({ kind: "OPERATOR" }).exec()
  ]);
  const operatorIds = operators.map((operator) => operator._id);
  const memberships = operatorIds.length
    ? await TenantMembership.find({
      tenantId: { $in: operatorIds },
      role: "OPERATOR_ADMIN",
      status: { $in: ["INVITED", "ACTIVE", "SUSPENDED"] }
    }).select("tenantId userId status createdAt").sort({ createdAt: 1 }).lean().exec()
    : [];
  const userIds = memberships.map((membership) => membership.userId);
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
      .select("firstName lastName name email userStatus").lean().exec()
    : [];
  const usersById = new Map(users.map((user) => [String(user._id), user]));
  const administratorsByTenant = new Map<string, Array<{
    userId: string;
    firstName: string;
    lastName: string;
    name: string;
    email: string;
    status: string;
    requiresSignIn: boolean;
  }>>();

  for (const membership of memberships) {
    const user = usersById.get(String(membership.userId));
    if (!user) continue;
    const tenantKey = String(membership.tenantId);
    const administrators = administratorsByTenant.get(tenantKey) ?? [];
    administrators.push({
      userId: String(user._id),
      firstName: user.firstName ?? "",
      lastName: user.lastName ?? "",
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      email: user.email,
      status: membership.status,
      requiresSignIn: user.userStatus === "active"
    });
    administratorsByTenant.set(tenantKey, administrators);
  }

  return response.json({
    success: true,
    operators: operators.map((operator) => ({
      ...serializeOperator(operator),
      administrators: administratorsByTenant.get(String(operator._id)) ?? []
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
}

export async function createOperatorDraft(request: Request, response: Response) {
  const actor = actorId(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = createSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid operator details." });
  try {
    const tenant = await createDraftOperator({ ...parsed.data, actorId: actor });
    return response.status(201).json({ success: true, operator: serializeOperator(tenant) });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}

export async function createOperatorAdminInvitation(request: Request, response: Response) {
  const actor = actorId(request);
  const tenantId = tenantIdFromRequest(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!tenantId) return response.status(404).json({ success: false, message: "Operator not found." });
  const parsed = initialAdminSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Enter a valid administrator name and email." });

  try {
    const invitation = await inviteInitialOperatorAdmin({ tenantId, actorId: actor, ...parsed.data });
    let emailSent = false;
    let emailSkipped = false;
    let emailFailed = false;
    try {
      const delivery = await sendOperatorInvitationEmail({
        to: invitation.email,
        name: invitation.name,
        companyName: invitation.companyName,
        activationUrl: invitation.activationUrl,
        expiresAt: invitation.expiresAt
      });
      emailSent = delivery.sent;
      emailSkipped = delivery.skipped;
    } catch (error) {
      // The membership remains pending so the platform admin can issue a fresh
      // copy link explicitly; a delivery failure must not roll back access setup.
      console.error("Operator administrator invitation email could not be delivered.", error);
      emailFailed = true;
    }

    return response.status(201).json({
      success: true,
      administrator: {
        userId: String(invitation.userId),
        email: invitation.email,
        role: "OPERATOR_ADMIN",
        status: "INVITED",
        requiresSignIn: invitation.requiresSignIn
      },
      expiresAt: invitation.expiresAt,
      emailSent,
      emailSkipped,
      emailFailed
    });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}

export async function createOperatorAdminInvitationLink(request: Request, response: Response) {
  const actor = actorId(request);
  const tenantId = tenantIdFromRequest(request);
  const userIdValue = typeof request.params.userId === "string" ? request.params.userId : "";
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!tenantId || !mongoose.Types.ObjectId.isValid(userIdValue)) {
    return response.status(404).json({ success: false, message: "Pending operator administrator invitation not found." });
  }
  try {
    const invitation = await reissueInitialOperatorAdminLink({
      tenantId,
      userId: new mongoose.Types.ObjectId(userIdValue),
      actorId: actor
    });
    return response.json({
      success: true,
      activationUrl: invitation.activationUrl,
      expiresAt: invitation.expiresAt
    });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}

export async function updateOperatorSlug(request: Request, response: Response) {
  const actor = actorId(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  const tenantId = typeof request.params.tenantId === "string" ? request.params.tenantId : "";
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    return response.status(404).json({ success: false, message: "Operator not found." });
  }
  const parsed = updateSlugSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid URL identifier." });
  try {
    const tenant = await changeOperatorSlug({
      tenantId: new mongoose.Types.ObjectId(tenantId), slug: parsed.data.slug, actorId: actor
    });
    return response.json({ success: true, operator: serializeOperator(tenant) });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}

export async function activateOperatorPortal(request: Request, response: Response) {
  const actor = actorId(request);
  const tenantId = tenantIdFromRequest(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!tenantId) return response.status(404).json({ success: false, message: "Operator not found." });
  if (!env.OPERATOR_PORTAL_ENABLED) {
    return response.status(409).json({ success: false, message: "Enable the operator portal feature before activating an operator." });
  }
  try {
    const tenant = await activateOperatorTenant({ tenantId, actorId: actor });
    return response.json({ success: true, operator: serializeOperator(tenant) });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}

export async function updateOperatorStatus(request: Request, response: Response) {
  const actor = actorId(request);
  const tenantId = tenantIdFromRequest(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!tenantId) return response.status(404).json({ success: false, message: "Operator not found." });
  const parsed = updateStatusSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Choose a status and enter a reason of at least 3 characters." });
  try {
    const tenant = await changeOperatorStatus({ tenantId, actorId: actor, ...parsed.data });
    return response.json({ success: true, operator: serializeOperator(tenant) });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}
