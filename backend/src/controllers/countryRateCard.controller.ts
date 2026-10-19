import path from "node:path";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import {
  CountryRateCard,
  countryRateServiceValues,
  rateCardBandValues,
  rateCardGstTreatmentValues
} from "../models/countryRateCard.model.js";
import {
  parseRateCardWorkbook,
  rateCardImportLimits,
  RateCardImportError
} from "../services/rateCardImport.service.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { excludeSentinel } from "../services/individualCustomer.service.js";
import { managedRateCardScope, rateCardFilter, touchPrivateRateCard, RateCardScopeError, type RateCardScope } from "../services/rateCardScope.service.js";
import { allowedBranchIds } from "../middleware/branchAccess.middleware.js";
import { AuditLog } from "../models/auditLog.model.js";
import {
  acquireRateCardRouteLock,
  RateCardRouteBusyError
} from "../services/rateCardMutationLock.service.js";

const countryRatePayloadSchema = z.object({
  band: z.enum(rateCardBandValues).optional(),
  businessAccountId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select a valid business account.").optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Country code must be a two-letter ISO code"),
  countryName: z.string().trim().min(2).max(80),
  service: z.enum(countryRateServiceValues),
  fromKg: z.coerce.number().nonnegative(),
  toKg: z.coerce.number().positive(),
  chargesPerKg: z.coerce.number().nonnegative(),
  maxBoxKg: z.coerce.number().positive(),
  gstTreatment: z.enum(rateCardGstTreatmentValues).default("EXCLUDED"),
  gstRatePercent: z.coerce.number().min(0).max(100).default(0),
  gstApplyToAllRates: z.boolean().default(false)
}).refine((data) => data.toKg >= data.fromKg, {
  message: "To KG must be greater than or equal to From KG",
  path: ["toKg"]
});

function normalizeGstInput(input: z.infer<typeof countryRatePayloadSchema>) {
  return input.gstTreatment === "INCLUDED"
    ? input
    : { ...input, gstRatePercent: 0 };
}

// Surcharges, insurance and discount for a route (country + service). Stored once
// per route rather than per weight slab- see countryRouteCharge.model.ts.
const routeChargePayloadSchema = z.object({
  band: z.enum(rateCardBandValues).optional(),
  businessAccountId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select a valid business account.").optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Country code must be a two-letter ISO code"),
  service: z.enum(countryRateServiceValues),
  services: z.array(z.enum(countryRateServiceValues)).min(1).max(2).optional(),
  fuelSurchargePercent: z.coerce.number().min(0).max(100),
  remoteAreaCharge: z.coerce.number().nonnegative(),
  // Accepted as a comma or newline separated list so an operator can paste a
  // block of postcodes straight in. Blanks and duplicates are dropped.
  remoteAreaPostcodes: z.union([z.string(), z.array(z.string())])
    .transform((value) => {
      const entries = Array.isArray(value) ? value : value.split(/[\n,]/);
      return [...new Set(
        entries
          .map((entry) => entry.trim().toUpperCase())
          .filter(Boolean)
      )];
    })
    .pipe(z.array(z.string().max(20, "Each postcode prefix must be 20 characters or fewer")).max(500)),
  handlingCharge: z.coerce.number().nonnegative(),
  insurancePercent: z.coerce.number().min(0).max(100),
  insuranceMinimum: z.coerce.number().nonnegative(),
  discountPercent: z.coerce.number().min(0).max(100)
}).refine((data) => data.remoteAreaCharge === 0 || data.remoteAreaPostcodes.length > 0, {
  // A remote area charge with nothing to match against can never apply, and
  // reads on the rate card screen as though it does.
  message: "Add at least one remote area postcode prefix, or set the remote area charge to zero.",
  path: ["remoteAreaPostcodes"]
});

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

function getRateId(request: Request) {
  const rateId = typeof request.params.id === "string" ? request.params.id : "";
  return mongoose.Types.ObjectId.isValid(rateId) ? rateId : "";
}

function getValidationErrors(error: z.ZodError) {
  return error.issues.map((issue) => issue.message);
}


function requestedScope(request: Request): RateCardScope {
  return {
    businessAccountId: typeof request.query.businessAccountId === "string" ? request.query.businessAccountId : undefined,
    band: typeof request.query.band === "string" ? request.query.band as RateCardScope["band"] : undefined
  };
}

function scopeFailure(response: Response, error: unknown): Response {
  if (error instanceof RateCardScopeError || error instanceof RateCardRouteBusyError) {
    return response.status(error.statusCode).json({
      success: false, code: error.code, message: error.message,
      ...(error instanceof RateCardScopeError ? error.details : {})
    });
  }
  throw error;
}

async function runMutation<T>(
  request: Request, response: Response, input: RateCardScope & { expectedVersion?: number },
  status: number, work: (scope: RateCardScope, session: mongoose.ClientSession) => Promise<T>
): Promise<Response> {
  let release: (() => Promise<void>) | undefined;
  const session = await mongoose.startSession();
  try {
    const scope = await managedRateCardScope(request, input, true);
    release = await acquireRateCardRouteLock({ ...scope, countryCode: "*", service: "COURIER" });
    let result: T | undefined;
    await session.withTransaction(async () => {
      if (scope.businessAccountId) {
        const account = await BusinessAccount.findById(scope.businessAccountId).select("privateRateCardVersion").session(session).lean().exec();
        if (!account) throw new RateCardScopeError("Business account was not found.", 404);
        if (input.expectedVersion == null || input.expectedVersion !== (account.privateRateCardVersion ?? 0)) {
          throw new RateCardScopeError("This rate card changed. Refresh the card before saving.", 409, "RATE_CARD_VERSION_CHANGED");
        }
        if (account.privateRateCardVersion == null) await BusinessAccount.updateOne({ _id: account._id }, { $set: { privateRateCardVersion: 0 } }, { session }).exec();
      }
      result = await work(scope, session);
      await touchPrivateRateCard(scope, session);
    });
    return response.status(status).json({ success: true, ...result, version: scope.businessAccountId ? input.expectedVersion! + 1 : 0 });
  } catch (error) {
    return scopeFailure(response, error);
  } finally {
    await session.endSession();
    if (release) await release().catch(() => undefined);
  }
}

async function countryGstInput(
  input: z.infer<typeof countryRatePayloadSchema>, scope: RateCardScope,
  session: mongoose.ClientSession, disablingPolicy = false
) {
  let rateInput = normalizeGstInput(input);
  if (disablingPolicy) {
    await CountryRateCard.updateMany({ ...rateCardFilter(scope), countryCode: input.countryCode }, {
      $set: { gstApplyToAllRates: false }
    }, { session }).exec();
  } else if (!input.gstApplyToAllRates) {
    const policy = await CountryRateCard.findOne({
      ...rateCardFilter(scope), countryCode: input.countryCode, gstApplyToAllRates: true
    }).session(session).lean().exec();
    if (policy) rateInput = { ...rateInput, gstTreatment: policy.gstTreatment, gstRatePercent: policy.gstRatePercent, gstApplyToAllRates: true };
  }
  if (rateInput.gstApplyToAllRates) {
    await CountryRateCard.updateMany({ ...rateCardFilter(scope), countryCode: input.countryCode }, {
      $set: { gstTreatment: rateInput.gstTreatment, gstRatePercent: rateInput.gstRatePercent, gstApplyToAllRates: true }
    }, { session }).exec();
  }
  const { band: _band, businessAccountId: _owner, expectedVersion: _version, ...fields } = rateInput;
  return { ...fields, ...scope };
}

export async function listCountryRateCards(request: Request, response: Response): Promise<Response> {
  try {
    const target = requestedScope(request);
    const scope = await managedRateCardScope(request, target);
    const account = target.businessAccountId
      ? await BusinessAccount.findById(target.businessAccountId).select("privateRateCardVersion").lean().exec() : null;
    const rates = await CountryRateCard.find({
      ...rateCardFilter(scope),
      ...(typeof request.query.countryCode === "string" ? { countryCode: request.query.countryCode.toUpperCase() } : {}),
      ...(typeof request.query.service === "string" && countryRateServiceValues.includes(request.query.service.toUpperCase() as "COURIER" | "CARGO") ? { service: request.query.service.toUpperCase() as "COURIER" | "CARGO" } : {})
    }).sort({ countryName: 1, service: 1, fromKg: 1 }).lean().exec();
    return response.status(200).json({
      success: true, rates, version: account?.privateRateCardVersion ?? 0,
      migrationRequired: Boolean(target.businessAccountId && scope.band)
    });
  } catch (error) { return scopeFailure(response, error); }
}

/** Searchable, branch-scoped business-account options for the rate-card selector. */
export async function listRateCardBusinessAccountOptions(request: Request, response: Response): Promise<Response> {
  const branches = allowedBranchIds(request);
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const pattern = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  const accounts = await BusinessAccount.find(excludeSentinel({
    ...(branches === null ? {} : { assignedBranch: { $in: branches } }),
    ...(pattern ? { $or: [{ accountId: pattern }, { "company.companyName": pattern }] } : {})
  })).select("accountId company.companyName assignedBranch status privateRateCardVersion privateRateCardReady")
    .sort({ "company.companyName": 1, _id: 1 }).limit(50).lean().exec();
  return response.status(200).json({ success: true, accounts });
}

export async function createCountryRateCard(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = countryRatePayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Country rate is invalid.", errors: getValidationErrors(parsed.error) });
  return runMutation(request, response, parsed.data, 201, async (scope, session) => {
    const overlap = await CountryRateCard.exists({
      ...rateCardFilter(scope), countryCode: parsed.data.countryCode, service: parsed.data.service,
      fromKg: { $lte: parsed.data.toKg }, toKg: { $gte: parsed.data.fromKg }
    }).session(session).exec();
    if (overlap) throw new RateCardScopeError("This slab overlaps an existing weight slab. Use non-overlapping ranges.", 409);
    const fields = await countryGstInput(parsed.data, scope, session);
    const [rate] = await CountryRateCard.create([{ ...fields, createdBy: userId, updatedBy: userId }], { session });
    await AuditLog.create([{ action: "COUNTRY_RATE_CARD_CREATED", entityType: "COUNTRY_RATE_CARD",
      entityId: rate!._id, performedBy: userId, performedAt: new Date(), metadata: { after: rate!.toObject() }
    }], { session });
    return { rate };
  });
}

export async function updateCountryRateCard(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  const id = getRateId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!id) return response.status(404).json({ success: false, message: "Country rate not found." });
  const parsed = countryRatePayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Country rate is invalid.", errors: getValidationErrors(parsed.error) });
  return runMutation(request, response, parsed.data, 200, async (scope, session) => {
    const rate = await CountryRateCard.findOne({ _id: id, ...rateCardFilter(scope) }).session(session).exec();
    if (!rate) throw new RateCardScopeError("Country rate not found.", 404);
    const overlap = await CountryRateCard.exists({
      ...rateCardFilter(scope), _id: { $ne: id }, countryCode: parsed.data.countryCode, service: parsed.data.service,
      fromKg: { $lte: parsed.data.toKg }, toKg: { $gte: parsed.data.fromKg }
    }).session(session).exec();
    if (overlap) throw new RateCardScopeError("This slab overlaps an existing weight slab.", 409);
    const before = rate.toObject();
    const disablingPolicy = rate.countryCode === parsed.data.countryCode
      && rate.gstApplyToAllRates && !parsed.data.gstApplyToAllRates;
    const fields = await countryGstInput(parsed.data, scope, session, disablingPolicy);
    rate.set({ ...fields, updatedBy: userId });
    await rate.save({ session });
    await AuditLog.create([{ action: "COUNTRY_RATE_CARD_UPDATED", entityType: "COUNTRY_RATE_CARD",
      entityId: rate._id, performedBy: userId, performedAt: new Date(), metadata: { before, after: rate.toObject() }
    }], { session });
    return { rate };
  });
}

export async function deleteCountryRateCard(request: Request, response: Response): Promise<Response> {
  const id = getRateId(request);
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const rate = id ? await CountryRateCard.findById(id).lean().exec() : null;
  if (!rate) return response.status(404).json({ success: false, message: "Country rate not found." });
  return runMutation(request, response, {
    businessAccountId: rate.businessAccountId, band: rate.band,
    expectedVersion: request.query.expectedVersion == null ? undefined : Number(request.query.expectedVersion)
  }, 200, async (scope, session) => {
    const removed = await CountryRateCard.findOneAndDelete({ _id: id, ...rateCardFilter(scope) }, { session }).exec();
    if (!removed) throw new RateCardScopeError("Country rate not found.", 404);
    await AuditLog.create([{ action: "COUNTRY_RATE_CARD_DELETED", entityType: "COUNTRY_RATE_CARD",
      entityId: removed._id, performedBy: userId, performedAt: new Date(), metadata: { before: removed.toObject() }
    }], { session });
    return { message: "Country rate removed." };
  });
}

export async function listCountryRouteCharges(request: Request, response: Response): Promise<Response> {
  try {
    const scope = await managedRateCardScope(request, requestedScope(request));
    const account = scope.businessAccountId ? await BusinessAccount.findById(scope.businessAccountId).select("privateRateCardVersion").lean().exec() : null;
    const routeCharges = await CountryRouteCharge.find(rateCardFilter(scope)).sort({ countryCode: 1, service: 1 }).lean().exec();
    return response.status(200).json({ success: true, routeCharges, version: account?.privateRateCardVersion ?? 0 });
  } catch (error) { return scopeFailure(response, error); }
}

export async function saveCountryRouteCharge(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = routeChargePayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Route charges are invalid.", errors: getValidationErrors(parsed.error) });
  return runMutation(request, response, parsed.data, 200, async (scope, session) => {
    const { band: _band, businessAccountId: _owner, expectedVersion: _version, countryCode, service: primaryService, services, ...charges } = parsed.data;
    const routeCharges = [];
    for (const service of new Set(services ?? [primaryService])) {
      const filter = { ...rateCardFilter(scope), countryCode, service };
      const before = await CountryRouteCharge.findOne(filter).session(session).lean().exec();
      const routeCharge = await CountryRouteCharge.findOneAndUpdate(filter, {
        $set: { ...charges, updatedBy: userId }, $setOnInsert: { ...scope, countryCode, service, createdBy: userId }
      }, { session, returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true }).exec();
      await AuditLog.create([{ action: "COUNTRY_ROUTE_CHARGE_SAVED", entityType: "COUNTRY_ROUTE_CHARGE",
        entityId: routeCharge!._id, performedBy: userId, performedAt: new Date(), metadata: { before, after: routeCharge!.toObject() }
      }], { session });
      routeCharges.push(routeCharge);
    }
    return { routeCharge: routeCharges[0], routeCharges };
  });
}

/* -------------------------------------------------------------------------
 * Importing a rate list workbook
 * ---------------------------------------------------------------------- */

const importSlabSchema = z.object({
  fromKg: z.coerce.number().nonnegative(),
  toKg: z.coerce.number().positive(),
  chargesPerKg: z.coerce.number().nonnegative(),
  maxBoxKg: z.coerce.number().positive()
}).refine((slab) => slab.toKg >= slab.fromKg, {
  message: "To KG must be greater than or equal to From KG",
  path: ["toKg"]
});

const importRouteSchema = z.object({
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Country code must be a two-letter ISO code"),
  countryName: z.string().trim().min(2).max(80),
  slabs: z.array(importSlabSchema).min(1).max(rateCardImportLimits.maxWeightRows)
}).superRefine((route, context) => {
  // Overlap is checked here, in memory, rather than with a query per slab as
  // the manual create path does. The slabs arrive as a complete set for the
  // route and every one of them is about to replace what is stored, so the
  // only arrangement that matters is their arrangement against each other.
  const ordered = [...route.slabs].sort((a, b) => a.fromKg - b.fromKg);
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index];
    const previous = ordered[index - 1];
    if (!current || !previous) continue;

    if (current.fromKg <= previous.toKg) {
      context.addIssue({
        code: "custom",
        path: ["slabs"],
        message: `${route.countryName}: the ${current.fromKg}-${current.toKg} kg slab overlaps ${previous.fromKg}-${previous.toKg} kg.`
      });
      return;
    }
  }
});

const importPayloadSchema = z.object({
  band: z.enum(rateCardBandValues).optional(),
  businessAccountId: z.string().refine((value) => mongoose.Types.ObjectId.isValid(value), "Select a valid business account.").optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  services: z.array(z.enum(countryRateServiceValues)).min(1, "Choose at least one service."),
  routes: z.array(importRouteSchema).min(1, "There is nothing to import."),
  // Set by the review screen once the operator has seen which destinations lose
  // their current rates. Re-checked below against the database, so a stale
  // review cannot let a replacement through unseen.
  confirmReplace: z.boolean().optional().default(false),
  fileName: z.string().trim().max(255).optional()
}).superRefine((payload, context) => {
  const services = new Set(payload.services);
  if (services.size !== payload.services.length) {
    context.addIssue({ code: "custom", path: ["services"], message: "Each service can only be imported once." });
  }

  const codes = new Set(payload.routes.map((route) => route.countryCode));
  if (codes.size !== payload.routes.length) {
    context.addIssue({ code: "custom", path: ["routes"], message: "The same destination appears more than once." });
  }

  const total = payload.routes.reduce((running, route) => running + route.slabs.length, 0) * services.size;
  if (total > rateCardImportLimits.maxSlabs) {
    context.addIssue({
      code: "custom",
      path: ["routes"],
      message: `This import would write ${total} rate rows, more than the ${rateCardImportLimits.maxSlabs} allowed at once.`
    });
  }
});

function getUploadExtension(originalName: string) {
  const extension = path.extname(originalName).toLowerCase();
  return extension === ".csv" || extension === ".xls" || extension === ".xlsx" ? extension : null;
}

/**
 * Reads an uploaded rate list and hands back its grid. Writes nothing.
 *
 * Country names are returned exactly as the workbook spells them: matching them
 * to ISO codes happens in the browser, against the same catalogue the country
 * picker uses, and the operator confirms the result before anything is stored.
 */
export async function previewRateCardImport(request: Request, response: Response): Promise<Response> {
  const file = (request as Request & { file?: Express.Multer.File }).file;
  if (!file) return response.status(400).json({ success: false, message: "Attach a rate list to import." });

  const extension = getUploadExtension(file.originalname);
  if (!extension) {
    return response.status(400).json({ success: false, message: "Only .csv, .xls and .xlsx rate lists are supported." });
  }

  try {
    const parsed = await parseRateCardWorkbook(file.buffer, extension);
    return response.status(200).json({ success: true, fileName: file.originalname, ...parsed });
  } catch (error) {
    if (error instanceof RateCardImportError) {
      return response.status(400).json({ success: false, message: error.message });
    }

    // A workbook ExcelJS cannot open is a bad upload, not a server fault.
    return response.status(400).json({
      success: false,
      message: "The file could not be read as a spreadsheet. Re-save it as .xlsx and try again."
    });
  }
}

/**
 * Writes the reviewed rate list.
 *
 * Replace-per-route: for every destination in the payload the stored slabs are
 * deleted and the imported ones inserted. Merging is not an option- the model
 * forbids overlapping slabs, and a hand-tuned 5.01-10 overlaps an incoming
 * 5.01-6, so a merge would have to either reject the import or leave the route
 * holding two prices for the same weight. Destinations absent from the file are
 * never touched.
 */
export async function commitRateCardImport(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = importPayloadSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "This import is invalid.", errors: getValidationErrors(parsed.error) });
  const { services, routes, confirmReplace, fileName } = parsed.data;
  return runMutation(request, response, parsed.data, 200, async (scope, session) => {
    const summary = [];
    if (!confirmReplace) {
      const replacements = [];
      for (const route of routes) {
        for (const service of services) {
          const existingSlabs = await CountryRateCard.countDocuments({
            ...rateCardFilter(scope), countryCode: route.countryCode, service
          }).session(session).exec();
          if (existingSlabs) replacements.push({
            countryCode: route.countryCode, countryName: route.countryName, service, existingSlabs
          });
        }
      }
      if (replacements.length) throw new RateCardScopeError(
        "These destinations already have rates. Confirm the replacements to continue.",
        409, "RATE_CARD_IMPORT_REPLACE_UNCONFIRMED", { replacements }
      );
    }
    for (const route of routes) {
      for (const service of services) {
        const filter = { ...rateCardFilter(scope), countryCode: route.countryCode, service };
        const count = await CountryRateCard.countDocuments(filter).session(session).exec();
        // Importing new slabs preserves this card's existing country GST policy.
        const policy = await CountryRateCard.findOne({ ...rateCardFilter(scope), countryCode: route.countryCode, gstApplyToAllRates: true }).session(session).lean().exec();
        await CountryRateCard.deleteMany(filter).session(session).exec();
        const documents = route.slabs.map((slab) => ({
          ...scope, countryCode: route.countryCode, countryName: route.countryName, service, ...slab,
          ...(policy ? { gstTreatment: policy.gstTreatment, gstRatePercent: policy.gstRatePercent, gstApplyToAllRates: true } : {}),
          createdBy: userId, updatedBy: userId
        }));
        const created = await CountryRateCard.insertMany(documents, { session, ordered: true });
        await AuditLog.create([{ action: "COUNTRY_RATE_CARD_IMPORTED", entityType: "COUNTRY_RATE_CARD",
          entityId: created[0]!._id, performedBy: userId, performedAt: new Date(),
          metadata: { fileName: fileName ?? null, ...scope, countryCode: route.countryCode, countryName: route.countryName, service,
            added: documents.length, removed: count, slabs: route.slabs }
        }], { session });
        summary.push({ countryCode: route.countryCode, countryName: route.countryName, service, added: documents.length, removed: count });
      }
    }
    return { ...scope, services, routesWritten: routes.length,
      slabsWritten: summary.reduce((sum, item) => sum + item.added, 0),
      slabsRemoved: summary.reduce((sum, item) => sum + item.removed, 0), summary };
  });
}
