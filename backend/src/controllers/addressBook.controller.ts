import { shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import path from "node:path";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AddressBookEntry, type IAddressBookEntry } from "../models/addressBookEntry.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import {
  addressBookImportInputSchema,
  addressBookInputSchema,
  postalAddressFields,
  postalAddressFrom,
  serializeAddressBookEntry,
  validateAddressBookPostalAddress
} from "../services/addressBook.service.js";
import {
  buildAddressBookTemplateCsv,
  buildAddressBookTemplateWorkbook,
  parseAddressBookImport
} from "../services/addressBookImport.service.js";
import { maskAadhaarNumber } from "../services/aadhaarValidation.service.js";
import { decryptSecret, encryptSecret } from "../services/credentialEncryption.service.js";

const addressBookRoles = new Set<string>(shipmentBookingRoles);
const objectIdSchema = z.string().trim().refine((value) => mongoose.Types.ObjectId.isValid(value), "Invalid id");
const favouriteSchema = z.object({ isFavourite: z.boolean() });
const importSchema = z.object({
  businessAccountId: objectIdSchema,
  entries: addressBookImportInputSchema
});

function getUserId(request: Request) {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

async function getScope(request: Request, response: Response, businessAccountId: string) {
  const userId = getUserId(request);
  if (!userId) {
    response.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }
  if (!mongoose.Types.ObjectId.isValid(businessAccountId)) {
    response.status(400).json({ success: false, message: "Select a valid business account." });
    return null;
  }
  const membership = await BusinessAccountMember.findOne({
    user: userId,
    businessAccount: new mongoose.Types.ObjectId(businessAccountId),
    status: "active"
  }).select("businessAccount role").lean().exec();
  if (!membership || !addressBookRoles.has(membership.role)) {
    response.status(404).json({ success: false, message: "Address book is not available." });
    return null;
  }
  return { userId, businessAccountId: membership.businessAccount as mongoose.Types.ObjectId };
}

async function getScopedEntry(request: Request, response: Response, includeAadhaar = false) {
  const entryId = String(request.params.entryId ?? "");
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    response.status(404).json({ success: false, message: "Address not found." });
    return null;
  }
  const query = AddressBookEntry.findOne({ _id: entryId, deletedAt: null });
  if (includeAadhaar) query.select("+aadhaarNumberEncrypted");
  const entry = await query.exec();
  if (!entry) {
    response.status(404).json({ success: false, message: "Address not found." });
    return null;
  }
  const scope = await getScope(request, response, String(entry.businessAccountId));
  return scope ? { entry, ...scope } : null;
}

function validationErrors(error: z.ZodError) {
  return error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }));
}

async function audit(action: Parameters<typeof AuditLog.create>[0]["action"], entry: IAddressBookEntry, userId: mongoose.Types.ObjectId, metadata: Record<string, unknown> = {}) {
  await AuditLog.create({
    action,
    entityType: "ADDRESS_BOOK_ENTRY",
    entityId: entry._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { businessAccountId: entry.businessAccountId, type: entry.type, ...metadata }
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fingerprint(value: { type: unknown; contactName: unknown; countryCode: unknown; addressLine1: unknown; townOrCity: unknown; postcode: unknown }) {
  return [value.type, value.contactName, value.countryCode, value.addressLine1, value.townOrCity, value.postcode]
    .map((part) => String(part ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""))
    .join("|");
}

export async function listAddressBookEntries(request: Request, response: Response) {
  const businessAccountId = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";
  const scope = await getScope(request, response, businessAccountId);
  if (!scope) return response;

  const page = Math.max(1, Number(request.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
  const search = typeof request.query.search === "string" ? request.query.search.trim().slice(0, 100) : "";
  const type = request.query.type === "SENDER" || request.query.type === "RECIPIENT" ? request.query.type : "";
  const favourite = request.query.favourite === "true";
  const filter: Record<string, unknown> = {
    businessAccountId: scope.businessAccountId,
    deletedAt: null,
    ...(type ? { type } : {}),
    ...(favourite ? { isFavourite: true } : {})
  };
  if (search) {
    const expression = new RegExp(escapeRegExp(search), "i");
    filter.$or = ["label", "companyName", "contactName", "postcode", "townOrCity", "countryName"]
      .map((field) => ({ [field]: expression }));
  }

  const [entries, total] = await Promise.all([
    AddressBookEntry.find(filter).sort({ isFavourite: -1, updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
    AddressBookEntry.countDocuments(filter).exec()
  ]);
  return response.status(200).json({
    success: true,
    entries: entries.map(serializeAddressBookEntry),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  });
}

export async function getAddressBookEntry(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response);
  if (!scoped) return response;
  return response.status(200).json({ success: true, entry: serializeAddressBookEntry(scoped.entry) });
}

export async function createAddressBookEntry(request: Request, response: Response) {
  const businessAccountId = typeof request.body.businessAccountId === "string" ? request.body.businessAccountId : "";
  const scope = await getScope(request, response, businessAccountId);
  if (!scope) return response;
  const parsed = addressBookInputSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Correct the highlighted address details.", errors: validationErrors(parsed.error) });

  const { aadhaarNumber, ...details } = parsed.data;
  const entry = await AddressBookEntry.create({
    ...details,
    aadhaarNumberEncrypted: aadhaarNumber ? encryptSecret(aadhaarNumber, "taxId") : "",
    aadhaarNumberMasked: aadhaarNumber ? maskAadhaarNumber(aadhaarNumber) : "",
    businessAccountId: scope.businessAccountId,
    validationStatus: "NOT_VALIDATED",
    createdBy: scope.userId,
    updatedBy: scope.userId
  });
  await audit("ADDRESS_BOOK_ENTRY_CREATED", entry, scope.userId);
  return response.status(201).json({ success: true, entry: serializeAddressBookEntry(entry) });
}

export async function updateAddressBookEntry(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response);
  if (!scoped) return response;
  const parsed = addressBookInputSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Correct the highlighted address details.", errors: validationErrors(parsed.error) });

  const { aadhaarNumber, ...details } = parsed.data;
  const postalChanged = postalAddressFields.some((field) => String(scoped.entry[field] ?? "") !== String(details[field] ?? ""));
  scoped.entry.set(details);
  if (details.type !== "SENDER" || aadhaarNumber === "") {
    scoped.entry.aadhaarNumberEncrypted = "";
    scoped.entry.aadhaarNumberMasked = "";
  } else if (aadhaarNumber) {
    scoped.entry.aadhaarNumberEncrypted = encryptSecret(aadhaarNumber, "taxId");
    scoped.entry.aadhaarNumberMasked = maskAadhaarNumber(aadhaarNumber);
  }
  scoped.entry.updatedBy = scoped.userId;
  if (postalChanged) {
    scoped.entry.validationStatus = "NOT_VALIDATED";
    scoped.entry.validationProvider = "";
    scoped.entry.validationMessage = "";
    scoped.entry.suggestedAddress = null;
    scoped.entry.validatedAt = null;
  }
  await scoped.entry.save();
  await audit("ADDRESS_BOOK_ENTRY_UPDATED", scoped.entry, scoped.userId, { postalChanged });
  return response.status(200).json({ success: true, entry: serializeAddressBookEntry(scoped.entry) });
}

export async function deleteAddressBookEntry(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response);
  if (!scoped) return response;
  scoped.entry.deletedAt = new Date();
  scoped.entry.deletedBy = scoped.userId;
  scoped.entry.updatedBy = scoped.userId;
  await scoped.entry.save();
  await audit("ADDRESS_BOOK_ENTRY_DELETED", scoped.entry, scoped.userId);
  return response.status(200).json({ success: true, message: "Address deleted." });
}

export async function setAddressBookFavourite(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response);
  if (!scoped) return response;
  const parsed = favouriteSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Choose whether this address is a favourite." });
  scoped.entry.isFavourite = parsed.data.isFavourite;
  scoped.entry.updatedBy = scoped.userId;
  await scoped.entry.save();
  await audit("ADDRESS_BOOK_ENTRY_FAVOURITE_CHANGED", scoped.entry, scoped.userId, { isFavourite: parsed.data.isFavourite });
  return response.status(200).json({ success: true, entry: serializeAddressBookEntry(scoped.entry) });
}

export async function duplicateAddressBookEntry(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response, true);
  if (!scoped) return response;
  const source = scoped.entry.toObject();
  const entry = await AddressBookEntry.create({
    ...source,
    _id: undefined,
    label: `${scoped.entry.label} Copy`.slice(0, 80),
    isFavourite: false,
    createdBy: scoped.userId,
    updatedBy: scoped.userId,
    deletedAt: null,
    deletedBy: null,
    createdAt: undefined,
    updatedAt: undefined
  });
  await audit("ADDRESS_BOOK_ENTRY_DUPLICATED", entry, scoped.userId, { sourceEntryId: scoped.entry._id });
  return response.status(201).json({ success: true, entry: serializeAddressBookEntry(entry) });
}

export async function revealAddressBookAadhaar(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response, true);
  if (!scoped) return response;
  if (scoped.entry.type !== "SENDER" || !scoped.entry.aadhaarNumberEncrypted) {
    return response.status(404).json({ success: false, message: "No Aadhaar number is saved for this address." });
  }

  const aadhaarNumber = decryptSecret<string>(scoped.entry.aadhaarNumberEncrypted, "taxId");
  await audit("ADDRESS_BOOK_ENTRY_AADHAAR_REVEALED", scoped.entry, scoped.userId);
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ success: true, aadhaarNumber });
}

export async function validateAddressBookEntry(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response);
  if (!scoped) return response;
  try {
    const result = await validateAddressBookPostalAddress(postalAddressFrom(scoped.entry));
    scoped.entry.validationStatus = result.status;
    scoped.entry.validationProvider = result.provider;
    scoped.entry.validationMessage = result.message;
    scoped.entry.suggestedAddress = result.suggestedAddress;
    scoped.entry.validatedAt = result.status === "VALIDATED" ? new Date() : null;
    scoped.entry.updatedBy = scoped.userId;
    await scoped.entry.save();
    await audit("ADDRESS_BOOK_ENTRY_VALIDATED", scoped.entry, scoped.userId, { status: result.status, provider: result.provider });
  } catch (error) {
    scoped.entry.validationStatus = "UNAVAILABLE";
    scoped.entry.validationProvider = "";
    scoped.entry.validationMessage = "Automatic validation is temporarily unavailable. You can confirm the address manually after reviewing it.";
    scoped.entry.suggestedAddress = null;
    scoped.entry.validatedAt = null;
    scoped.entry.updatedBy = scoped.userId;
    await scoped.entry.save();
    await audit("ADDRESS_BOOK_ENTRY_VALIDATED", scoped.entry, scoped.userId, { status: "UNAVAILABLE", providerError: error instanceof Error ? error.name : "unknown" });
  }
  return response.status(200).json({ success: true, entry: serializeAddressBookEntry(scoped.entry) });
}

export async function acceptAddressBookSuggestion(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response);
  if (!scoped) return response;
  const suggestion = scoped.entry.suggestedAddress;
  if (scoped.entry.validationStatus !== "CORRECTION_SUGGESTED" || !suggestion) {
    return response.status(409).json({ success: false, message: "There is no address correction to accept." });
  }
  scoped.entry.set(suggestion);
  scoped.entry.validationStatus = "VALIDATED";
  scoped.entry.validationMessage = "Suggested address accepted.";
  scoped.entry.suggestedAddress = null;
  scoped.entry.validatedAt = new Date();
  scoped.entry.updatedBy = scoped.userId;
  await scoped.entry.save();
  await audit("ADDRESS_BOOK_ENTRY_SUGGESTION_ACCEPTED", scoped.entry, scoped.userId);
  return response.status(200).json({ success: true, entry: serializeAddressBookEntry(scoped.entry) });
}

export async function confirmAddressBookEntry(request: Request, response: Response) {
  const scoped = await getScopedEntry(request, response);
  if (!scoped) return response;
  scoped.entry.validationStatus = "MANUALLY_CONFIRMED";
  scoped.entry.validationProvider = "MANUAL";
  scoped.entry.validationMessage = "Address reviewed and confirmed manually.";
  scoped.entry.suggestedAddress = null;
  scoped.entry.validatedAt = new Date();
  scoped.entry.updatedBy = scoped.userId;
  await scoped.entry.save();
  await audit("ADDRESS_BOOK_ENTRY_MANUALLY_CONFIRMED", scoped.entry, scoped.userId);
  return response.status(200).json({ success: true, entry: serializeAddressBookEntry(scoped.entry) });
}

export async function previewAddressBookImport(request: Request, response: Response) {
  const businessAccountId = typeof request.body.businessAccountId === "string" ? request.body.businessAccountId : "";
  const scope = await getScope(request, response, businessAccountId);
  if (!scope) return response;
  if (!request.file) return response.status(400).json({ success: false, message: "Choose a CSV or Excel address-book file." });
  const extension = path.extname(request.file.originalname).toLowerCase() as ".csv" | ".xlsx";
  try {
    const preview = await parseAddressBookImport(request.file.buffer, extension);
    const existing = await AddressBookEntry.find({ businessAccountId: scope.businessAccountId, deletedAt: null })
      .select("type contactName countryCode addressLine1 townOrCity postcode").lean().exec();
    const fingerprints = new Set(existing.map(fingerprint));
    return response.status(200).json({
      success: true,
      filename: request.file.originalname,
      errors: preview.errors,
      rows: preview.rows.map((row) => ({
        ...row,
        warnings: row.data && fingerprints.has(fingerprint(row.data)) ? ["A matching saved address already exists."] : []
      })),
      summary: {
        total: preview.rows.length,
        valid: preview.rows.filter((row) => row.data).length,
        invalid: preview.rows.filter((row) => !row.data).length
      }
    });
  } catch {
    return response.status(400).json({ success: false, message: "The file could not be read. Download and use the Swiftline address-book template." });
  }
}

export async function importAddressBookEntries(request: Request, response: Response) {
  const parsed = importSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "The address import contains invalid rows.", errors: validationErrors(parsed.error) });
  const scope = await getScope(request, response, parsed.data.businessAccountId);
  if (!scope) return response;
  const entries = await AddressBookEntry.insertMany(parsed.data.entries.map((entry) => {
    const { aadhaarNumber, ...details } = entry;
    return {
      ...details,
      aadhaarNumberEncrypted: aadhaarNumber ? encryptSecret(aadhaarNumber, "taxId") : "",
      aadhaarNumberMasked: aadhaarNumber ? maskAadhaarNumber(aadhaarNumber) : "",
      businessAccountId: scope.businessAccountId,
      validationStatus: "NOT_VALIDATED",
      createdBy: scope.userId,
      updatedBy: scope.userId
    };
  }), { ordered: true });
  await AuditLog.create({
    action: "ADDRESS_BOOK_ENTRIES_IMPORTED",
    entityType: "BUSINESS_ACCOUNT",
    entityId: scope.businessAccountId,
    performedBy: scope.userId,
    performedAt: new Date(),
    metadata: { importedCount: entries.length }
  });
  return response.status(201).json({ success: true, importedCount: entries.length, entries: entries.map(serializeAddressBookEntry) });
}

export async function downloadAddressBookTemplate(request: Request, response: Response) {
  const businessAccountId = typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : "";
  const scope = await getScope(request, response, businessAccountId);
  if (!scope) return response;
  const format = request.params.format === "csv" ? "csv" : "xlsx";
  const file = format === "csv" ? buildAddressBookTemplateCsv() : await buildAddressBookTemplateWorkbook();
  response.setHeader("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  response.setHeader("Content-Disposition", `attachment; filename="swiftline-address-book-template.${format}"`);
  return response.status(200).send(file);
}
