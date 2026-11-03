import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

/**
 * Records a completed create request so a repeat of the same request returns
 * the original result instead of creating a second record.
 *
 * Covers what a disabled button cannot: a duplicate tab, a retry after a
 * timeout, or a client that never saw the first response.
 */
export interface IIdempotencyKey extends mongoose.Document, TenantOwnedFields {
  key: string;
  scope: string;
  userId: mongoose.Types.ObjectId;
  entityId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const idempotencyKeySchema = new mongoose.Schema<IIdempotencyKey>({
  // Scoped by user as well as key so one client's key can never return another
  // client's record.
  key: { type: String, required: true, trim: true },
  scope: { type: String, required: true, trim: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Long enough to cover a retry or a stranded tab, short enough that the
  // collection does not grow without bound.
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 }
});

// The uniqueness is the mechanism: a concurrent duplicate loses the insert race
// and is served the winner's record.
idempotencyKeySchema.index(
  { tenantId: 1, scope: 1, userId: 1, key: 1 },
  { unique: true, name: "tenant_scope_user_key_unique" }
);

addTenantOwnership(idempotencyKeySchema);

export const IdempotencyKey = mongoose.model<IIdempotencyKey>("IdempotencyKey", idempotencyKeySchema);
