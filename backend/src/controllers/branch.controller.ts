import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import {
  Branch,
  branchDocumentTypeValues,
  branchServiceValues,
  branchStatusValues,
  BranchStatus,
  type IBranchImage,
  shipmentCoverageValues,
  workingDayValues
} from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { User } from "../models/user.model.js";
import { branchListScope } from "../middleware/branchAccess.middleware.js";
import { isSupportedDocument, matchesDeclaredType } from "../services/storage/fileSignature.js";
import {
  StorageObjectNotFoundError,
  branchKycKey,
  deleteObject,
  putObject,
  streamObjectToResponse
} from "../services/storage/storage.service.js";

const currencyValues = ["INR", "USD", "AED", "GBP", "EUR", "SGD", "CAD", "AUD", "SAR"] as const;

const countryCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Country code must be a two-letter ISO code");
const branchCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, "Branch code must be 3-20 uppercase letters, numbers, or hyphens");
const branchLabelCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,4}$/, "Station code must be 2-4 uppercase letters or numbers");
const gstinSchema = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN");
// An unparseable date is rejected rather than silently stored as "no date".
// Future dates are allowed so a planned branch opening can be recorded.
const openingDateSchema = z.string().trim().optional().nullable().refine(
  (value) => !value || Number.isFinite(new Date(value).getTime()),
  "Enter a valid opening date"
);

const branchAddressSchema = z.object({
  countryCode: countryCodeSchema.optional().or(z.literal("")),
  countryName: z.string().trim().max(80).optional().default(""),
  city: z.string().trim().max(80).optional().default(""),
  stateOrProvince: z.string().trim().max(80).optional().default(""),
  postalCode: z.string().trim().max(20).optional().default(""),
  address: z.string().trim().max(500).optional().default("")
});

const branchContactSchema = z.object({
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Phone must include country code, for example +919876543210").optional().or(z.literal(""))
});

const branchOperationsSchema = z.object({
  supportedServices: z.array(z.enum(branchServiceValues)).default([]),
  shipmentCoverage: z.array(z.enum(shipmentCoverageValues)).default([]),
  operatingCountries: z.array(countryCodeSchema).default([]),
  workingDays: z.array(z.enum(workingDayValues)).default([])
});

const branchPhoneNumberSchema = z.object({
  label: z.string().trim().max(50).default(""),
  number: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Phone must include country code, for example +919876543210").or(z.literal(""))
});

const branchPayloadSchema = z.object({
  name: z.string().trim().min(3).max(100),
  code: branchCodeSchema,
  labelCode: branchLabelCodeSchema.optional().or(z.literal("")),
  openingDate: openingDateSchema,
  description: z.string().trim().max(500).optional().default(""),
  address: branchAddressSchema.optional().default({
    countryCode: "",
    countryName: "",
    city: "",
    stateOrProvince: "",
    postalCode: "",
    address: ""
  }),
  contact: branchContactSchema.default({}),
  operations: branchOperationsSchema.optional().default({
    supportedServices: [],
    shipmentCoverage: [],
    operatingCountries: [],
    workingDays: []
  }),
  baseCurrency: z.enum(currencyValues).optional().or(z.literal("")),
  gstin: gstinSchema.optional().or(z.literal("")),
  invoiceSacCode: z.string().trim().max(12).optional().default(""),
  phoneNumbers: z.array(branchPhoneNumberSchema).max(3).optional().default([]),
  status: z.enum(["DRAFT", "ACTIVE"])
});

type BranchPayload = z.infer<typeof branchPayloadSchema>;

// Updates accept any subset of editable fields and never change status- lifecycle
// transitions go through the dedicated status endpoint. Omitted fields are left
// untouched, so a partial payload can no longer wipe operations arrays.
const branchUpdateSchema = z.object({
  name: z.string().trim().min(3).max(100).optional(),
  code: branchCodeSchema.optional(),
  labelCode: branchLabelCodeSchema.optional().or(z.literal("")),
  openingDate: openingDateSchema,
  description: z.string().trim().max(500).optional(),
  address: branchAddressSchema.optional(),
  contact: branchContactSchema.optional(),
  operations: branchOperationsSchema.optional(),
  baseCurrency: z.enum(currencyValues).optional().or(z.literal("")),
  gstin: gstinSchema.optional().or(z.literal("")),
  invoiceSacCode: z.string().trim().max(12).optional(),
  phoneNumbers: z.array(branchPhoneNumberSchema).max(3).optional()
});

type BranchUpdatePayload = z.infer<typeof branchUpdateSchema>;

const branchStatusUpdateSchema = z.object({ status: z.enum(branchStatusValues) });

// Allowed lifecycle transitions. Re-applying the current status is a no-op; any
// other transition not listed here is rejected with a 409.
export const branchStatusTransitions: Record<BranchStatus, BranchStatus[]> = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["INACTIVE", "SUSPENDED", "CLOSED"],
  INACTIVE: ["ACTIVE", "CLOSED"],
  SUSPENDED: ["ACTIVE", "CLOSED"],
  CLOSED: []
};

// Structural shape shared by a parsed create payload and a stored branch document,
// so active-branch requirements can be validated against either.
type BranchValidationInput = {
  labelCode?: string;
  address?: { countryCode?: string; countryName?: string; city?: string; postalCode?: string; address?: string };
  contact?: { email?: string; phone?: string };
  operations?: {
    supportedServices?: unknown[];
    shipmentCoverage?: unknown[];
    operatingCountries?: unknown[];
    workingDays?: unknown[];
  };
  baseCurrency?: string;
  gstin?: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: number }).code === 11000;
}

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

export function getActiveBranchValidationError(data: BranchValidationInput): string | null {
  const address = data.address ?? {};
  const contact = data.contact ?? {};
  const operations = data.operations ?? {};

  if (!data.labelCode) return "Station code is required";
  if (!/^[A-Z]{3}$/.test(data.labelCode)) return "Station code must be exactly three uppercase letters";
  if (!address.countryCode || !address.countryName) return "Country is required";
  if (!address.city) return "City is required";
  if (!address.postalCode) return "Postal code is required";
  if (!address.address) return "Address is required";
  if (!contact.email) return "Email is required";
  if (!contact.phone) return "Phone is required";
  if (!operations.supportedServices?.length) return "Select at least one supported service";
  if (!operations.shipmentCoverage?.length) return "Select at least one shipment coverage type";
  if (!data.baseCurrency) return "Base currency is required";
  if (!operations.workingDays?.length) return "Select at least one working day";

  // Domestic-only branches infer their operating country from their own address;
  // anything crossing borders must state where it operates.
  const coverage = (operations.shipmentCoverage ?? []) as string[];
  const isDomesticOnly = coverage.length === 1 && coverage[0] === "DOMESTIC";
  if (!isDomesticOnly && !operations.operatingCountries?.length) {
    return "Select at least one operating country for international coverage";
  }

  // Indian branches must carry a GSTIN or downstream invoice generation hard-fails.
  if (address.countryCode === "IN" && !data.gstin) return "GSTIN is required for Indian branches";

  return null;
}

function normalizeBranchPayload(data: BranchPayload, userId: mongoose.Types.ObjectId) {
  const openingDate = data.openingDate ? new Date(data.openingDate) : null;
  const isDomesticOnly = data.operations.shipmentCoverage.length === 1 && data.operations.shipmentCoverage[0] === "DOMESTIC";
  const operatingCountries = data.operations.operatingCountries.length
    ? data.operations.operatingCountries
    : isDomesticOnly && data.address.countryCode
      ? [data.address.countryCode]
      : [];

  // Keep payload assembly explicit so draft-vs-active behavior is easy to audit.
  return {
    name: data.name,
    code: data.code,
    labelCode: data.labelCode || "",
    openingDate: openingDate && Number.isFinite(openingDate.getTime()) ? openingDate : null,
    description: data.description ?? "",
    address: {
      countryCode: data.address.countryCode || "",
      countryName: data.address.countryName || "",
      city: data.address.city || "",
      stateOrProvince: data.address.stateOrProvince || "",
      postalCode: data.address.postalCode || "",
      address: data.address.address || ""
    },
    contact: {
      email: data.contact.email || "",
      phone: data.contact.phone || ""
    },
    operations: {
      supportedServices: data.operations.supportedServices,
      shipmentCoverage: data.operations.shipmentCoverage,
      operatingCountries,
      workingDays: data.operations.workingDays
    },
    baseCurrency: data.baseCurrency || "",
    gstin: data.gstin || "",
    invoiceSacCode: data.invoiceSacCode || "",
    phoneNumbers: data.phoneNumbers ?? [],
    status: data.status as BranchStatus,
    // Creating a branch already active counts as its first activation.
    activatedAt: data.status === "ACTIVE" ? new Date() : null,
    createdBy: userId,
    updatedBy: userId
  };
}

type BranchAuditSnapshot = { name: string; code: string; status: string };

// Fields whose changes are worth recording on a branch update.
const auditedBranchFields = [
  "name",
  "code",
  "labelCode",
  "openingDate",
  "description",
  "address",
  "contact",
  "operations",
  "baseCurrency",
  "gstin",
  "invoiceSacCode",
  "status",
  "phoneNumbers",
  "images",
  "documents"
] as const;

// Compare the tracked fields and return a before/after diff of what actually changed.
function buildBranchDiff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const field of auditedBranchFields) {
    const previousValue = before[field] ?? null;
    const nextValue = after[field] ?? null;

    if (JSON.stringify(previousValue) !== JSON.stringify(nextValue)) {
      changes[field] = { from: previousValue, to: nextValue };
    }
  }

  return changes;
}

// Audit writes must never fail a branch change that already succeeded, so a
// logging error is reported but swallowed.
async function writeBranchAuditLog(
  action: "BRANCH_CREATED" | "BRANCH_DRAFT_CREATED" | "BRANCH_UPDATED" | "BRANCH_STATUS_CHANGED" | "BRANCH_DRAFT_DELETED",
  branchId: mongoose.Types.ObjectId,
  branch: BranchAuditSnapshot,
  userId: mongoose.Types.ObjectId,
  changes?: Record<string, { from: unknown; to: unknown }>
) {
  try {
    await AuditLog.create({
      action,
      entityType: "BRANCH",
      entityId: branchId,
      performedBy: userId,
      performedAt: new Date(),
      metadata: {
        branchName: branch.name,
        branchCode: branch.code,
        status: branch.status,
        ...(changes && Object.keys(changes).length ? { changes } : {})
      }
    });
  } catch (error) {
    console.error("Branch audit log write failed:", error);
  }
}

// Everything that still points at a branch and would be orphaned if it left service.
async function countBranchDependents(branchId: mongoose.Types.ObjectId) {
  const [businessAccounts, members, users, openManifests] = await Promise.all([
    BusinessAccount.countDocuments({ assignedBranch: branchId }).exec(),
    BusinessAccountMember.countDocuments({ assignedBranches: branchId, status: { $ne: "removed" } }).exec(),
    User.countDocuments({ assignedBranches: branchId }).exec(),
    OperationsManifest.countDocuments({ branchId, status: { $nin: ["DISPATCHED", "CANCELLED"] } }).exec()
  ]);

  return { businessAccounts, members, users, openManifests };
}

function describeBranchDependents(dependents: Awaited<ReturnType<typeof countBranchDependents>>) {
  const parts: string[] = [];

  if (dependents.businessAccounts) parts.push(`${dependents.businessAccounts} business account(s)`);
  if (dependents.users) parts.push(`${dependents.users} user(s)`);
  if (dependents.members) parts.push(`${dependents.members} client member(s)`);
  if (dependents.openManifests) parts.push(`${dependents.openManifests} open manifest(s)`);

  return parts.join(", ");
}

// Build a partial update containing only the provided fields, so omitted fields
// are left untouched instead of being reset to schema defaults.
function buildBranchUpdate(data: BranchUpdatePayload, userId: mongoose.Types.ObjectId) {
  const update: Record<string, unknown> = { updatedBy: userId };

  if (data.name !== undefined) update.name = data.name;
  if (data.code !== undefined) update.code = data.code;
  if (data.labelCode !== undefined) update.labelCode = data.labelCode || "";
  if (data.openingDate !== undefined) {
    const openingDate = data.openingDate ? new Date(data.openingDate) : null;
    update.openingDate = openingDate && Number.isFinite(openingDate.getTime()) ? openingDate : null;
  }
  if (data.description !== undefined) update.description = data.description ?? "";
  if (data.address !== undefined) {
    update.address = {
      countryCode: data.address.countryCode || "",
      countryName: data.address.countryName || "",
      city: data.address.city || "",
      stateOrProvince: data.address.stateOrProvince || "",
      postalCode: data.address.postalCode || "",
      address: data.address.address || ""
    };
  }
  if (data.contact !== undefined) {
    update.contact = { email: data.contact.email || "", phone: data.contact.phone || "" };
  }
  if (data.operations !== undefined) {
    const isDomesticOnly = data.operations.shipmentCoverage.length === 1 && data.operations.shipmentCoverage[0] === "DOMESTIC";
    const operatingCountries = data.operations.operatingCountries.length
      ? data.operations.operatingCountries
      : isDomesticOnly && data.address?.countryCode
        ? [data.address.countryCode]
        : [];
    update.operations = {
      supportedServices: data.operations.supportedServices,
      shipmentCoverage: data.operations.shipmentCoverage,
      operatingCountries,
      workingDays: data.operations.workingDays
    };
  }
  if (data.baseCurrency !== undefined) update.baseCurrency = data.baseCurrency || "";
  if (data.gstin !== undefined) update.gstin = data.gstin || "";
  if (data.invoiceSacCode !== undefined) update.invoiceSacCode = data.invoiceSacCode || "";
  if (data.phoneNumbers !== undefined) update.phoneNumbers = data.phoneNumbers;

  return update;
}

export async function validateBranchCode(request: Request, response: Response): Promise<Response> {
  const code = typeof request.query.code === "string" ? request.query.code.trim().toUpperCase() : "";
  const parsed = branchCodeSchema.safeParse(code);

  if (!parsed.success) {
    return response.status(200).json({ success: true, exists: false, valid: false });
  }

  const excludeBranchId = typeof request.query.excludeBranchId === "string" ? request.query.excludeBranchId : "";
  const filters: Record<string, unknown> = { code: parsed.data };

  if (excludeBranchId && mongoose.Types.ObjectId.isValid(excludeBranchId)) {
    filters._id = { $ne: new mongoose.Types.ObjectId(excludeBranchId) };
  }

  const exists = await Branch.exists(filters);
  return response.status(200).json({ success: true, exists: Boolean(exists), valid: true });
}

export async function listBranches(request: Request, response: Response): Promise<Response> {
  const { search, status } = request.query;
  const filters: Record<string, unknown> = { ...branchListScope(request) };

  if (typeof status === "string" && status) filters.status = status;
  if (typeof search === "string" && search.trim()) {
    const pattern = new RegExp(escapeRegExp(search.trim()), "i");
    filters.$or = [{ name: pattern }, { code: pattern }, { "address.city": pattern }, { "contact.email": pattern }];
  }

  const query = Branch.find(filters).sort({ createdAt: -1 });

  // Pagination is opt-in. Without a page we return the full list, which the
  // branch pickers (assign-branch modals) rely on.
  const requestedPage = typeof request.query.page === "string" ? Number.parseInt(request.query.page, 10) : NaN;

  if (Number.isInteger(requestedPage) && requestedPage >= 1) {
    const requestedSize = typeof request.query.pageSize === "string" ? Number.parseInt(request.query.pageSize, 10) : NaN;
    const pageSize = Number.isInteger(requestedSize) ? Math.min(Math.max(requestedSize, 1), 100) : 10;
    const total = await Branch.countDocuments(filters);
    const branches = await query.skip((requestedPage - 1) * pageSize).limit(pageSize).lean().exec();

    return response.status(200).json({ success: true, branches, total, page: requestedPage, pageSize });
  }

  const branches = await query.lean().exec();
  return response.status(200).json({ success: true, branches });
}

export async function createBranch(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = branchPayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const activeValidationError = parsed.data.status === "ACTIVE" ? getActiveBranchValidationError(parsed.data) : null;
  if (activeValidationError) return response.status(400).json({ success: false, message: activeValidationError });

  const duplicateCode = await Branch.exists({ code: parsed.data.code });
  if (duplicateCode) return response.status(409).json({ success: false, message: "Branch code already exists" });

  if (parsed.data.labelCode) {
    const duplicateLabel = await Branch.exists({ labelCode: parsed.data.labelCode });
    if (duplicateLabel) return response.status(409).json({ success: false, message: "Station code already exists" });
  }

  try {
    const branch = await Branch.create(normalizeBranchPayload(parsed.data, userId));
    await writeBranchAuditLog(parsed.data.status === "ACTIVE" ? "BRANCH_CREATED" : "BRANCH_DRAFT_CREATED", branch._id as mongoose.Types.ObjectId, parsed.data, userId);
    return response.status(201).json({ success: true, branch });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return response.status(409).json({ success: false, message: "Branch code or station code already exists" });
    }
    throw error;
  }
}

export async function updateBranch(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const parsed = branchUpdateSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const branch = await Branch.findById(branchId).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  // Identity fields are frozen once a branch has been activated, because they are
  // baked into tracking numbers that have already been issued to customers.
  if (branch.activatedAt) {
    if (parsed.data.code && parsed.data.code !== branch.code) {
      return response.status(409).json({ success: false, message: "Branch code cannot be changed after the branch has been activated." });
    }
    if (parsed.data.labelCode && parsed.data.labelCode !== branch.labelCode) {
      return response.status(409).json({ success: false, message: "Station code cannot be changed after the branch has been activated." });
    }
  }

  // Duplicate checks only when a value is provided and actually changes.
  if (parsed.data.code && parsed.data.code !== branch.code) {
    const duplicateCode = await Branch.exists({ code: parsed.data.code, _id: { $ne: branch._id } });
    if (duplicateCode) return response.status(409).json({ success: false, message: "Branch code already exists" });
  }
  if (parsed.data.labelCode && parsed.data.labelCode !== branch.labelCode) {
    const duplicateLabel = await Branch.exists({ labelCode: parsed.data.labelCode, _id: { $ne: branch._id } });
    if (duplicateLabel) return response.status(409).json({ success: false, message: "Station code already exists" });
  }

  const beforeSnapshot = branch.toObject() as unknown as Record<string, unknown>;
  const update = buildBranchUpdate(parsed.data, userId);
  // Merge in memory for the active-branch check only. Persistence uses a
  // targeted $set so legacy embedded entries (e.g. documents stored before
  // storageKey became required) are never revalidated and cannot block
  // unrelated edits. The payload itself was already validated by zod above.
  branch.set(update);

  // An already-active branch must stay operationally valid after the edit.
  if (branch.status === "ACTIVE") {
    const validationError = getActiveBranchValidationError(branch);
    if (validationError) return response.status(400).json({ success: false, message: validationError });
  }

  try {
    await Branch.updateOne({ _id: branch._id }, { $set: update });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return response.status(409).json({ success: false, message: "Branch code or station code already exists" });
    }
    throw error;
  }

  const updated = await Branch.findById(branchId).exec();
  if (!updated) return response.status(404).json({ success: false, message: "Branch not found" });

  const changes = buildBranchDiff(beforeSnapshot, updated.toObject() as unknown as Record<string, unknown>);
  await writeBranchAuditLog("BRANCH_UPDATED", updated._id as mongoose.Types.ObjectId, updated, userId, changes);

  return response.status(200).json({ success: true, branch: updated });
}

export async function updateBranchStatus(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const parsed = branchStatusUpdateSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid branch status" });

  const branch = await Branch.findById(branchId).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  const targetStatus = parsed.data.status;
  const currentStatus = branch.status;

  // Re-applying the current status is a no-op; anything else must be an allowed transition.
  if (targetStatus !== currentStatus && !branchStatusTransitions[currentStatus].includes(targetStatus)) {
    return response.status(409).json({
      success: false,
      message: `Cannot change status from ${currentStatus} to ${targetStatus}.`
    });
  }

  // Activating a branch requires it to meet the full operational requirements.
  if (targetStatus === "ACTIVE") {
    const validationError = getActiveBranchValidationError(branch);
    if (validationError) return response.status(400).json({ success: false, message: validationError });
  }

  // Taking a branch out of service must not orphan anything still pointing at it.
  if (currentStatus === "ACTIVE" && targetStatus !== "ACTIVE") {
    const dependents = await countBranchDependents(branch._id as mongoose.Types.ObjectId);
    const dependentSummary = describeBranchDependents(dependents);

    if (dependentSummary) {
      return response.status(409).json({
        success: false,
        message: `Cannot change status while ${dependentSummary} are still assigned to this branch. Reassign them first.`
      });
    }
  }

  branch.status = targetStatus;
  branch.updatedBy = userId;
  // Record the first activation; this permanently freezes code and labelCode.
  if (targetStatus === "ACTIVE" && !branch.activatedAt) {
    branch.activatedAt = new Date();
  }
  await branch.save();

  await writeBranchAuditLog(
    "BRANCH_STATUS_CHANGED",
    branch._id as mongoose.Types.ObjectId,
    branch,
    userId,
    { status: { from: currentStatus, to: targetStatus } }
  );

  return response.status(200).json({ success: true, branch });
}

export async function getBranch(request: Request, response: Response): Promise<Response> {
  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";

  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const branch = await Branch.findById(branchId).populate("createdBy", "email name").lean().exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  return response.status(200).json({ success: true, branch });
}

export async function uploadBranchImages(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const branch = await Branch.findById(branchId).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  const files = (request.files as Record<string, Express.Multer.File[]> | undefined)?.["images"];
  if (!files || !files.length) {
    return response.status(400).json({ success: false, message: "No images provided." });
  }

  const invalid = files.find((file) => !matchesDeclaredType(file.buffer, file.mimetype));
  if (invalid) {
    return response.status(400).json({ success: false, message: `"${invalid.originalname}" is not a valid image.` });
  }

  const stored: IBranchImage[] = [];
  for (const file of files) {
    const storageKey = branchKycKey(branchId, file.originalname);
    await putObject({
      key: storageKey,
      body: file.buffer,
      contentType: file.mimetype,
      originalName: file.originalname
    });
    stored.push({
      storageKey,
      fileName: file.originalname,
      mimeType: file.mimetype,
      uploadedAt: new Date()
    });
  }

  branch.images = [...branch.images, ...stored];
  branch.updatedBy = userId;
  await branch.save();

  return response.status(200).json({ success: true, branch });
}

/**
 * Streams one branch photo.
 *
 * Scoped to a branch and an index rather than taking a storage key, because an
 * endpoint that accepted any key would let any authenticated staff member read
 * any document in the bucket- which is exactly what the old static mount over
 * `private_uploads` did.
 */
export async function viewBranchImage(request: Request, response: Response): Promise<Response | void> {
  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const imageIndex = Number.parseInt(String(request.params.imageIndex), 10);
  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    return response.status(400).json({ success: false, message: "Invalid image index." });
  }

  const branch = await Branch.findById(branchId).select("images").lean().exec();
  const image = branch?.images?.[imageIndex];
  if (!image) return response.status(404).json({ success: false, message: "Image not found at this index." });

  try {
    return await streamObjectToResponse({
      response,
      key: image.storageKey,
      contentType: image.mimeType || "application/octet-stream",
      filename: image.fileName || "branch-image",
      disposition: "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "Image file is no longer available." });
    }
    throw error;
  }
}

/** Streams one branch document. `?download=1` sends it as an attachment. */
export async function viewBranchDocument(request: Request, response: Response): Promise<Response | void> {
  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const docIndex = Number.parseInt(String(request.params.docIndex), 10);
  if (!Number.isInteger(docIndex) || docIndex < 0) {
    return response.status(400).json({ success: false, message: "Invalid document index." });
  }

  const branch = await Branch.findById(branchId).select("documents").lean().exec();
  const document = branch?.documents?.[docIndex];
  if (!document) return response.status(404).json({ success: false, message: "Document not found at this index." });
  // Legacy entries stored before storageKey became required have no file to fetch.
  if (!document.storageKey) {
    return response.status(404).json({ success: false, message: "Document file is no longer available." });
  }

  try {
    return await streamObjectToResponse({
      response,
      key: document.storageKey,
      contentType: document.mimeType || "application/octet-stream",
      filename: document.fileName || "branch-document",
      disposition: request.query.download === "1" ? "attachment" : "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "Document file is no longer available." });
    }
    throw error;
  }
}

export async function deleteBranchImage(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const imageIndexStr = request.params.imageIndex;
  if (typeof imageIndexStr !== "string") return response.status(400).json({ success: false, message: "Invalid image index." });
  const imageIndex = Number.parseInt(imageIndexStr, 10);
  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    return response.status(400).json({ success: false, message: "Invalid image index." });
  }

  const branch = await Branch.findById(branchId).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  if (imageIndex >= branch.images.length) {
    return response.status(404).json({ success: false, message: "Image not found at this index." });
  }

  const removedKey = branch.images[imageIndex]?.storageKey;
  branch.images.splice(imageIndex, 1);
  branch.updatedBy = userId;
  await branch.save();

  // After the save, so a failed delete leaves an orphan rather than a branch
  // still listing an image nobody can load. Failure is non-blocking either way.
  if (removedKey) void deleteObject(removedKey).catch(() => undefined);

  return response.status(200).json({ success: true, branch });
}

export async function uploadBranchDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const branch = await Branch.findById(branchId).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  const docType = typeof request.body.type === "string" ? request.body.type : "";
  if (!branchDocumentTypeValues.includes(docType as typeof branchDocumentTypeValues[number])) {
    return response.status(400).json({ success: false, message: "Document type must be PAN, GST, or OTHER." });
  }

  const title = typeof request.body.title === "string" ? request.body.title.trim() : "";

  const files = (request.files as Record<string, Express.Multer.File[]> | undefined)?.["document"];
  const uploadedFile = files?.[0];
  if (!uploadedFile) {
    return response.status(400).json({ success: false, message: "No document file provided." });
  }

  if (!isSupportedDocument(uploadedFile.buffer)) {
    return response.status(400).json({ success: false, message: "The document is not a valid PDF, JPG, or PNG file." });
  }

  // Replace existing document of the same type (PAN/GST) or append.
  const existingIndex = docType !== "OTHER"
    ? branch.documents.findIndex((doc) => doc.type === docType)
    : -1;

  const storageKey = branchKycKey(branchId, uploadedFile.originalname);
  await putObject({
    key: storageKey,
    body: uploadedFile.buffer,
    contentType: uploadedFile.mimetype,
    originalName: uploadedFile.originalname
  });

  const docEntry = {
    type: docType as "PAN" | "GST" | "OTHER",
    title: docType === "OTHER" ? title : docType,
    fileName: uploadedFile.originalname,
    storageKey,
    mimeType: uploadedFile.mimetype,
    uploadedAt: new Date()
  };

  const supersededKey = existingIndex >= 0 ? branch.documents[existingIndex]?.storageKey : undefined;
  // Persist with a targeted $set so legacy entries missing a storageKey never
  // revalidate and block the upload. The new entry always carries its key.
  const currentDocuments = (branch.toObject() as unknown as { documents: Array<Record<string, unknown>> }).documents ?? [];
  const nextDocuments = existingIndex >= 0
    ? currentDocuments.map((doc, index) => (index === existingIndex ? { ...docEntry } : doc))
    : [...currentDocuments, { ...docEntry }];
  await Branch.updateOne({ _id: branch._id }, { $set: { documents: nextDocuments, updatedBy: userId } });

  if (supersededKey) void deleteObject(supersededKey).catch(() => undefined);

  const updated = await Branch.findById(branchId).exec();
  return response.status(200).json({ success: true, branch: updated });
}

export async function deleteBranchDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = typeof request.params.branchId === "string" ? request.params.branchId : "";
  if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const docIndexStr = request.params.docIndex;
  if (typeof docIndexStr !== "string") return response.status(400).json({ success: false, message: "Invalid document index." });
  const docIndex = Number.parseInt(docIndexStr, 10);
  if (!Number.isInteger(docIndex) || docIndex < 0) {
    return response.status(400).json({ success: false, message: "Invalid document index." });
  }

  const branch = await Branch.findById(branchId).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  if (docIndex >= branch.documents.length || !branch.documents[docIndex]) {
    return response.status(404).json({ success: false, message: "Document not found at this index." });
  }

  const removedKey = branch.documents[docIndex]?.storageKey;
  // Targeted $set: removing one entry must not revalidate the entries left
  // behind, which may predate the required storageKey.
  const nextDocuments = (branch.toObject() as unknown as { documents: unknown[] }).documents
    .filter((_, index) => index !== docIndex);
  await Branch.updateOne({ _id: branch._id }, { $set: { documents: nextDocuments, updatedBy: userId } });

  if (removedKey) void deleteObject(removedKey).catch(() => undefined);

  const updated = await Branch.findById(branchId).exec();
  return response.status(200).json({ success: true, branch: updated });
}

/**
 * Removes a branch that never went live.
 *
 * Hard delete, unlike shipment drafts: a DRAFT branch has never been activated,
 * so nothing can legitimately reference it, and the dependency check below
 * refuses the delete outright if anything does. There is no history worth
 * keeping on a branch that never operated.
 */
export async function deleteBranchDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = String(request.params.branchId ?? "");
  if (!mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(404).json({ success: false, message: "Branch not found" });
  }

  const branch = await Branch.findById(branchId).exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  if (branch.status !== "DRAFT") {
    return response.status(409).json({
      success: false,
      message: "Only draft branches can be deleted. Set this branch to inactive or closed instead."
    });
  }

  const dependents = await countBranchDependents(branch._id as mongoose.Types.ObjectId);
  const dependentSummary = describeBranchDependents(dependents);
  if (dependentSummary) {
    return response.status(409).json({
      success: false,
      message: `This branch is still referenced by ${dependentSummary}. Reassign them before deleting it.`
    });
  }

  await writeBranchAuditLog(
    "BRANCH_DRAFT_DELETED",
    branch._id as mongoose.Types.ObjectId,
    { name: branch.name, code: branch.code, status: branch.status },
    userId
  );
  await branch.deleteOne();

  return response.status(200).json({ success: true, message: "Branch draft deleted." });
}
