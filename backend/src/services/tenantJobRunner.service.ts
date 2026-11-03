import mongoose from "mongoose";
import { Tenant, type TenantKind, type TenantStatus } from "../models/tenant.model.js";
import { runWithTenantContext } from "./tenantScope.service.js";

export type TenantJobTarget = {
  tenantId: mongoose.Types.ObjectId;
  kind: TenantKind;
  slug: string;
};

export type TenantJobSummary = {
  total: number;
  succeeded: string[];
  failed: string[];
};

/**
 * Lists operational tenants for scheduled work. Suspended operators remain in
 * financial maintenance so reservations and account state do not go stale.
 * Draft operators are excluded because they cannot have operational data.
 */
export async function listOperationalTenantTargets(): Promise<TenantJobTarget[]> {
  const tenants = await Tenant.find({ status: { $in: ["ACTIVE", "SUSPENDED"] satisfies TenantStatus[] } })
    .select("_id kind slug status")
    .sort({ kind: 1, slug: 1 })
    .lean()
    .exec();

  const swiftlineTenants = tenants.filter((tenant) => tenant.kind === "SWIFTLINE");
  if (swiftlineTenants.length !== 1 || swiftlineTenants[0]?.status !== "ACTIVE") {
    throw new Error("Tenant job runner requires exactly one active Swiftline tenant.");
  }

  return tenants.map((tenant) => ({
    tenantId: tenant._id as mongoose.Types.ObjectId,
    kind: tenant.kind as TenantKind,
    slug: tenant.slug
  }));
}

/** Runs tenant work sequentially, with a fresh explicit data scope per tenant. */
export async function runTenantJob<T>(
  jobName: string,
  targets: readonly TenantJobTarget[],
  work: (target: TenantJobTarget) => Promise<T>
): Promise<TenantJobSummary> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const target of targets) {
    try {
      await runWithTenantContext(
        { tenantId: target.tenantId, kind: target.kind },
        () => work(target)
      );
      succeeded.push(target.slug);
    } catch (error) {
      failed.push(target.slug);
      console.error(`${jobName} failed for tenant ${target.slug}.`, error);
    }
  }

  return { total: targets.length, succeeded, failed };
}

export async function runOperationalTenantJob<T>(
  jobName: string,
  work: (target: TenantJobTarget) => Promise<T>
) {
  const targets = await listOperationalTenantTargets();
  return runTenantJob(jobName, targets, work);
}
