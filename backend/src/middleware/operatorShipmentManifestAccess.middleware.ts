import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { getOperatorContext, type OperatorContext } from "./operatorContext.middleware.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";

export type OperatorManifestAction = "read" | "createAccount" | "createCombined" | "delete";

export function operatorManifestActionAllowed(
  role: OperatorContext["role"],
  action: OperatorManifestAction
): boolean {
  if (action === "read") return true;
  if (action === "createAccount") {
    return role === "OPERATOR_ADMIN" || role === "OPERATIONS" || role === "CLIENT";
  }
  return role === "OPERATOR_ADMIN" || role === "OPERATIONS";
}

export function operatorManifestBranchAllowed(
  context: Pick<OperatorContext, "role" | "assignedBranches">,
  branchId: unknown
): boolean {
  return context.role === "OPERATOR_ADMIN"
    || context.assignedBranches.some((assignedBranch) => String(assignedBranch) === String(branchId));
}

export function buildOperatorManifestFilter(
  context: Pick<OperatorContext, "tenantId">,
  manifestId: mongoose.Types.ObjectId
) {
  return { _id: manifestId, tenantId: context.tenantId };
}

export function buildOperatorManifestDraftFilter(
  context: Pick<OperatorContext, "tenantId">,
  draftIds: mongoose.Types.ObjectId[]
) {
  return { _id: { $in: draftIds }, tenantId: context.tenantId };
}

function objectIdList(value: unknown, max: number): mongoose.Types.ObjectId[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  if (value.some((item) => typeof item !== "string" || !mongoose.Types.ObjectId.isValid(item))) return null;
  return [...new Set(value as string[])].map((id) => new mongoose.Types.ObjectId(id));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function draftIdsFromBody(body: unknown): mongoose.Types.ObjectId[] | null {
  const input = record(body);
  if (!input) return null;
  if (Array.isArray(input.shipmentDraftIds)) return objectIdList(input.shipmentDraftIds, 200);

  const lines = input.lines;
  if (typeof input.currentShipmentDraftId === "string" && Array.isArray(lines)) {
    const lineIds = lines.map((line) => record(line)?.shipmentDraftId);
    return objectIdList([input.currentShipmentDraftId, ...lineIds], 200);
  }
  return null;
}

function notFound(response: Response, message: string) {
  return response.status(404).json({ success: false, message });
}

export async function requireOperatorManifestDraftAccess(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const context = getOperatorContext(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!context || !mongoose.Types.ObjectId.isValid(draftId)) {
    return notFound(response, "Shipment not found.");
  }

  const draft = await ShipmentDraft.findOne(buildOperatorManifestDraftFilter(
    context,
    [new mongoose.Types.ObjectId(draftId)]
  )).select("branchId").lean().exec();
  if (!draft || !operatorManifestBranchAllowed(context, draft.branchId)) {
    return notFound(response, "Shipment not found.");
  }
  return next();
}

export async function requireOperatorManifestDraftBranches(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const context = getOperatorContext(request);
  const draftIds = draftIdsFromBody(request.body);
  if (!context || !draftIds) return next();

  const drafts = await ShipmentDraft.find(buildOperatorManifestDraftFilter(context, draftIds))
    .select("branchId")
    .lean()
    .exec();
  if (drafts.length !== draftIds.length || drafts.some((draft) => !operatorManifestBranchAllowed(context, draft.branchId))) {
    return notFound(response, "One or more shipments are not available to this operator user.");
  }
  return next();
}

export async function requireOperatorManifestAccess(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const context = getOperatorContext(request);
  const manifestId = typeof request.params.manifestId === "string" ? request.params.manifestId : "";
  if (!context || !mongoose.Types.ObjectId.isValid(manifestId)) {
    return notFound(response, "Manifest not found.");
  }

  const manifest = await ShipmentManifest.findOne(buildOperatorManifestFilter(
    context,
    new mongoose.Types.ObjectId(manifestId)
  )).select("branchId").lean().exec();
  if (!manifest || !operatorManifestBranchAllowed(context, manifest.branchId)) {
    return notFound(response, "Manifest not found.");
  }
  return next();
}

export async function requireOperatorManifestBulkDeleteAccess(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const context = getOperatorContext(request);
  const input = record(request.body);
  const manifestIds = objectIdList(input?.manifestIds, 100);
  if (!context || !manifestIds) return next();

  const manifests = await ShipmentManifest.find({
    _id: { $in: manifestIds },
    tenantId: context.tenantId
  }).select("branchId").lean().exec();
  if (manifests.length !== manifestIds.length || manifests.some((manifest) => !operatorManifestBranchAllowed(context, manifest.branchId))) {
    return notFound(response, "One or more manifests are not available to this operator user.");
  }
  return next();
}
