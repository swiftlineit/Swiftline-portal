import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { Tenant } from "../models/tenant.model.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import {
  isOperatorBrandBannerStorageKey,
  isOperatorBrandLogoStorageKey,
  isRenderableOperatorBrandLogo,
  operatorBrandBannerStorageKey,
  operatorBrandLogoMaxBytes,
  operatorBrandLogoStorageKey
} from "../services/operatorBranding.service.js";
import {
  assertValidStorageKey,
  deleteObject,
  putObject,
  StorageObjectNotFoundError,
  streamObjectToResponse
} from "../services/storage/storage.service.js";
import {
  changeOperatorCompanyName,
  changeOperatorSlug,
  TenantRegistryError
} from "../services/tenantRegistry.service.js";

const updateSlugSchema = z.object({ slug: z.string().trim().min(1).max(63) }).strict();
const updateCompanyNameSchema = z.object({ companyName: z.string().trim().min(1).max(160) }).strict();
const settingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25)
}).strict();

class OperatorLogoConflictError extends Error {
  constructor() {
    super("The company logo changed in another request. Refresh the page and try again.");
    this.name = "OperatorLogoConflictError";
  }
}

function logoResponse(slug: string, logo?: { mimeType: string; uploadedAt: Date } | null) {
  return logo ? {
    url: `/api/v1/operators/${encodeURIComponent(slug)}/settings/logo`,
    mimeType: logo.mimeType,
    updatedAt: logo.uploadedAt
  } : null;
}

function bannerResponse(slug: string, banner: {
  _id: mongoose.Types.ObjectId;
  mimeType: string;
  uploadedAt: Date;
  heading?: string;
  description?: string;
}) {
  return {
    id: String(banner._id),
    url: `/api/v1/operators/${encodeURIComponent(slug)}/settings/banners/${String(banner._id)}`,
    mimeType: banner.mimeType,
    uploadedAt: banner.uploadedAt,
    heading: banner.heading || "",
    description: banner.description || ""
  };
}

function tenantLogoFilter(tenantId: mongoose.Types.ObjectId, currentStorageKey: string | null) {
  return {
    _id: tenantId,
    kind: "OPERATOR" as const,
    status: "ACTIVE" as const,
    ...(currentStorageKey
      ? { "branding.logo.storageKey": currentStorageKey }
      : { "branding.logo.storageKey": null })
  };
}

async function deleteUploadedLogoIfUnreferenced(tenantId: mongoose.Types.ObjectId, storageKey: string) {
  let lookupSucceeded = false;
  const current = await Tenant.findOne({ _id: tenantId, kind: "OPERATOR" })
    .select("branding.logo.storageKey")
    .lean()
    .exec()
    .then((tenant) => { lookupSucceeded = true; return tenant; })
    .catch(() => null);
  if (lookupSucceeded && current?.branding?.logo?.storageKey !== storageKey) {
    await deleteObject(storageKey).catch(() => undefined);
  }
}

async function deleteLogoWhenNoTaxInvoiceUsesIt(storageKey: string) {
  const references = await ShipmentInvoice.exists({
    $or: [
      { "supplier.operatorLogoStorageKey": storageKey },
      { "revisions.supplier.operatorLogoStorageKey": storageKey }
    ]
  }).exec().catch(() => true);
  if (!references) await deleteObject(storageKey).catch(() => undefined);
}

function actorId(request: Request): mongoose.Types.ObjectId | null {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

export async function getOperatorInvoiceSettings(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = settingsQuerySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid settings pagination." });

  const tenant = await Tenant.findOne({ _id: context.tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("companyName slug branding.logo branding.banners")
    .lean()
    .exec();
  if (!tenant) return response.status(404).json({ success: false, message: "Operator not found." });

  const filter = {
    tenantId: context.tenantId,
    ...(context.role === "OPERATIONS"
      ? { _id: { $in: context.assignedBranches.map((id) => new mongoose.Types.ObjectId(id)) } }
      : {})
  };
  const [total, branches] = await Promise.all([
    Branch.countDocuments(filter).exec(),
    Branch.find(filter)
      .select("name code labelCode openingDate description status address contact operations baseCurrency gstin invoiceSacCode phoneNumbers createdAt")
      .sort({ name: 1, _id: 1 })
      .skip((parsed.data.page - 1) * parsed.data.pageSize)
      .limit(parsed.data.pageSize)
      .lean()
      .exec()
  ]);

  return response.status(200).json({
    success: true,
    operator: {
      id: String(tenant._id),
      slug: tenant.slug,
      companyName: tenant.companyName,
      logo: logoResponse(tenant.slug, tenant.branding?.logo)
    },
    banners: (tenant.branding?.banners ?? []).map((banner) => bannerResponse(tenant.slug, banner)),
    branches: branches.map((branch) => ({
      _id: String(branch._id),
      name: branch.name,
      code: branch.code,
      labelCode: branch.labelCode,
      openingDate: branch.openingDate,
      description: branch.description,
      status: branch.status,
      address: branch.address,
      contact: branch.contact,
      operations: branch.operations,
      gstin: branch.gstin,
      invoiceSacCode: branch.invoiceSacCode,
      baseCurrency: branch.baseCurrency,
      phoneNumbers: branch.phoneNumbers,
      createdAt: branch.createdAt
    })),
    pagination: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      totalPages: Math.ceil(total / parsed.data.pageSize)
    }
  });
}

export async function getOperatorBrandBanner(request: Request, response: Response): Promise<Response | void> {
  const context = getOperatorContext(request);
  const bannerId = typeof request.params.bannerId === "string" ? request.params.bannerId : "";
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!mongoose.Types.ObjectId.isValid(bannerId)) return response.status(404).json({ success: false, message: "Banner not found." });

  const tenant = await Tenant.findOne({ _id: context.tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("branding.banners")
    .lean()
    .exec();
  const banner = tenant?.branding?.banners?.find((item) => String(item._id) === bannerId);
  if (!banner || !["image/jpeg", "image/png"].includes(banner.mimeType)
    || !isOperatorBrandBannerStorageKey(String(context.tenantId), banner.storageKey)) {
    return response.status(404).json({ success: false, message: "Banner image not found." });
  }

  try {
    assertValidStorageKey(banner.storageKey);
    return await streamObjectToResponse({
      response,
      key: banner.storageKey,
      contentType: banner.mimeType,
      filename: banner.mimeType === "image/png" ? "operator-banner.png" : "operator-banner.jpg",
      disposition: "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "Banner image is no longer available." });
    }
    throw error;
  }
}

const operatorBannerLimit = 5;

export async function uploadOperatorBrandBanner(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const file = request.file;
  if (!file) return response.status(400).json({ success: false, message: "Choose a JPG or PNG banner image." });
  if (file.size > operatorBrandLogoMaxBytes || !await isRenderableOperatorBrandLogo(file.buffer, file.mimetype)) {
    return response.status(400).json({ success: false, message: "Choose a valid JPG or PNG banner no larger than 2 MB and 4096 pixels per side." });
  }

  const heading = typeof request.body.heading === "string" ? request.body.heading.trim().slice(0, 100) : "";
  const description = typeof request.body.description === "string" ? request.body.description.trim().slice(0, 240) : "";
  const tenantId = context.tenantId;
  const stored = await putObject({
    key: operatorBrandBannerStorageKey(String(tenantId), file.originalname),
    body: file.buffer,
    contentType: file.mimetype,
    originalName: file.originalname
  });
  const uploadedAt = new Date();
  const bannerId = new mongoose.Types.ObjectId();
  const session = await mongoose.startSession();
  let transactionSucceeded = false;
  try {
    await session.withTransaction(async () => {
      const result = await Tenant.updateOne(
        {
          _id: tenantId,
          kind: "OPERATOR",
          status: "ACTIVE",
          "branding.banners.4": { $exists: false }
        },
        { $push: { "branding.banners": {
          _id: bannerId,
          storageKey: stored.key,
          mimeType: file.mimetype,
          size: file.size,
          uploadedAt,
          heading,
          description
        } }, $inc: { __v: 1 } },
        { runValidators: true, session }
      ).exec();
      if (result.modifiedCount !== 1) throw new Error("The operator banner limit was reached or the workspace is unavailable.");
      await AuditLog.create([{
        action: "OPERATOR_BANNER_CREATED",
        entityType: "TENANT",
        entityId: tenantId,
        performedBy: userId,
        performedAt: uploadedAt,
        metadata: { bannerId: String(bannerId), mimeType: file.mimetype, size: file.size }
      }], { session });
    });
    transactionSucceeded = true;
  } catch (error) {
    if (!transactionSucceeded) {
      const stillReferenced = await Tenant.exists({ _id: tenantId, "branding.banners.storageKey": stored.key }).exec().catch(() => true);
      if (!stillReferenced) await deleteObject(stored.key).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "The banner could not be saved.";
    if (message.includes("banner limit") || message.includes("workspace is unavailable")) {
      return response.status(409).json({ success: false, message });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  const tenant = await Tenant.findById(tenantId).select("slug").lean().exec();
  if (!tenant) return response.status(404).json({ success: false, message: "Operator not found." });
  return response.status(201).json({
    success: true,
    banner: bannerResponse(tenant.slug, { _id: bannerId, mimeType: file.mimetype, uploadedAt, heading, description })
  });
}

export async function removeOperatorBrandBanner(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  const bannerId = typeof request.params.bannerId === "string" ? request.params.bannerId : "";
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!mongoose.Types.ObjectId.isValid(bannerId)) return response.status(404).json({ success: false, message: "Banner not found." });

  const tenantId = context.tenantId;
  const tenant = await Tenant.findOne({ _id: tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("branding.banners")
    .lean()
    .exec();
  const banner = tenant?.branding?.banners?.find((item) => String(item._id) === bannerId);
  if (!banner || !isOperatorBrandBannerStorageKey(String(tenantId), banner.storageKey)) {
    return response.status(404).json({ success: false, message: "Banner not found." });
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const result = await Tenant.updateOne(
        { _id: tenantId, kind: "OPERATOR", status: "ACTIVE", "branding.banners._id": banner._id },
        { $pull: { "branding.banners": { _id: banner._id, storageKey: banner.storageKey } }, $inc: { __v: 1 } },
        { session }
      ).exec();
      if (result.modifiedCount !== 1) throw new OperatorLogoConflictError();
      await AuditLog.create([{
        action: "OPERATOR_BANNER_REMOVED",
        entityType: "TENANT",
        entityId: tenantId,
        performedBy: userId,
        performedAt: new Date(),
        metadata: { bannerId }
      }], { session });
    });
  } catch (error) {
    if (error instanceof OperatorLogoConflictError) {
      return response.status(409).json({ success: false, message: error.message });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  await deleteObject(banner.storageKey).catch(() => undefined);
  return response.status(200).json({ success: true, banner: null });
}

export async function getOperatorCompanyLogo(request: Request, response: Response): Promise<Response | void> {
  const context = getOperatorContext(request);
  if (!context) return response.status(401).json({ success: false, message: "Unauthorized" });

  const tenant = await Tenant.findOne({ _id: context.tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("branding.logo")
    .lean()
    .exec();
  const logo = tenant?.branding?.logo;
  if (!logo
    || (logo.mimeType !== "image/jpeg" && logo.mimeType !== "image/png")
    || !isOperatorBrandLogoStorageKey(String(context.tenantId), logo.storageKey)) {
    return response.status(404).json({ success: false, message: "Company logo not found." });
  }

  try {
    assertValidStorageKey(logo.storageKey);
    return await streamObjectToResponse({
      response,
      key: logo.storageKey,
      contentType: logo.mimeType,
      filename: logo.mimeType === "image/png" ? "company-logo.png" : "company-logo.jpg",
      disposition: "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "Company logo file is no longer available." });
    }
    throw error;
  }
}

export async function updateOperatorCompanyLogo(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const file = request.file;
  if (!file) return response.status(400).json({ success: false, message: "Choose a JPG or PNG logo to upload." });
  if (file.size > operatorBrandLogoMaxBytes) {
    return response.status(400).json({ success: false, message: "Choose a logo no larger than 2 MB." });
  }
  if (!await isRenderableOperatorBrandLogo(file.buffer, file.mimetype)) {
    return response.status(400).json({ success: false, message: "Choose a valid JPG or PNG logo no larger than 2 MB and 4096 pixels per side." });
  }

  const tenantId = context.tenantId;
  const previous = await Tenant.findOne({ _id: tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("slug branding.logo")
    .lean()
    .exec();
  if (!previous) return response.status(404).json({ success: false, message: "Operator not found." });

  const previousKey = previous.branding?.logo?.storageKey ?? null;
  const stored = await putObject({
    key: operatorBrandLogoStorageKey(String(tenantId), file.originalname),
    body: file.buffer,
    contentType: file.mimetype,
    originalName: file.originalname
  });
  const uploadedAt = new Date();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const updated = await Tenant.findOneAndUpdate(
        tenantLogoFilter(tenantId, previousKey) as never,
        { $set: { "branding.logo": {
          storageKey: stored.key,
          mimeType: file.mimetype,
          size: file.size,
          uploadedAt
        } } },
        { new: true, runValidators: true, session }
      ).exec();
      if (!updated) throw new OperatorLogoConflictError();
      await AuditLog.create([{
        action: "OPERATOR_BRANDING_LOGO_UPDATED",
        entityType: "TENANT",
        entityId: tenantId,
        performedBy: userId,
        performedAt: uploadedAt,
        metadata: { replaced: Boolean(previousKey), mimeType: file.mimetype, size: file.size }
      }], { session });
    });
  } catch (error) {
    await deleteUploadedLogoIfUnreferenced(tenantId, stored.key);
    if (error instanceof OperatorLogoConflictError) {
      return response.status(409).json({ success: false, message: error.message });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  if (previousKey && previousKey !== stored.key) await deleteLogoWhenNoTaxInvoiceUsesIt(previousKey);
  return response.status(200).json({
    success: true,
    logo: logoResponse(previous.slug, { mimeType: file.mimetype, uploadedAt })
  });
}

export async function removeOperatorCompanyLogo(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const tenantId = context.tenantId;
  const previous = await Tenant.findOne({ _id: tenantId, kind: "OPERATOR", status: "ACTIVE" })
    .select("branding.logo")
    .lean()
    .exec();
  const previousKey = previous?.branding?.logo?.storageKey;
  if (!previous || !previousKey) return response.status(200).json({ success: true, logo: null });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const result = await Tenant.updateOne(
        tenantLogoFilter(tenantId, previousKey) as never,
        { $unset: { "branding.logo": 1 } },
        { runValidators: true, session }
      ).exec();
      if (result.modifiedCount !== 1) throw new OperatorLogoConflictError();
      await AuditLog.create([{
        action: "OPERATOR_BRANDING_LOGO_REMOVED",
        entityType: "TENANT",
        entityId: tenantId,
        performedBy: userId,
        performedAt: new Date(),
        metadata: { removed: true }
      }], { session });
    });
  } catch (error) {
    if (error instanceof OperatorLogoConflictError) {
      return response.status(409).json({ success: false, message: error.message });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  await deleteLogoWhenNoTaxInvoiceUsesIt(previousKey);
  return response.status(200).json({ success: true, logo: null });
}

export async function updateOperatorCompanyProfile(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = updateCompanyNameSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Enter a company name with 1 to 160 characters." });

  try {
    const tenant = await changeOperatorCompanyName({
      tenantId: context.tenantId,
      companyName: parsed.data.companyName,
      actorId: userId
    });
    return response.status(200).json({
      success: true,
      operator: { id: String(tenant._id), slug: tenant.slug, companyName: tenant.companyName }
    });
  } catch (error) {
    if (error instanceof TenantRegistryError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}

export async function updateOperatorPortalSlug(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = actorId(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = updateSlugSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Enter a valid URL identifier." });
  }

  try {
    const tenant = await changeOperatorSlug({
      tenantId: context.tenantId,
      slug: parsed.data.slug,
      actorId: userId
    });
    return response.status(200).json({
      success: true,
      operator: { id: String(tenant._id), slug: tenant.slug, companyName: tenant.companyName }
    });
  } catch (error) {
    if (error instanceof TenantRegistryError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }
}
