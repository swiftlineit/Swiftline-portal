import { createHmac, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";

export type LabelAccessTenantKind = "SWIFTLINE" | "OPERATOR";

export interface CreateLabelAccessTokenInput {
  dpdShipmentId: string;
  labelId: string;
  userId: string;
  expiresAt: Date;
  tenantId?: mongoose.Types.ObjectId;
  tenantKind?: LabelAccessTenantKind;
  readOnly?: boolean;
  supportSessionId?: mongoose.Types.ObjectId;
}

export interface VerifiedLabelAccessToken {
  dpdShipmentId: string;
  labelId: string;
  userId: mongoose.Types.ObjectId;
  expiresAt: Date;
  tenantId?: mongoose.Types.ObjectId;
  tenantKind?: LabelAccessTenantKind;
  readOnly: boolean;
  supportSessionId?: mongoose.Types.ObjectId;
}

function signPayload(payload: string) {
  return createHmac("sha256", env.JWT_SECRET).update(payload).digest("base64url");
}

export function createLabelAccessToken(input: CreateLabelAccessTokenInput): string {
  const hasTenantId = input.tenantId !== undefined;
  const hasTenantKind = input.tenantKind !== undefined;
  if (hasTenantId !== hasTenantKind) throw new Error("A signed label token must include both tenant id and kind.");
  if (input.readOnly && (!hasTenantId || input.tenantKind !== "OPERATOR" || !input.supportSessionId)) {
    throw new Error("Read-only label access must be bound to an active operator support session.");
  }
  if (input.supportSessionId && !input.readOnly) {
    throw new Error("A support session id can only be included in a read-only label token.");
  }

  const payload = Buffer.from(JSON.stringify({
    dpdShipmentId: input.dpdShipmentId,
    labelId: input.labelId,
    userId: input.userId,
    expiresAt: input.expiresAt.toISOString(),
    ...(hasTenantId ? {
      tenantId: String(input.tenantId),
      tenantKind: input.tenantKind
    } : {}),
    ...(input.readOnly ? {
      readOnly: true,
      supportSessionId: String(input.supportSessionId)
    } : {})
  }), "utf8").toString("base64url");

  return `${payload}.${signPayload(payload)}`;
}

export function verifyLabelAccessToken(token: string): VerifiedLabelAccessToken | null {
  if (token.length === 0 || token.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(signPayload(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      dpdShipmentId?: unknown;
      labelId?: unknown;
      userId?: unknown;
      expiresAt?: unknown;
      tenantId?: unknown;
      tenantKind?: unknown;
      readOnly?: unknown;
      supportSessionId?: unknown;
    };
    const expiresAt = typeof parsed.expiresAt === "string" ? new Date(parsed.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
    if (typeof parsed.dpdShipmentId !== "string" || !mongoose.Types.ObjectId.isValid(parsed.dpdShipmentId)) return null;
    if (typeof parsed.labelId !== "string" || !mongoose.Types.ObjectId.isValid(parsed.labelId)) return null;
    if (typeof parsed.userId !== "string" || !mongoose.Types.ObjectId.isValid(parsed.userId)) return null;

    if (parsed.tenantId !== undefined && typeof parsed.tenantId !== "string") return null;
    if (parsed.tenantKind !== undefined && parsed.tenantKind !== "SWIFTLINE" && parsed.tenantKind !== "OPERATOR") return null;
    const hasTenantId = typeof parsed.tenantId === "string";
    const hasTenantKind = parsed.tenantKind === "SWIFTLINE" || parsed.tenantKind === "OPERATOR";
    if (hasTenantId !== hasTenantKind) return null;
    if (hasTenantId && !mongoose.Types.ObjectId.isValid(parsed.tenantId as string)) return null;
    if (parsed.readOnly !== undefined && typeof parsed.readOnly !== "boolean") return null;
    const readOnly = parsed.readOnly === true;
    if (parsed.supportSessionId !== undefined && typeof parsed.supportSessionId !== "string") return null;
    const hasSupportSessionId = typeof parsed.supportSessionId === "string";
    if (hasSupportSessionId && !mongoose.Types.ObjectId.isValid(parsed.supportSessionId as string)) return null;
    if (readOnly && (!hasTenantId || parsed.tenantKind !== "OPERATOR" || !hasSupportSessionId)) return null;
    if (hasSupportSessionId && !readOnly) return null;

    return {
      dpdShipmentId: parsed.dpdShipmentId,
      labelId: parsed.labelId,
      userId: new mongoose.Types.ObjectId(parsed.userId),
      expiresAt,
      ...(hasTenantId ? {
        tenantId: new mongoose.Types.ObjectId(parsed.tenantId as string),
        tenantKind: parsed.tenantKind as LabelAccessTenantKind
      } : {}),
      readOnly,
      ...(hasSupportSessionId ? { supportSessionId: new mongoose.Types.ObjectId(parsed.supportSessionId as string) } : {})
    };
  } catch {
    return null;
  }
}
