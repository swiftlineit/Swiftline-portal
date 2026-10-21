import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Tenant, tenantSlugPattern } from "../models/tenant.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";

const reservedSlugs = new Set(["swiftline", "platform"]);

export class TenantRegistryError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export function normalizeTenantSlug(value: string): string {
  const slug = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 63 || !tenantSlugPattern.test(slug)) {
    throw new TenantRegistryError(400, "Choose a URL identifier with 1 to 63 Latin letters, numbers or hyphens.");
  }
  if (reservedSlugs.has(slug)) {
    throw new TenantRegistryError(400, "This URL identifier is reserved.");
  }
  return slug;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export async function createDraftOperator(input: {
  companyName: string;
  slug?: string;
  actorId: mongoose.Types.ObjectId;
}) {
  const companyName = input.companyName.trim();
  if (!companyName || companyName.length > 160) {
    throw new TenantRegistryError(400, "Company name must contain 1 to 160 characters.");
  }
  const slug = normalizeTenantSlug(input.slug?.trim() || companyName);
  const session = await mongoose.startSession();
  try {
    const tenant = await session.withTransaction(async () => {
      const [created] = await Tenant.create([{
        kind: "OPERATOR", status: "DRAFT", companyName, slug, createdBy: input.actorId
      }], { session });
      if (!created) throw new Error("OPERATOR_DRAFT_NOT_CREATED");
      await TenantSlug.create([{ slug, tenantId: created._id, isCurrent: true }], { session });
      await AuditLog.create([{
        action: "OPERATOR_DRAFT_CREATED", entityType: "TENANT", entityId: created._id,
        performedBy: input.actorId, performedAt: new Date(), metadata: { slug, companyName }
      }], { session });
      return created;
    });
    if (!tenant) throw new Error("OPERATOR_DRAFT_NOT_CREATED");
    return tenant;
  } catch (error) {
    if (isDuplicateKey(error)) throw new TenantRegistryError(409, "This URL identifier is already in use.");
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function changeOperatorSlug(input: {
  tenantId: mongoose.Types.ObjectId;
  slug: string;
  actorId: mongoose.Types.ObjectId;
}) {
  const slug = normalizeTenantSlug(input.slug);
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const tenant = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR" }).session(session).exec();
      if (!tenant) throw new TenantRegistryError(404, "Operator not found.");
      if (tenant.slug === slug) return tenant;

      const claimed = await TenantSlug.findOne({ slug }).session(session).exec();
      if (claimed && !claimed.tenantId.equals(tenant._id)) {
        throw new TenantRegistryError(409, "This URL identifier is already in use.");
      }
      const oldSlug = tenant.slug;
      await TenantSlug.updateOne({ tenantId: tenant._id, isCurrent: true }, { $set: { isCurrent: false } }, { session }).exec();
      if (claimed) {
        await TenantSlug.updateOne({ _id: claimed._id }, { $set: { isCurrent: true } }, { session }).exec();
      } else {
        await TenantSlug.create([{ slug, tenantId: tenant._id, isCurrent: true }], { session });
      }
      tenant.slug = slug;
      await tenant.save({ session });
      await AuditLog.create([{
        action: "OPERATOR_SLUG_CHANGED", entityType: "TENANT", entityId: tenant._id,
        performedBy: input.actorId, performedAt: new Date(), metadata: { oldSlug, slug }
      }], { session });
      return tenant;
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new TenantRegistryError(409, "This URL identifier is already in use.");
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function resolveTenantSlug(slug: string) {
  if (!tenantSlugPattern.test(slug)) return null;
  const mapping = await TenantSlug.findOne({ slug }).lean().exec();
  if (!mapping) return null;
  const tenant = await Tenant.findOne({ _id: mapping.tenantId, status: "ACTIVE" }).lean().exec();
  if (!tenant) return null;
  return { tenant, canonicalSlug: tenant.slug, redirect: mapping.slug !== tenant.slug };
}
