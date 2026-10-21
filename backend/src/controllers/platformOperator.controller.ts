import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Tenant } from "../models/tenant.model.js";
import { changeOperatorSlug, createDraftOperator, TenantRegistryError } from "../services/tenantRegistry.service.js";

const createSchema = z.object({
  companyName: z.string().trim().min(1).max(160),
  slug: z.string().trim().min(1).max(63).optional()
}).strict();
const updateSlugSchema = z.object({ slug: z.string().trim().min(1).max(63) }).strict();
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

function actorId(request: Request): mongoose.Types.ObjectId | null {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function serializeOperator(tenant: { _id: unknown; companyName: string; slug: string; status: string; createdAt: Date }) {
  return {
    id: String(tenant._id), companyName: tenant.companyName, slug: tenant.slug,
    status: tenant.status, createdAt: tenant.createdAt
  };
}

function sendRegistryError(response: Response, error: unknown): Response {
  if (error instanceof TenantRegistryError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

export async function listDraftOperators(request: Request, response: Response) {
  const parsed = pageSchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid pagination." });
  const { page, limit } = parsed.data;
  const [operators, total] = await Promise.all([
    Tenant.find({ kind: "OPERATOR" }).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).lean().exec(),
    Tenant.countDocuments({ kind: "OPERATOR" }).exec()
  ]);
  return response.json({
    success: true, operators: operators.map(serializeOperator),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
}

export async function createOperatorDraft(request: Request, response: Response) {
  const actor = actorId(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = createSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid operator details." });
  try {
    const tenant = await createDraftOperator({ ...parsed.data, actorId: actor });
    return response.status(201).json({ success: true, operator: serializeOperator(tenant) });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}

export async function updateOperatorSlug(request: Request, response: Response) {
  const actor = actorId(request);
  if (!actor) return response.status(401).json({ success: false, message: "Unauthorized" });
  const tenantId = typeof request.params.tenantId === "string" ? request.params.tenantId : "";
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    return response.status(404).json({ success: false, message: "Operator not found." });
  }
  const parsed = updateSlugSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid URL identifier." });
  try {
    const tenant = await changeOperatorSlug({
      tenantId: new mongoose.Types.ObjectId(tenantId), slug: parsed.data.slug, actorId: actor
    });
    return response.json({ success: true, operator: serializeOperator(tenant) });
  } catch (error) {
    return sendRegistryError(response, error);
  }
}
