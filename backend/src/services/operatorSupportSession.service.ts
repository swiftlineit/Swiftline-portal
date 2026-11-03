import { createHash } from "node:crypto";
import mongoose from "mongoose";

export const operatorSupportSessionDurationMs = 30 * 60 * 1000;

export function hashOperatorSupportToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function activeOperatorSupportSessionFilter(input: {
  token: string;
  tenantId: mongoose.Types.ObjectId;
  actorUserId: mongoose.Types.ObjectId;
  now?: Date;
}) {
  return {
    tokenHash: hashOperatorSupportToken(input.token),
    operatorTenantId: input.tenantId,
    actorUserId: input.actorUserId,
    endedAt: null,
    expiresAt: { $gt: input.now ?? new Date() }
  };
}
