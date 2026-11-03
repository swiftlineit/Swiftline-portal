import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember, businessAccountMemberRoleValues } from "../models/businessAccountMember.model.js";
import { OperatorClientInvitation } from "../models/operatorClientInvitation.model.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import {
  createOperatorClientAccess,
  OperatorClientInvitationError,
  reissueOperatorClientInvitation
} from "../services/operatorClientInvitation.service.js";

const createClientAccessSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().toLowerCase(),
  phone: z.string().trim().min(8).max(30),
  role: z.enum(businessAccountMemberRoleValues),
  assignedBranches: z.array(z.string().trim()).optional().default([]),
  sendInvitationEmail: z.boolean().optional().default(true)
});

function authenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return typeof value === "string" ? value : "";
}

function respondToInvitationError(response: Response, error: unknown) {
  if (error instanceof OperatorClientInvitationError) {
    return response.status(error.statusCode).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }
  throw error;
}

export async function listOperatorBusinessAccountMembers(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  const account = await BusinessAccount.findOne({
    tenantId: context.tenantId,
    accountId: request.params.accountId
  }).select("_id").lean().exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found." });

  const members = await BusinessAccountMember.find({
    tenantId: context.tenantId,
    businessAccount: account._id
  })
    .populate("user", "firstName lastName name email phone userStatus lastLogin")
    .populate("assignedBranches", "name code")
    .sort({ createdAt: -1, _id: -1 })
    .lean()
    .exec();
  const invitations = await OperatorClientInvitation.find({
    tenantId: context.tenantId,
    businessAccountId: account._id,
    status: "PENDING",
    expiresAt: { $gt: new Date() }
  }).select("memberId expiresAt acceptedAt revokedAt").lean().exec();
  const invitationByMember = new Map(invitations.map((invitation) => [String(invitation.memberId), invitation]));

  return response.status(200).json({
    success: true,
    members: members.map((member) => {
      const user = member.user as unknown as {
        _id?: mongoose.Types.ObjectId;
        firstName?: string;
        lastName?: string;
        name?: string;
        email?: string;
        phone?: string;
        userStatus?: string;
        lastLogin?: Date | null;
      } | null;
      const invitation = invitationByMember.get(String(member._id));
      return {
        _id: String(member._id),
        role: member.role,
        status: member.status,
        joinedAt: member.joinedAt ?? null,
        createdAt: member.createdAt,
        user: {
          _id: String(user?._id ?? member.user),
          firstName: user?.firstName ?? "",
          lastName: user?.lastName ?? "",
          name: user?.name ?? "",
          email: user?.email ?? "",
          phone: user?.phone ?? "",
          userStatus: user?.userStatus ?? "invited",
          lastLogin: user?.lastLogin ?? null
        },
        assignedBranches: (member.assignedBranches as unknown as Array<{ _id: mongoose.Types.ObjectId; name: string; code: string }>).map((branch) => ({
          _id: String(branch._id), name: branch.name, code: branch.code
        })),
        invitation: invitation ? {
          expiresAt: invitation.expiresAt,
          acceptedAt: invitation.acceptedAt ?? null,
          revokedAt: invitation.revokedAt ?? null
        } : null
      };
    })
  });
}

export async function createOperatorBusinessAccountClientAccess(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const actorId = authenticatedUserId(request);
  if (!context || !actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = createClientAccessSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.flatten() });

  try {
    const result = await createOperatorClientAccess({
      tenantId: context.tenantId,
      accountId: routeParam(request, "accountId"),
      actorId,
      data: parsed.data
    });
    return response.status(201).json({ success: true, ...result });
  } catch (error) {
    return respondToInvitationError(response, error);
  }
}

async function issueMemberInvitation(request: Request, response: Response, exposeUrl: boolean): Promise<Response> {
  const context = getOperatorContext(request);
  const actorId = authenticatedUserId(request);
  const memberId = routeParam(request, "memberId");
  const accountId = routeParam(request, "accountId");
  if (!context || !actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!mongoose.Types.ObjectId.isValid(memberId)) return response.status(400).json({ success: false, message: "Invalid client access member." });
  try {
    const result = await reissueOperatorClientInvitation({
      tenantId: context.tenantId,
      accountId,
      memberId: new mongoose.Types.ObjectId(memberId),
      actorId,
      exposeUrl
    });
    return response.status(200).json({ success: true, ...result });
  } catch (error) {
    return respondToInvitationError(response, error);
  }
}

export function resendOperatorBusinessAccountInvitation(request: Request, response: Response): Promise<Response> {
  return issueMemberInvitation(request, response, false);
}

export function createOperatorBusinessAccountInvitationLink(request: Request, response: Response): Promise<Response> {
  return issueMemberInvitation(request, response, true);
}
