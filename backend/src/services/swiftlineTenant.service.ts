import mongoose from "mongoose";
import { Tenant } from "../models/tenant.model.js";

let cachedRoot: { databaseName: string; tenantId: mongoose.Types.ObjectId } | null = null;

/**
 * Returns the active Swiftline tenant for legacy Swiftline-owned create paths.
 * Operator routes must use their authenticated operator context instead.
 */
export async function getSwiftlineTenantId(): Promise<mongoose.Types.ObjectId> {
  const databaseName = mongoose.connection.db?.databaseName;
  if (!databaseName) throw new Error("The database connection is not ready.");
  if (cachedRoot?.databaseName === databaseName) return cachedRoot.tenantId;

  const tenants = await Tenant.find({ kind: "SWIFTLINE" }).select("_id status").limit(2).lean().exec();
  if (tenants.length !== 1 || tenants[0]?.status !== "ACTIVE") {
    throw new Error("The active Swiftline tenant has not been initialized.");
  }
  cachedRoot = { databaseName, tenantId: tenants[0]._id };
  return cachedRoot.tenantId;
}
