import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Tenant, tenantSlugPattern } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { TenantSlug } from "../models/tenantSlug.model.js";
import { OperatorSupportSession } from "../models/operatorSupportSession.model.js";
import { User } from "../models/user.model.js";
import { runWithTenantContext } from "./tenantScope.service.js";

const reservedSlugs = new Set(["swiftline", "platform"]);

export class TenantRegistryError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export function isOperatorReadyForActivation(input: {
  tenantStatus: string;
  administratorMembershipStatus: string;
  administratorRole: string;
  userRole: string;
  userStatus: string;
  hasPassword: boolean;
}) {
  return input.tenantStatus === "DRAFT"
    && input.administratorMembershipStatus === "ACTIVE"
    && input.administratorRole === "OPERATOR_ADMIN"
    && input.userRole === "client"
    && input.userStatus === "active"
    && input.hasPassword;
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

/** Keep an implicit company-name slug in sync while preserving an explicit custom slug. */
export function resolveOperatorSlugForCompanyNameChange(input: {
  oldCompanyName: string;
  currentSlug: string;
  newCompanyName: string;
}): string {
  let oldDefaultSlug: string;
  try {
    oldDefaultSlug = normalizeTenantSlug(input.oldCompanyName);
  } catch {
    return input.currentSlug;
  }
  return input.currentSlug === oldDefaultSlug
    ? normalizeTenantSlug(input.newCompanyName)
    : input.currentSlug;
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

/** Activates operational routes only after the invited administrator has accepted access. */
export async function activateOperatorTenant(input: {
  tenantId: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
}) {
  const session = await mongoose.startSession();
  try {
    const tenant = await session.withTransaction(async () => {
      const operator = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR" }).session(session).exec();
      if (!operator) throw new TenantRegistryError(404, "Operator not found.");
      if (operator.status !== "DRAFT") {
        throw new TenantRegistryError(409, "Only a draft operator can be activated.");
      }

      const administratorMembership = await TenantMembership.findOne({
        tenantId: operator._id,
        role: "OPERATOR_ADMIN",
        status: "ACTIVE"
      }).session(session).sort({ createdAt: 1, _id: 1 }).exec();
      const administrator = administratorMembership
        ? await User.findById(administratorMembership.userId).select("role userStatus passwordHash").session(session).exec()
        : null;

      if (!administratorMembership || !administrator || !isOperatorReadyForActivation({
        tenantStatus: operator.status,
        administratorMembershipStatus: administratorMembership.status,
        administratorRole: administratorMembership.role,
        userRole: administrator.role,
        userStatus: administrator.userStatus,
        hasPassword: Boolean(administrator.passwordHash)
      })) {
        throw new TenantRegistryError(409, "The initial operator administrator must accept the invitation and activate their login first.");
      }

      operator.status = "ACTIVE";
      await operator.save({ session });
      await runWithTenantContext({ tenantId: operator._id as mongoose.Types.ObjectId, kind: "OPERATOR" }, () =>
        AuditLog.create([{
          action: "OPERATOR_TENANT_ACTIVATED",
          entityType: "TENANT",
          entityId: operator._id,
          performedBy: input.actorId,
          performedAt: new Date(),
          metadata: {
            slug: operator.slug,
            previousStatus: "DRAFT",
            status: "ACTIVE",
            administratorUserId: String(administrator._id)
          }
        }], { session })
      );
      return operator;
    });
    if (!tenant) throw new Error("OPERATOR_ACTIVATION_FAILED");
    return tenant;
  } finally {
    await session.endSession();
  }
}

/** Platform control only: pause one live operator without changing its memberships or data. */
export async function changeOperatorStatus(input: {
  tenantId: mongoose.Types.ObjectId;
  status: "ACTIVE" | "SUSPENDED";
  reason: string;
  actorId: mongoose.Types.ObjectId;
}) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new TenantRegistryError(400, "Enter a reason between 3 and 500 characters.");
  }
  const previousStatus = input.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const operator = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR" }).session(session).exec();
      if (!operator) throw new TenantRegistryError(404, "Operator not found.");
      if (operator.status !== previousStatus) {
        throw new TenantRegistryError(409, input.status === "SUSPENDED"
          ? "Only an active operator can be suspended."
          : "Only a suspended operator can be reactivated.");
      }
      const changed = await Tenant.updateOne(
        { _id: operator._id, kind: "OPERATOR", status: previousStatus },
        { $set: { status: input.status } },
        { session }
      ).exec();
      if (changed.modifiedCount !== 1) throw new TenantRegistryError(409, "The operator status changed. Refresh and try again.");

      if (input.status === "SUSPENDED") {
        await OperatorSupportSession.updateMany(
          { operatorTenantId: operator._id, endedAt: null },
          { $set: { endedAt: new Date(), endedBy: input.actorId } },
          { session }
        ).exec();
      }
      await runWithTenantContext({ tenantId: operator._id as mongoose.Types.ObjectId, kind: "OPERATOR" }, () =>
        AuditLog.create([{
          action: input.status === "SUSPENDED" ? "OPERATOR_TENANT_SUSPENDED" : "OPERATOR_TENANT_REACTIVATED",
          entityType: "TENANT",
          entityId: operator._id,
          performedBy: input.actorId,
          performedAt: new Date(),
          metadata: { slug: operator.slug, previousStatus, status: input.status, reason }
        }], { session })
      );
      operator.status = input.status;
      return operator;
    });
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

export async function changeOperatorCompanyName(input: {
  tenantId: mongoose.Types.ObjectId;
  companyName: string;
  actorId: mongoose.Types.ObjectId;
}) {
  const companyName = input.companyName.trim();
  if (!companyName || companyName.length > 160) {
    throw new TenantRegistryError(400, "Company name must contain 1 to 160 characters.");
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const tenant = await Tenant.findOne({ _id: input.tenantId, kind: "OPERATOR" }).session(session).exec();
      if (!tenant) throw new TenantRegistryError(404, "Operator not found.");
      if (tenant.companyName === companyName) return tenant;

      const oldCompanyName = tenant.companyName;
      const oldSlug = tenant.slug;
      const slug = resolveOperatorSlugForCompanyNameChange({
        oldCompanyName,
        currentSlug: oldSlug,
        newCompanyName: companyName
      });

      if (slug !== oldSlug) {
        const claimed = await TenantSlug.findOne({ slug }).session(session).exec();
        if (claimed && !claimed.tenantId.equals(tenant._id)) {
          throw new TenantRegistryError(409, "The company name produces a URL identifier that is already in use. Choose a custom identifier first.");
        }
        await TenantSlug.updateOne(
          { tenantId: tenant._id, isCurrent: true },
          { $set: { isCurrent: false } },
          { session }
        ).exec();
        if (claimed) {
          await TenantSlug.updateOne({ _id: claimed._id }, { $set: { isCurrent: true } }, { session }).exec();
        } else {
          await TenantSlug.create([{ slug, tenantId: tenant._id, isCurrent: true }], { session });
        }
      }

      tenant.companyName = companyName;
      tenant.slug = slug;
      await tenant.save({ session });
      await AuditLog.create([{
        action: "OPERATOR_COMPANY_UPDATED",
        entityType: "TENANT",
        entityId: tenant._id,
        performedBy: input.actorId,
        performedAt: new Date(),
        metadata: { oldCompanyName, companyName, oldSlug, slug }
      }], { session });
      return tenant;
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new TenantRegistryError(409, "The company name produces a URL identifier that is already in use. Choose a custom identifier first.");
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
