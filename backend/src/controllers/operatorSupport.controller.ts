import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { OperatorSupportSession } from "../models/operatorSupportSession.model.js";
import { Tenant } from "../models/tenant.model.js";
import { hashOperatorSupportToken, operatorSupportSessionDurationMs } from "../services/operatorSupportSession.service.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

const supportReasonSchema = z.object({
  reason: z.string().trim().min(10).max(500)
}).strict();

class OperatorSupportRequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function actorId(request: Request): mongoose.Types.ObjectId | null {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function requestTenantId(request: Request): mongoose.Types.ObjectId | null {
  const value = request.params.tenantId;
  return typeof value === "string" && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
}

function requestSupportToken(request: Request): string | null {
  const value = request.headers["x-operator-support-token"];
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function auditSupportSession(
  tenantId: mongoose.Types.ObjectId,
  actorUserId: mongoose.Types.ObjectId,
  supportSessionId: mongoose.Types.ObjectId,
  action: "PLATFORM_OPERATOR_SUPPORT_STARTED" | "PLATFORM_OPERATOR_SUPPORT_ENDED",
  metadata: Record<string, unknown>,
  session: mongoose.ClientSession
) {
  return runWithTenantContext({ tenantId, kind: "OPERATOR" }, () => AuditLog.create([{
    action,
    entityType: "TENANT",
    entityId: tenantId,
    performedBy: actorUserId,
    performedAt: new Date(),
    metadata: { supportSessionId: String(supportSessionId), ...metadata }
  }], { session }));
}

export async function startOperatorSupportSession(request: Request, response: Response) {
  const parsed = supportReasonSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Enter a support reason between 10 and 500 characters." });
  }
  const tenantId = requestTenantId(request);
  const actor = actorId(request);
  if (!tenantId || !actor) return response.status(400).json({ success: false, message: "Invalid operator." });

  const operator = await Tenant.findOne({ _id: tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("companyName slug")
    .lean()
    .exec();
  if (!operator) return response.status(404).json({ success: false, message: "Active operator not found." });

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashOperatorSupportToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + operatorSupportSessionDurationMs);
  const databaseSession = await mongoose.startSession();
  let supportSessionId: mongoose.Types.ObjectId | null = null;
  try {
    await databaseSession.withTransaction(async () => {
      const [supportSession] = await OperatorSupportSession.create([{
        tokenHash,
        operatorTenantId: tenantId,
        actorUserId: actor,
        reason: parsed.data.reason,
        expiresAt,
        createdAt: now
      }], { session: databaseSession });
      if (!supportSession) throw new Error("OPERATOR_SUPPORT_SESSION_NOT_CREATED");
      supportSessionId = supportSession._id;
      await auditSupportSession(tenantId, actor, supportSession._id, "PLATFORM_OPERATOR_SUPPORT_STARTED", {
        reason: parsed.data.reason,
        expiresAt
      }, databaseSession);
    });
  } catch (error) {
    throw error;
  } finally {
    await databaseSession.endSession();
  }

  if (!supportSessionId) throw new Error("OPERATOR_SUPPORT_SESSION_NOT_CREATED");
  return response.status(201).json({
    success: true,
    support: {
      token,
      sessionId: String(supportSessionId),
      tenantId: String(tenantId),
      operatorSlug: operator.slug,
      companyName: operator.companyName,
      reason: parsed.data.reason,
      expiresAt
    }
  });
}

export async function endOperatorSupportSession(request: Request, response: Response) {
  const tenantId = requestTenantId(request);
  const actor = actorId(request);
  const token = requestSupportToken(request);
  if (!tenantId || !actor || !token) {
    return response.status(400).json({ success: false, message: "Invalid support session." });
  }

  const databaseSession = await mongoose.startSession();
  let ended = false;
  try {
    await databaseSession.withTransaction(async () => {
      const supportSession = await OperatorSupportSession.findOneAndUpdate({
        tokenHash: hashOperatorSupportToken(token),
        operatorTenantId: tenantId,
        actorUserId: actor,
        endedAt: null
      }, { $set: { endedAt: new Date(), endedBy: actor } }, { new: true, session: databaseSession }).exec();
      if (!supportSession) throw new OperatorSupportRequestError(404, "Support session was already ended or is unavailable.");
      await auditSupportSession(tenantId, actor, supportSession._id, "PLATFORM_OPERATOR_SUPPORT_ENDED", {}, databaseSession);
      ended = true;
    });
  } catch (error) {
    if (error instanceof OperatorSupportRequestError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  } finally {
    await databaseSession.endSession();
  }

  return ended ? response.json({ success: true }) : response.status(404).json({ success: false, message: "Support session not found." });
}
