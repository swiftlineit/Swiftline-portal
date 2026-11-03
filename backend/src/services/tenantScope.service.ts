import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { getSwiftlineTenantId } from "./swiftlineTenant.service.js";

export type TenantContext = {
  tenantId: mongoose.Types.ObjectId;
  kind: "SWIFTLINE" | "OPERATOR";
  /** Platform support sessions can read tenant data but must never change it. */
  readOnly?: boolean;
  supportSessionId?: mongoose.Types.ObjectId;
};

const tenantContextStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantContextStorage.getStore();
}

export function runWithTenantContext<T>(context: TenantContext, callback: () => T): T {
  return tenantContextStorage.run(context, callback);
}

/**
 * Returns the authenticated tenant for tenant-owned record creation. Legacy
 * callers without an established request context keep writing to Swiftline.
 */
export async function getTenantIdForWrite(): Promise<mongoose.Types.ObjectId> {
  return getTenantContext()?.tenantId ?? getSwiftlineTenantId();
}

/**
 * Production legacy work defaults to Swiftline. Operator request handlers must
 * establish an authenticated context before touching tenant-owned models.
 * Local unit tests can continue using isolated databases without a root tenant.
 */
export async function getDataAccessTenantId(): Promise<mongoose.Types.ObjectId | null> {
  const context = getTenantContext();
  if (context) return context.tenantId;
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return null;
  return getSwiftlineTenantId();
}
