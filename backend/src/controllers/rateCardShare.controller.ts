import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { countryRateServiceValues, rateCardBandValues } from "../models/countryRateCard.model.js";
import {
  RateCardShare,
  rateCardAdjustmentModeValues,
  rateCardShareChannelValues,
  type IRateCardShare,
  type RateCardShareChannel
} from "../models/rateCardShare.model.js";
import { deliverRateCardShare } from "../services/rateCardShareDelivery.service.js";
import {
  RateCardShareError,
  buildRateCardSnapshot,
  buildRateCardRouteChargeSnapshot,
  createShareToken,
  endOfShareValidityDay,
  generateShareNumber,
  isShareOpen,
  markRateCardShareRead,
  recordPublicShareView,
  resolveShareRecipientLabel,
  serializeRateCardShare,
  shareDocumentBasename,
  shareTokenMatches
} from "../services/rateCardShare.service.js";
import { managedRateCardScope, RateCardScopeError } from "../services/rateCardScope.service.js";
import { allowedBranchIds } from "../middleware/branchAccess.middleware.js";
import { createRateCardSharePdf } from "../services/rateCardSharePdf.service.js";
import { buildRateCardShareWorkbook } from "../services/rateCardShareWorkbook.service.js";

const MAX_LINK_DAYS = 180;

const payloadSchema = z.object({
  band: z.enum(rateCardBandValues).optional(),
  businessAccountId: z.string().refine((id) => mongoose.Types.ObjectId.isValid(id)).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  title: z.string().trim().min(3).max(120).default("International Rate Card"),
  channels: z.array(z.enum(rateCardShareChannelValues)).min(1, "Select at least one sharing channel."),
  selection: z.object({
    countryCodes: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).default([]),
    services: z.array(z.enum(countryRateServiceValues)).default([]),
    rateIds: z.array(z.string().trim()).default([])
  }).default({ countryCodes: [], services: [], rateIds: [] }),
  adjustmentMode: z.enum(rateCardAdjustmentModeValues).default("NONE"),
  // Signed: positive marks up, negative discounts. Bounded so a typo cannot
  // publish a rate card at ten times the real tariff.
  adjustmentValue: z.coerce.number().min(-100).max(500).default(0),
  terms: z.object({
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date(),
    fuelSurchargePercent: z.coerce.number().min(0).max(100).default(0),
    gstPercent: z.coerce.number().min(0).max(100).default(0),
    minChargeableWeightKg: z.coerce.number().min(0).max(10000).default(0),
    volumetricDivisor: z.coerce.number().min(0).max(10000).default(0),
    remarks: z.string().trim().max(1000).default(""),
    customTerms: z.array(z.string().trim().min(1).max(300)).max(20).default([])
  }).refine((terms) => terms.validUntil.getTime() > terms.validFrom.getTime(), {
    message: "Valid until must be after valid from.",
    path: ["validUntil"]
  }),
  recipientAccountIds: z.array(z.string().trim()).max(200).default([]),
  recipientEmails: z.array(z.object({
    email: z.string().trim().toLowerCase().email("Enter a valid recipient email address."),
    name: z.string().trim().max(200).default("")
  })).max(50).default([]),
  recipientPhones: z.array(z.object({
    phone: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/, "Enter the WhatsApp number in international format, for example +919876543210."),
    name: z.string().trim().max(200).default("")
  })).max(50).default([])
}).superRefine((value, context) => {
  if (value.channels.includes("PORTAL") && !value.recipientAccountIds.length) {
    context.addIssue({ code: "custom", path: ["recipientAccountIds"], message: "Select at least one business account to share into the portal." });
  }
  if (value.channels.includes("EMAIL") && !value.recipientAccountIds.length && !value.recipientEmails.length) {
    context.addIssue({ code: "custom", path: ["recipientEmails"], message: "Add at least one email recipient or business account." });
  }
  if (value.channels.includes("WHATSAPP") && !value.recipientPhones.length) {
    context.addIssue({ code: "custom", path: ["recipientPhones"], message: "Add at least one WhatsApp number." });
  }
  if (value.adjustmentMode !== "NONE" && !value.adjustmentValue) {
    context.addIssue({ code: "custom", path: ["adjustmentValue"], message: "Enter a non-zero markup or discount, or set the adjustment to none." });
  }
});

type AuthenticatedUser = { _id?: unknown; name?: string; firstName?: string; lastName?: string; email?: string };

function getUser(request: Request): AuthenticatedUser | null {
  return (request as Request & { user?: AuthenticatedUser }).user ?? null;
}

function getUserId(request: Request): mongoose.Types.ObjectId | null {
  const id = getUser(request)?._id;
  return id && mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : null;
}

function getSenderName(request: Request) {
  const user = getUser(request);
  if (!user) return "The Swiftline Team";
  const name = user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  return name || "The Swiftline Team";
}

function getShareId(request: Request) {
  const shareId = typeof request.params.shareId === "string" ? request.params.shareId : "";
  return mongoose.Types.ObjectId.isValid(shareId) ? new mongoose.Types.ObjectId(shareId) : null;
}

function validationErrors(error: z.ZodError) {
  return error.issues.map((issue) => issue.message);
}

function failure(response: Response, status: number, message: string) {
  return response.status(status).json({ success: false, message });
}

/** pdfkit streams; the response needs the finished bytes and a length. */
function bufferPdf(document: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.end();
  });
}

function sendDocument(response: Response, body: Buffer, filename: string, contentType: string) {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", String(body.length));
  response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // Rate sheets are customer-specific and reachable by link; no shared cache
  // should ever hold one.
  response.setHeader("Cache-Control", "private, no-store");
  return response.status(200).send(body);
}

async function sendSharePdf(response: Response, share: IRateCardShare) {
  const body = await bufferPdf(createRateCardSharePdf(share, resolveShareRecipientLabel(share)));
  return sendDocument(response, body, `${shareDocumentBasename(share)}.pdf`, "application/pdf");
}

async function sendShareWorkbook(response: Response, share: IRateCardShare) {
  const body = await buildRateCardShareWorkbook(share, resolveShareRecipientLabel(share));
  return sendDocument(
    response,
    body,
    `${shareDocumentBasename(share)}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

/* -------------------------------------------------------------------------- */
/* Staff                                                                      */
/* -------------------------------------------------------------------------- */

export async function createRateCardShare(request: Request, response: Response): Promise<Response> {
  const userId = getUserId(request);
  if (!userId) return failure(response, 401, "Unauthorized");

  const parsed = payloadSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      success: false,
      message: "The rate card share is invalid.",
      errors: validationErrors(parsed.error)
    });
  }

  const input = parsed.data;
  const scope = await managedRateCardScope(request, input, true);
  const owner = scope.businessAccountId ? await BusinessAccount.findById(scope.businessAccountId).select("privateRateCardVersion").lean().exec() : null;
  if (owner && input.expectedVersion !== (owner.privateRateCardVersion ?? 0)) throw new RateCardScopeError("This card changed. Refresh it before sharing.", 409);
  if (input.recipientAccountIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) return failure(response, 400, "Select valid recipient accounts.");
  if (input.recipientAccountIds.some((id) => id !== String(scope.businessAccountId ?? ""))) return failure(response, 409, "A private rate card can only target its owning business account. Use explicit email or WhatsApp recipients for an external proposal.");
  const accountIds = input.recipientAccountIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const accounts = accountIds.length
    ? await BusinessAccount.find({ _id: { $in: accountIds } }).select("company.companyName rateCardBand").lean().exec()
    : [];

  if (accounts.length !== accountIds.length) {
    return failure(response, 400, "One or more selected business accounts could not be found.");
  }
  if (input.channels.includes("PORTAL")) {
    if (input.adjustmentMode !== "NONE" || input.adjustmentValue !== 0) {
      return failure(response, 400, "Portal rate cards cannot include an extra markup or discount. Use an external proposal instead.");
    }
    const unassigned = !scope.businessAccountId || !accounts.length;
    const mismatched = accounts.some((account) => String(account._id) !== String(scope.businessAccountId));
    if (unassigned || mismatched) {
      return failure(response, 409, "Portal sharing is available only to the business account that owns this rate card.");
    }
  }

  try {
    const rows = await buildRateCardSnapshot(scope, input.selection, input.adjustmentMode, input.adjustmentValue);
    const routeCharges = await buildRateCardRouteChargeSnapshot(scope, rows);
    if (owner) {
      const current = await BusinessAccount.findById(owner._id).select("privateRateCardVersion").lean().exec();
      if (current?.privateRateCardVersion !== owner.privateRateCardVersion) {
        throw new RateCardScopeError("This card changed while preparing the share. Refresh it before sharing.", 409);
      }
    }
    const { token, tokenHash } = createShareToken();

    // The link dies with the rates it quotes, capped so an open-ended validity
    // window cannot leave a public URL live forever.
    const maximumExpiry = new Date(Date.now() + MAX_LINK_DAYS * 24 * 60 * 60 * 1000);
    const validityEnd = endOfShareValidityDay(input.terms.validUntil);
    const publicTokenExpiresAt = new Date(Math.min(validityEnd.getTime(), maximumExpiry.getTime()));

    const share = await RateCardShare.create({
      shareNumber: await generateShareNumber(),
      ...scope,
      privateRateCardVersion: owner?.privateRateCardVersion ?? undefined,
      title: input.title,
      currency: "INR",
      channels: [...new Set(input.channels)],
      rows,
      routeCharges,
      adjustmentMode: input.adjustmentMode,
      adjustmentValue: input.adjustmentValue,
      terms: input.terms,
      recipientAccounts: accounts.map((account) => ({
        businessAccountId: account._id,
        companyName: account.company?.companyName ?? ""
      })),
      recipientEmails: input.recipientEmails,
      recipientPhones: input.recipientPhones,
      publicTokenHash: tokenHash,
      publicTokenExpiresAt,
      status: "ACTIVE",
      createdBy: userId
    });

    const delivery = await deliverRateCardShare({ share, token, senderName: getSenderName(request) });

    return response.status(201).json({
      success: true,
      // The raw token is returned exactly once. It is never persisted, so this
      // response is the only chance to hand the sender a working link.
      share: serializeRateCardShare(share, { includeBaseRates: true }),
      links: delivery.links,
      emailsQueued: delivery.emailsQueued,
      whatsappLinks: delivery.whatsappLinks
    });
  } catch (error) {
    if (error instanceof RateCardShareError) return failure(response, error.status, error.message);
    throw error;
  }
}

async function staffShareFilter(request: Request): Promise<Record<string, unknown>> {
  const branches = allowedBranchIds(request);
  if (branches === null) return {};
  const accounts = await BusinessAccount.find({ assignedBranch: { $in: branches }, accountKind: { $ne: "INDIVIDUAL_SENTINEL" } }).select("_id").lean().exec();
  return { $or: [{ businessAccountId: { $in: accounts.map((account) => account._id) } }, { businessAccountId: null }] };
}

export async function listRateCardShares(request: Request, response: Response): Promise<Response> {
  const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
  const shares = await RateCardShare.find(await staffShareFilter(request)).sort({ createdAt: -1 }).limit(limit).exec();

  return response.status(200).json({
    success: true,
    shares: shares.map((share) => serializeRateCardShare(share, { includeBaseRates: true }))
  });
}

export async function getRateCardShare(request: Request, response: Response): Promise<Response> {
  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card share not found.");

  const share = await RateCardShare.findOne({ _id: shareId, ...await staffShareFilter(request) }).exec();
  if (!share) return failure(response, 404, "Rate card share not found.");

  return response.status(200).json({
    success: true,
    share: serializeRateCardShare(share, { includeBaseRates: true })
  });
}

export async function revokeRateCardShare(request: Request, response: Response): Promise<Response> {
  const userId = getUserId(request);
  if (!userId) return failure(response, 401, "Unauthorized");

  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card share not found.");

  const share = await RateCardShare.findOneAndUpdate(
    { _id: shareId, ...await staffShareFilter(request) },
    { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: userId } },
    { new: true, runValidators: true }
  ).exec();

  if (!share) return failure(response, 404, "Rate card share not found.");

  return response.status(200).json({
    success: true,
    message: "The shared rate card link has been revoked.",
    share: serializeRateCardShare(share, { includeBaseRates: true })
  });
}

export async function downloadRateCardSharePdf(request: Request, response: Response): Promise<Response> {
  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card share not found.");

  const share = await RateCardShare.findOne({ _id: shareId, ...await staffShareFilter(request) }).exec();
  if (!share) return failure(response, 404, "Rate card share not found.");

  return sendSharePdf(response, share);
}

export async function downloadRateCardShareWorkbook(request: Request, response: Response): Promise<Response> {
  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card share not found.");

  const share = await RateCardShare.findOne({ _id: shareId, ...await staffShareFilter(request) }).exec();
  if (!share) return failure(response, 404, "Rate card share not found.");

  return sendShareWorkbook(response, share);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/** The business accounts the caller is an active member of. */
async function getMemberAccountIds(userId: mongoose.Types.ObjectId) {
  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount")
    .lean()
    .exec();
  return memberships.map((membership) => membership.businessAccount);
}

/**
 * What the client tray is allowed to see: an active share, addressed to one of
 * the caller's accounts, that the sender actually chose to deliver in-portal.
 * A share emailed to an account without the PORTAL channel stays out of the
 * tray- the channel selection is an instruction, not a hint.
 */
function clientShareFilter(accountIds: mongoose.Types.ObjectId[]) {
  return {
    status: "ACTIVE" as const,
    channels: { $in: ["PORTAL"] as RateCardShareChannel[] },
    "recipientAccounts.businessAccountId": { $in: accountIds }
  };
}

async function getAccountBandMap(accountIds: mongoose.Types.ObjectId[]) {
  const accounts = await BusinessAccount.find({ _id: { $in: accountIds } }).select("rateCardBand privateRateCardVersion").lean().exec();
  return new Map(accounts.map((account) => [String(account._id), { band: account.rateCardBand ?? null, version: account.privateRateCardVersion }]));
}

function isHistoricalForClient(share: IRateCardShare, accountBands: Map<string, { band: string | null; version?: number | null }>) {
  const recipient = share.recipientAccounts.find((account) => accountBands.has(String(account.businessAccountId)));
  if (!recipient) return true;
  const current = accountBands.get(String(recipient.businessAccountId));
  if (share.businessAccountId) return String(share.businessAccountId) !== String(recipient.businessAccountId) || share.privateRateCardVersion !== current?.version;
  return current?.version != null || (share.band ?? "BAND_A") !== current?.band;
}

/**
 * Loads a share only if it was addressed to one of the caller's accounts. A
 * client holding someone else's share id gets the same 404 as one holding a
 * made-up id, so the endpoint reveals nothing about which shares exist.
 */
async function findClientShare(userId: mongoose.Types.ObjectId, shareId: mongoose.Types.ObjectId) {
  const accountIds = await getMemberAccountIds(userId);
  if (!accountIds.length) return null;

  return RateCardShare.findOne({ _id: shareId, ...clientShareFilter(accountIds) }).exec();
}

export async function listClientRateCardShares(request: Request, response: Response): Promise<Response> {
  const userId = getUserId(request);
  if (!userId) return failure(response, 401, "Unauthorized");

  const accountIds = await getMemberAccountIds(userId);
  if (!accountIds.length) {
    return response.status(200).json({ success: true, shares: [], unreadCount: 0 });
  }

  const shares = await RateCardShare.find(clientShareFilter(accountIds))
    .sort({ createdAt: -1 })
    .limit(50)
    .exec();

  const accountBands = await getAccountBandMap(accountIds);
  const serialized = shares.map((share) => ({
    ...serializeRateCardShare(share, { currentUserId: String(userId) }),
    historical: isHistoricalForClient(share, accountBands)
  }));

  return response.status(200).json({
    success: true,
    shares: serialized,
    // Expired cards stay listed for reference but stop nagging: only a live
    // card is worth pulling someone's attention to.
    unreadCount: serialized.filter((share) => !share.readAt && !share.expired).length
  });
}

export async function getClientRateCardShare(request: Request, response: Response): Promise<Response> {
  const userId = getUserId(request);
  if (!userId) return failure(response, 401, "Unauthorized");

  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card not found.");

  const share = await findClientShare(userId, shareId);
  if (!share) return failure(response, 404, "Rate card not found.");
  const accountBands = await getAccountBandMap(await getMemberAccountIds(userId));

  return response.status(200).json({
    success: true,
    share: {
      ...serializeRateCardShare(share, { currentUserId: String(userId) }),
      historical: isHistoricalForClient(share, accountBands)
    }
  });
}

export async function markClientRateCardShareRead(request: Request, response: Response): Promise<Response> {
  const userId = getUserId(request);
  if (!userId) return failure(response, 401, "Unauthorized");

  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card not found.");

  const share = await findClientShare(userId, shareId);
  if (!share) return failure(response, 404, "Rate card not found.");

  await markRateCardShareRead(share._id as mongoose.Types.ObjectId, userId);

  return response.status(200).json({ success: true, message: "Rate card marked as read." });
}

export async function downloadClientRateCardSharePdf(request: Request, response: Response): Promise<Response> {
  const userId = getUserId(request);
  if (!userId) return failure(response, 401, "Unauthorized");

  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card not found.");

  const share = await findClientShare(userId, shareId);
  if (!share) return failure(response, 404, "Rate card not found.");

  return sendSharePdf(response, share);
}

export async function downloadClientRateCardShareWorkbook(request: Request, response: Response): Promise<Response> {
  const userId = getUserId(request);
  if (!userId) return failure(response, 401, "Unauthorized");

  const shareId = getShareId(request);
  if (!shareId) return failure(response, 404, "Rate card not found.");

  const share = await findClientShare(userId, shareId);
  if (!share) return failure(response, 404, "Rate card not found.");

  return sendShareWorkbook(response, share);
}

/* -------------------------------------------------------------------------- */
/* Public link                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolves a share from its id and link token. Returns a single opaque failure
 * for a bad id, a bad token, a revoked share and an expired one alike- a
 * recipient whose link stopped working is told so by the page, not by a status
 * code that distinguishes "wrong token" from "no such share".
 */
async function findPublicShare(request: Request) {
  const shareId = getShareId(request);
  const token = typeof request.query.token === "string" ? request.query.token : "";
  if (!shareId || !token) return null;

  const share = await RateCardShare.findById(shareId).exec();
  if (!share) return null;
  if (!shareTokenMatches(token, share.publicTokenHash)) return null;
  if (!isShareOpen(share)) return null;

  return share;
}

const PUBLIC_LINK_MESSAGE = "This rate card link is no longer valid. Please contact your Swiftline representative for the latest rates.";

export async function getPublicRateCardShare(request: Request, response: Response): Promise<Response> {
  const share = await findPublicShare(request);
  if (!share) return failure(response, 404, PUBLIC_LINK_MESSAGE);

  await recordPublicShareView(share._id as mongoose.Types.ObjectId);

  return response.status(200).json({
    success: true,
    share: serializeRateCardShare(share),
    recipientLabel: resolveShareRecipientLabel(share)
  });
}

export async function downloadPublicRateCardSharePdf(request: Request, response: Response): Promise<Response> {
  const share = await findPublicShare(request);
  if (!share) return failure(response, 404, PUBLIC_LINK_MESSAGE);

  return sendSharePdf(response, share);
}

export async function downloadPublicRateCardShareWorkbook(request: Request, response: Response): Promise<Response> {
  const share = await findPublicShare(request);
  if (!share) return failure(response, 404, PUBLIC_LINK_MESSAGE);

  return sendShareWorkbook(response, share);
}
