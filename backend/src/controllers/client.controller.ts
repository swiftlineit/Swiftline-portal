import { shipmentBookingRoles } from "../models/businessAccountMember.model.js";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Branch } from "../models/branch.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentDraft, type IShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentImportBatch } from "../models/shipmentImportBatch.model.js";
import {
  buildDeliveryEstimate,
  buildTrackingAttention,
  buildTrackingSummary,
  resolveShipmentByTrackingNumber
} from "../services/shipmentTracking.service.js";
import { resolveShipmentEventNote } from "../services/shipmentEventCopy.service.js";
import { formatShipmentEventLabel } from "../services/shipmentStatusSequence.service.js";
import {
  formatTrackingEventLabel,
  loadShipmentJourney,
  normalizeVisibleTrackingHistory,
  type TrackingJourney
} from "../services/shipmentJourney.service.js";
import { buildTrackingPosition } from "../services/shipmentPosition.service.js";
import {
  loadShipmentParcelActivities,
  loadShipmentParcelProgress
} from "../services/shipmentParcelActivity.service.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import {
  createShipmentImportBatch,
  createShipmentImportDrafts,
  downloadShipmentImportTemplate,
  getShipmentImportBatch
} from "./shipmentImport.controller.js";
import {
  createManualShipmentDraft,
  deleteShipmentDraftHandler,
  deleteShipmentDraftsHandler,
  getShipmentDraft,
  getShipmentDraftRateCardContext,
  getShipmentDraftCostEstimate,
  restoreShipmentDraftHandler,
  updateShipmentDraft
} from "./shipmentDraft.controller.js";
import {
  createShipmentAmendment,
  previewShipmentAmendment
} from "./shipmentAmendment.controller.js";
import {
  deleteShipmentKycDocument,
  deleteShipmentParcelKycDocument,
  downloadShipmentKycDocument,
  downloadShipmentParcelKycDocument,
  uploadShipmentKycDocument,
  uploadShipmentParcelKycDocument
} from "./shipmentKyc.controller.js";
import { serializeKycDocuments } from "./shipmentKyc.controller.js";
import { downloadShipmentInvoicePdf, getShipmentInvoice } from "./shipmentInvoice.controller.js";
import {
  downloadShipmentInvoiceRevisedDocumentPdf,
  getShipmentInvoiceRevisedDocument,
  listShipmentInvoiceRevisedDocuments
} from "./shipmentInvoiceRevisedDocument.controller.js";
import { buildStoredLabelAccess } from "./dpdShipment.controller.js";
import {
  DpdLabelUnavailableError,
  DpdShipmentServiceError,
  createLabelForShipmentDraft
} from "../services/dpdShipment.service.js";
import { normalizeCsbType } from "../services/csbType.service.js";
import { buildPricingHash, ShipmentPriceChangedError } from "../services/shipmentCostEstimate.service.js";
import { RateCardRequiredError } from "../services/shipmentPricing.service.js";
import {
  downloadCustomsInvoicePdf,
  downloadCustomsInvoiceWorkbook,
  getCustomsInvoice
} from "./customsInvoice.controller.js";
import { normalizeParcelItems } from "../services/parcelItems.service.js";
import { clientCanAccessShipmentDraft } from "../services/shipmentDraftPolicy.service.js";
import {
  readShipmentBookingSnapshot,
  serializeShipmentBookingConfirmation
} from "../services/shipmentBookingSnapshot.service.js";

function getAuthenticatedUserId(request: Request) {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  return user?._id ? String(user._id) : "";
}

function formatStatus(value?: string | null) {
  return value ? value.replace(/_/g, " ") : "Not set";
}

type ClientBranchSnapshot = {
  _id?: unknown;
  name?: string;
  code?: string;
  status?: string;
};

function serializeClientBranch(branch: ClientBranchSnapshot) {
  return {
    _id: String(branch._id ?? ""),
    name: branch.name ?? "",
    code: branch.code ?? "",
    status: branch.status ?? ""
  };
}

function makeEmptyShipmentSummary(branchId?: string) {
  return {
    branchId: branchId ?? "",
    totalShipments: 0,
    readyForLabel: 0,
    labelsCreated: 0,
    validationFailed: 0,
    needsReview: 0,
    addressValidated: 0,
    lastActivityAt: null as Date | null
  };
}

type ClientShipmentDraftSnapshot = {
  _id: unknown;
  branchId: unknown;
  parcelList?: Array<{ shipmentReference1?: string }>;
  parcelCount?: number;
  status?: string;
  bookingState?: string;
  addressValidationStatus?: string;
  consigneeEnteredAddress?: {
    companyName?: string;
    contactName?: string;
    countryName?: string;
    countryCode?: string;
    townOrCity?: string;
    postcode?: string;
  };
  createdAt?: Date;
  updatedAt?: Date;
};

type ClientDpdShipmentSnapshot = {
  shipmentDraftId: unknown;
  dpdShipmentId?: string;
  swiftlineTrackingNumber?: string;
  parcelNumbers?: string[];
  status?: string;
  updatedAt?: Date;
};

type ClientShipmentEventSnapshot = {
  shipmentDraftId: unknown;
  status: string;
  holdReason?: string | null;
};

function bumpShipmentSummary(
  summary: ReturnType<typeof makeEmptyShipmentSummary>,
  draft: ClientShipmentDraftSnapshot,
  labelCreated: boolean
) {
  summary.totalShipments += 1;
  if (draft.status === "READY_FOR_DPD") summary.readyForLabel += 1;
  if (draft.status === "VALIDATION_FAILED") summary.validationFailed += 1;
  if (draft.status === "NEEDS_REVIEW" || draft.status === "ADDRESS_INCOMPLETE") summary.needsReview += 1;
  if (draft.addressValidationStatus === "VALIDATED") summary.addressValidated += 1;
  if (labelCreated) summary.labelsCreated += 1;

  const activityAt = draft.updatedAt ?? draft.createdAt ?? null;
  if (activityAt && (!summary.lastActivityAt || activityAt > summary.lastActivityAt)) {
    summary.lastActivityAt = activityAt;
  }
}

async function buildClientShipmentDashboard(accountId: string, branchIds: string[]) {
  if (!mongoose.Types.ObjectId.isValid(accountId)) {
    return {
      summary: makeEmptyShipmentSummary(),
      branchSummaries: [],
      recentShipments: []
    };
  }

  const branchObjectIds = branchIds
    .filter((branchId) => mongoose.Types.ObjectId.isValid(branchId))
    .map((branchId) => new mongoose.Types.ObjectId(branchId));
  const query = {
    businessAccountId: new mongoose.Types.ObjectId(accountId),
    deletedAt: null,
    ...(branchObjectIds.length ? { branchId: { $in: branchObjectIds } } : {})
  };
  const drafts = await ShipmentDraft.find(query)
    .select([
      "branchId",
      "parcelList.shipmentReference1",
      "parcelCount",
      "status",
      "bookingState",
      "addressValidationStatus",
      "consigneeEnteredAddress.companyName",
      "consigneeEnteredAddress.contactName",
      "consigneeEnteredAddress.countryName",
      "consigneeEnteredAddress.countryCode",
      "consigneeEnteredAddress.townOrCity",
      "consigneeEnteredAddress.postcode",
      "createdAt",
      "updatedAt"
    ].join(" "))
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean<ClientShipmentDraftSnapshot[]>()
    .exec();
  const draftIds = drafts
    .map((draft) => String(draft._id ?? ""))
    .filter((draftId) => mongoose.Types.ObjectId.isValid(draftId))
    .map((draftId) => new mongoose.Types.ObjectId(draftId));
  const recentDraftIds = draftIds.slice(0, 6);
  const [dpdShipments, shipmentInvoices, latestEvents] = draftIds.length
    ? await Promise.all([
      DpdShipment.find({ shipmentDraftId: { $in: draftIds } })
        .select("shipmentDraftId dpdShipmentId swiftlineTrackingNumber parcelNumbers status updatedAt")
        .lean<ClientDpdShipmentSnapshot[]>()
        .exec(),
      ShipmentInvoice.find({ shipmentDraftId: { $in: draftIds } })
        .select("shipmentDraftId invoiceNumber currency totalAmountMinor status revision")
        .lean()
        .exec(),
      ShipmentEvent.aggregate<{ _id: mongoose.Types.ObjectId; event: ClientShipmentEventSnapshot }>([
        { $match: { shipmentDraftId: { $in: recentDraftIds }, customerVisible: true } },
        { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
        { $group: { _id: "$shipmentDraftId", event: { $first: "$$ROOT" } } },
        { $project: { "event.shipmentDraftId": 1, "event.status": 1, "event.holdReason": 1 } }
      ]).exec()
    ])
    : [[], [], []] as [ClientDpdShipmentSnapshot[], Array<{
      shipmentDraftId: unknown;
      invoiceNumber: string;
      currency: string;
      totalAmountMinor: number;
      status: string;
      revision: number;
    }>, Array<{ _id: mongoose.Types.ObjectId; event: ClientShipmentEventSnapshot }>];
  const dpdByDraftId = new Map(dpdShipments.map((shipment) => [String(shipment.shipmentDraftId), shipment]));
  const shipmentInvoiceByDraftId = new Map(shipmentInvoices.map((invoice) => [String(invoice.shipmentDraftId), invoice]));
  const currentEventByDraftId = new Map(latestEvents.map((item) => [String(item._id), item.event]));
  const branchSummaryMap = new Map(branchIds.map((branchId) => [branchId, makeEmptyShipmentSummary(branchId)]));
  const summary = makeEmptyShipmentSummary();

  for (const draft of drafts) {
    const dpdShipment = dpdByDraftId.get(String(draft._id));
    const labelCreated = Boolean(dpdShipment && ["DPD_CREATED", "LABEL_RECEIVED"].includes(dpdShipment.status ?? ""));

    bumpShipmentSummary(summary, draft, labelCreated);
    const branchSummary = branchSummaryMap.get(String(draft.branchId));
    if (branchSummary) bumpShipmentSummary(branchSummary, draft, labelCreated);
  }

  return {
    summary,
    branchSummaries: Array.from(branchSummaryMap.values()),
    recentShipments: drafts.slice(0, 6).map((draft) => {
      const dpdShipment = dpdByDraftId.get(String(draft._id));
      const currentEvent = currentEventByDraftId.get(String(draft._id)) ?? null;
      const shipmentInvoice = shipmentInvoiceByDraftId.get(String(draft._id));

      return {
        id: String(draft._id ?? ""),
        branchId: String(draft.branchId ?? ""),
        invoiceNumber: "",
        shipmentReference: draft.parcelList?.find((parcel) => parcel.shipmentReference1?.trim())?.shipmentReference1 ?? "",
        destination: {
          companyName: draft.consigneeEnteredAddress?.companyName ?? "",
          contactName: draft.consigneeEnteredAddress?.contactName ?? "",
          countryName: draft.consigneeEnteredAddress?.countryName ?? "",
          countryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
          townOrCity: draft.consigneeEnteredAddress?.townOrCity ?? "",
          postcode: draft.consigneeEnteredAddress?.postcode ?? ""
        },
        parcelCount: draft.parcelCount ?? 0,
        status: draft.status ?? "",
        statusLabel: formatStatus(draft.status),
        addressValidationStatus: draft.addressValidationStatus ?? "",
        dpdStatus: dpdShipment?.status ?? "",
        currentStatus: currentEvent?.status ?? "",
        currentStatusLabel: currentEvent ? formatShipmentEventLabel(currentEvent.status) : "",
        holdReason: currentEvent?.status === "ON_HOLD" ? currentEvent.holdReason ?? "" : "",
        dpdShipmentId: dpdShipment?.dpdShipmentId ?? "",
        swiftlineTrackingNumber: dpdShipment?.swiftlineTrackingNumber ?? "",
        parcelNumbers: dpdShipment?.parcelNumbers ?? [],
        shipmentInvoice: shipmentInvoice ? {
          invoiceNumber: shipmentInvoice.invoiceNumber,
          currency: shipmentInvoice.currency,
          totalAmountMinor: shipmentInvoice.totalAmountMinor,
          chargeableAmountMinor: shipmentInvoice.totalAmountMinor,
          status: shipmentInvoice.status,
          revision: shipmentInvoice.revision
        } : null,
        createdAt: draft.createdAt ?? null,
        updatedAt: draft.updatedAt ?? null
      };
    })
  };
}

async function getActiveClientMembership(userId: string, branchId?: string) {
  const membership = await BusinessAccountMember.findOne({
    user: userId,
    status: "active"
  })
    .populate({
      path: "businessAccount",
      select: "accountId status contact company kycReview assignedBranch rateCardBand",
      populate: { path: "assignedBranch", select: "name code status address city state" }
    })
    .populate("assignedBranches", "name code status address city state")
    .sort({ createdAt: -1 })
    .exec();

  if (!membership) return null;

  const assignedBranches = membership.assignedBranches as unknown as ClientBranchSnapshot[];
  const account = membership.businessAccount as unknown as {
    _id?: unknown;
    status?: string;
    kycReview?: { overallStatus?: string };
    assignedBranch?: ClientBranchSnapshot | null;
    rateCardBand?: string | null;
  };

  // Every operational client path funnels through here, so the business account
  // must itself be active and KYC-verified; a suspended or unverified account
  // grants no working context even if the membership is active.
  if (account.status !== "active" || account.kycReview?.overallStatus !== "verified") {
    return null;
  }

  // Prefer explicit member branches, then the account's assigned branch.
  // If neither exists, the client has account-level access only; do not expose
  // every company branch implicitly.
  const effectiveBranches = assignedBranches.length
    ? assignedBranches
    : account.assignedBranch
      ? [account.assignedBranch]
      : [];
  const allowedBranchIds = effectiveBranches.map((branch) => String(branch._id ?? "")).filter(Boolean);
  const selectedBranchId = branchId || allowedBranchIds[0] || "";

  if (!selectedBranchId || !allowedBranchIds.includes(selectedBranchId)) {
    return null;
  }

  return {
    membership,
    account,
    branchId: selectedBranchId
  };
}

function canCreateClientShipment(role: unknown) {
  return (shipmentBookingRoles as string[]).includes(String(role));
}

function sendShipmentRoleError(response: Response) {
  return response.status(403).json({
    success: false,
    message: "Your account role can view shipments but cannot create or edit them."
  });
}

function getDashboardAccess(account: {
  status?: string;
  kycReview?: { overallStatus?: string };
}, membership: { status?: string }) {
  const blockers: string[] = [];

  if (membership.status !== "active") blockers.push("Client login access is not active.");
  if (account.status === "suspended") blockers.push("Business account is suspended.");
  if (account.status !== "active") blockers.push("Business account is not active.");
  if (account.kycReview?.overallStatus !== "verified") blockers.push("Required KYC approval is incomplete.");

  return {
    state: blockers.length ? "BLOCKED" : "READY",
    blockers
  };
}

function getBookingAccess(account: { rateCardBand?: string | null }) {
  const message = "Shipment booking is paused until a rate card is assigned. Please contact Swiftline support.";

  return account.rateCardBand
    ? { state: "READY" as const, code: null, message: null }
    : { state: "PAUSED" as const, code: "RATE_CARD_REQUIRED" as const, message };
}

export async function clientCanAccessDraft(userId: string, draftId: string, requireEditPermission = false) {
  if (!mongoose.Types.ObjectId.isValid(draftId)) return false;

  // A deleted draft is invisible to clients, so every route gated on this helper
  // answers 404 for one without needing its own check.
  const draft = await ShipmentDraft.findOne({ _id: draftId, deletedAt: null }).lean().exec();
  if (!draft) return false;
  return clientCanAccessShipmentDraft({ userId, draft, requireEditPermission });
}

export async function getClientDashboard(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);

  if (!userId) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  // A client can only see accounts where their active membership links them to
  // the business account. Admin-only account APIs remain separate.
  const memberships = await BusinessAccountMember.find({
      user: userId,
      status: { $in: ["active", "suspended"] }
    })
      .populate({
        path: "businessAccount",
        select: "accountId status contact company kycReview assignedBranch rateCardBand submittedAt createdAt",
        populate: { path: "assignedBranch", select: "name code status address city state" }
      })
      .populate("assignedBranches", "name code status address city state")
      .sort({ createdAt: -1 })
      .exec();

  const accountContexts = memberships.map((membership) => {
    const account = membership.businessAccount as unknown as {
      accountId?: string;
      status?: string;
      contact?: {
        firstName?: string;
        lastName?: string;
        email?: string;
        countryCode?: string;
        mobileNumber?: string;
        jobTitle?: string;
        department?: string;
      };
      company?: {
        companyName?: string;
        companyType?: string;
        industry?: string;
        registrationCountry?: string;
        registrationIdType?: string;
        registrationId?: string;
        registeredAddress?: string;
        city?: string;
        stateOrProvince?: string;
        postalCode?: string;
        addressCountry?: string;
        requestedCreditLimit?: { currency?: string; amount?: number | null };
      };
      kycReview?: { overallStatus?: string };
      assignedBranch?: { _id?: unknown; name?: string; code?: string; status?: string } | null;
      rateCardBand?: string | null;
      submittedAt?: Date | null;
      createdAt?: Date;
    };
    const accountDocumentId = String((account as { _id?: unknown })._id ?? membership.businessAccount ?? "");

    const assignedBranches = membership.assignedBranches as unknown as ClientBranchSnapshot[];
    const effectiveBranches = assignedBranches.length
      ? assignedBranches
      : account.assignedBranch
        ? [account.assignedBranch]
        : [];
    const dashboardAccess = getDashboardAccess(account, membership);
    const bookingAccess = getBookingAccess(account);

    return {
      membership: {
        role: membership.role,
        status: membership.status,
        joinedAt: membership.joinedAt ?? null
      },
      account: {
        id: accountDocumentId,
        accountId: account.accountId ?? "",
        status: account.status ?? "",
        statusLabel: formatStatus(account.status),
        kycStatus: account.kycReview?.overallStatus ?? "",
        kycStatusLabel: formatStatus(account.kycReview?.overallStatus),
        submittedAt: account.submittedAt ?? null,
        createdAt: account.createdAt ?? null,
        contact: account.contact ?? {},
        company: account.company ?? {},
        assignedBranch: account.assignedBranch
          ? {
              _id: String(account.assignedBranch._id ?? ""),
              name: account.assignedBranch.name ?? "",
              code: account.assignedBranch.code ?? "",
              status: account.assignedBranch.status ?? ""
            }
          : null,
        rateCard: {
          title: "Your Swiftline Rate Card",
          assigned: Boolean(account.rateCardBand)
        }
      },
      dashboardAccess,
      bookingAccess,
      assignedBranches: effectiveBranches.map(serializeClientBranch)
    };
  });
  const shipmentDashboards = await Promise.all(
    accountContexts.map((context) => buildClientShipmentDashboard(
      context.account.id,
      context.assignedBranches.map((branch) => branch._id)
    ))
  );
  const accounts = accountContexts.map((context, index) => ({
    ...context,
    shipments: shipmentDashboards[index]
  }));

  return response.status(200).json({
    success: true,
    serverTime: new Date(),
    accounts
  });
}

export async function listClientShipments(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const businessAccountId = typeof request.query.businessAccountId === "string"
    ? request.query.businessAccountId
    : "";
  const branchId = typeof request.query.branchId === "string" ? request.query.branchId : "";
  if (!mongoose.Types.ObjectId.isValid(businessAccountId)) {
    return response.status(400).json({ success: false, message: "Select a valid business account." });
  }
  if (branchId && !mongoose.Types.ObjectId.isValid(branchId)) {
    return response.status(400).json({ success: false, message: "Select a valid branch." });
  }

  const membership = await BusinessAccountMember.findOne({
    user: userId,
    businessAccount: businessAccountId,
    status: "active"
  })
    .populate({
      path: "businessAccount",
      select: "assignedBranch",
      populate: { path: "assignedBranch", select: "name code status address" }
    })
    .populate("assignedBranches", "name code status address")
    .exec();

  if (!membership) {
    return response.status(404).json({ success: false, message: "Business account access is not available." });
  }

  const account = membership.businessAccount as unknown as {
    _id?: unknown;
    assignedBranch?: ClientBranchSnapshot | null;
  };
  const memberBranches = membership.assignedBranches as unknown as ClientBranchSnapshot[];
  const effectiveBranches = memberBranches.length
    ? memberBranches
    : account.assignedBranch
      ? [account.assignedBranch]
      : [];
  const allowedBranchIds = effectiveBranches.map((branch) => String(branch._id ?? "")).filter(Boolean);

  if (!allowedBranchIds.length || (branchId && !allowedBranchIds.includes(branchId))) {
    return response.status(403).json({ success: false, message: "This branch is not assigned to your login." });
  }

  const requestedPage = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(request.query.limit ?? "10"), 10) || 10));
  const branchObjectIds = (branchId ? [branchId] : allowedBranchIds).map((id) => new mongoose.Types.ObjectId(id));
  // Workspace table holds unbooked drafts only. Booked shipments live in the
  // booked-shipments list. bookingState (indexed) is the discriminator: a
  // rejected carrier booking can leave a stale DpdShipment pointing at an
  // editable draft, so carrier-row existence alone would misclassify.
  const query = {
    businessAccountId: new mongoose.Types.ObjectId(businessAccountId),
    branchId: { $in: branchObjectIds },
    bookingState: { $in: ["EDITABLE", "BOOKING", "REVIEW_REQUIRED"] as const },
    deletedAt: null
  };
  const total = await ShipmentDraft.countDocuments(query).exec();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const drafts = await ShipmentDraft.find(query)
    .sort({ updatedAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean<ClientShipmentDraftSnapshot[]>()
    .exec();
  const draftIds = drafts.map((draft) => new mongoose.Types.ObjectId(String(draft._id)));
  const [dpdShipments, shipmentInvoices, events, branches] = await Promise.all([
    draftIds.length
      ? DpdShipment.find({ shipmentDraftId: { $in: draftIds } }).lean<ClientDpdShipmentSnapshot[]>().exec()
      : [],
    draftIds.length
      ? ShipmentInvoice.find({ shipmentDraftId: { $in: draftIds } })
          .select("shipmentDraftId invoiceNumber currency totalAmountMinor status revision")
          .lean()
          .exec()
      : [],
    draftIds.length
      ? ShipmentEvent.find({ shipmentDraftId: { $in: draftIds }, customerVisible: true })
          .sort({ eventAt: -1, createdAt: -1 })
          .lean()
          .exec()
      : [],
    Branch.find({ _id: { $in: branchObjectIds } }).select("name code address").lean().exec()
  ]);

  const dpdByDraftId = new Map(dpdShipments.map((item) => [String(item.shipmentDraftId), item]));
  const invoiceByDraftId = new Map(shipmentInvoices.map((item) => [String(item.shipmentDraftId), item]));
  const branchById = new Map(branches.map((item) => [String(item._id), item]));
  const currentEventByDraftId = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const key = String(event.shipmentDraftId);
    if (!currentEventByDraftId.has(key)) currentEventByDraftId.set(key, event);
  }

  const shipments = drafts.map((draft) => {
    const draftId = String(draft._id);
    const dpdShipment = dpdByDraftId.get(draftId);
    const shipmentInvoice = invoiceByDraftId.get(draftId);
    const currentEvent = currentEventByDraftId.get(draftId);
    const branch = branchById.get(String(draft.branchId));

    return {
      id: draftId,
      branchId: String(draft.branchId),
      invoiceNumber: "",
      shipmentReference: draft.parcelList?.find((parcel) => parcel.shipmentReference1?.trim())?.shipmentReference1 ?? "",
      swiftlineTrackingNumber: dpdShipment?.swiftlineTrackingNumber ?? "",
      destination: {
        companyName: draft.consigneeEnteredAddress?.companyName ?? "",
        contactName: draft.consigneeEnteredAddress?.contactName ?? "",
        townOrCity: draft.consigneeEnteredAddress?.townOrCity ?? "",
        postcode: draft.consigneeEnteredAddress?.postcode ?? "",
        countryName: draft.consigneeEnteredAddress?.countryName ?? "",
        countryCode: draft.consigneeEnteredAddress?.countryCode ?? ""
      },
      branch: {
        name: branch?.name ?? "",
        code: branch?.code ?? "",
        city: branch?.address?.city ?? ""
      },
      status: currentEvent?.status ?? dpdShipment?.status ?? draft.status ?? "",
      statusLabel: currentEvent
        ? formatShipmentEventLabel(currentEvent.status)
        : formatStatus(dpdShipment?.status ?? draft.status),
      dpdStatus: dpdShipment?.status ?? "",
      bookingState: draft.bookingState ?? "EDITABLE",
      /**
       * Whether to offer Delete on this row. Optimistic on purpose: it rules out
       * the states the list already knows about, and the delete endpoint re-runs
       * the full dependency check (manifest, pickup, reservation) and answers 409
       * with a reason if the row turns out not to be deletable after all.
       */
      canDelete: (draft.bookingState ?? "EDITABLE") === "EDITABLE"
        && !dpdShipment
        && !shipmentInvoice,
      shipmentInvoice: shipmentInvoice ? {
        invoiceNumber: shipmentInvoice.invoiceNumber,
        currency: shipmentInvoice.currency,
        chargeableAmountMinor: shipmentInvoice.totalAmountMinor,
        status: shipmentInvoice.status,
        revision: shipmentInvoice.revision
      } : null,
      createdAt: draft.createdAt ?? null,
      updatedAt: draft.updatedAt ?? null
    };
  });

  return response.status(200).json({
    success: true,
    shipments,
    pagination: { page, limit, total, totalPages }
  });
}

export async function downloadClientShipmentImportTemplate(request: Request, response: Response) {
  return downloadShipmentImportTemplate(request, response);
}

export async function createClientShipmentImportBatch(request: Request, response: Response) {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const branchId = typeof request.body.branchId === "string" ? request.body.branchId : "";
  const clientContext = await getActiveClientMembership(userId, branchId);
  if (!clientContext || !clientContext.account._id || !clientContext.branchId) {
    return response.status(403).json({ success: false, message: "No active business account branch is available for this client." });
  }
  if (!canCreateClientShipment(clientContext.membership.role)) return sendShipmentRoleError(response);
  const bookingAccess = getBookingAccess(clientContext.account);
  if (bookingAccess.state !== "READY") {
    return response.status(409).json({ success: false, code: bookingAccess.code, message: bookingAccess.message });
  }
  request.body.businessAccountId = String(clientContext.account._id);
  request.body.branchId = clientContext.branchId;
  return createShipmentImportBatch(request, response);
}

async function authorizeClientShipmentImport(request: Request, response: Response) {
  const userId = getAuthenticatedUserId(request);
  const batchId = String(request.params.batchId ?? "");
  if (!userId || !mongoose.Types.ObjectId.isValid(batchId)) {
    response.status(404).json({ success: false, message: "Shipment import batch not found." });
    return false;
  }
  const batch = await ShipmentImportBatch.findById(batchId).lean().exec();
  if (!batch || String(batch.uploadedBy) !== userId) {
    response.status(404).json({ success: false, message: "Shipment import batch not found." });
    return false;
  }
  const clientContext = await getActiveClientMembership(userId, String(batch.branchId));
  if (!clientContext || String(clientContext.account._id) !== String(batch.businessAccountId)) {
    response.status(404).json({ success: false, message: "Shipment import batch not found." });
    return false;
  }
  if (!canCreateClientShipment(clientContext.membership.role)) {
    sendShipmentRoleError(response);
    return false;
  }
  return true;
}

export async function getClientShipmentImportBatch(request: Request, response: Response) {
  if (!await authorizeClientShipmentImport(request, response)) return response;
  return getShipmentImportBatch(request, response);
}

export async function createClientShipmentImportDrafts(request: Request, response: Response) {
  if (!await authorizeClientShipmentImport(request, response)) return response;
  return createShipmentImportDrafts(request, response);
}

export async function createClientManualShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const branchId = typeof request.body.branchId === "string" ? request.body.branchId : "";
  const clientContext = await getActiveClientMembership(userId, branchId);

  if (!clientContext || !clientContext.account._id || !clientContext.branchId) {
    return response.status(403).json({
      success: false,
      message: "No active business account branch is available for this client."
    });
  }
  if (!canCreateClientShipment(clientContext.membership.role)) return sendShipmentRoleError(response);

  const bookingAccess = getBookingAccess(clientContext.account);
  if (bookingAccess.state !== "READY") {
    return response.status(409).json({
      success: false,
      code: bookingAccess.code,
      message: bookingAccess.message
    });
  }

  request.body.businessAccountId = String(clientContext.account._id);
  request.body.branchId = clientContext.branchId;
  return createManualShipmentDraft(request, response);
}

export async function getClientShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return getShipmentDraft(request, response);
}

export async function getClientShipmentDraftRateCardContext(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return getShipmentDraftRateCardContext(request, response);
}

export async function updateClientShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId, true)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return updateShipmentDraft(request, response);
}

export async function deleteClientShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId, true)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return deleteShipmentDraftHandler(request, response);
}

export async function deleteClientShipmentDrafts(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const shipmentDraftIds = Array.isArray(request.body?.shipmentDraftIds)
    ? request.body.shipmentDraftIds
    : [];
  if (
    shipmentDraftIds.length < 1
    || shipmentDraftIds.length > 100
    || shipmentDraftIds.some((id: unknown) => typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id))
    || new Set(shipmentDraftIds).size !== shipmentDraftIds.length
  ) {
    return response.status(400).json({ success: false, message: "Select valid shipment drafts." });
  }

  for (const draftId of shipmentDraftIds as string[]) {
    if (!await clientCanAccessDraft(userId, draftId, true)) {
      return response.status(404).json({ success: false, message: "One or more shipment drafts were not found." });
    }
  }

  return deleteShipmentDraftsHandler(request, response);
}

/**
 * Undo for the delete above. Access is not checked with `clientCanAccessDraft`
 * here because that helper hides deleted drafts by design; the restore service
 * runs the same membership check against the deleted record itself.
 */
export async function restoreClientShipmentDraft(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  return restoreShipmentDraftHandler(request, response);
}

/**
 * Prices the client's own draft. Access is checked here; the pricing itself is
 * the same handler the admin booking form uses, so both see identical figures.
 */
export async function getClientShipmentDraftCostEstimate(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId, true)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return getShipmentDraftCostEstimate(request, response);
}

export async function uploadClientShipmentKycDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  const accessible = Boolean(userId) && await clientCanAccessDraft(String(userId), draftId, true);

  if (!accessible) {
    // The upload is an in-memory buffer, so rejecting leaves nothing behind.
    return userId
      ? response.status(404).json({ success: false, message: "Shipment draft not found" })
      : response.status(401).json({ success: false, message: "Unauthorized" });
  }

  return uploadShipmentKycDocument(request, response);
}

export async function deleteClientShipmentKycDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId, true)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return deleteShipmentKycDocument(request, response);
}

export async function downloadClientShipmentKycDocument(request: Request, response: Response): Promise<Response | void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return downloadShipmentKycDocument(request, response);
}

export async function uploadClientShipmentParcelKycDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  const accessible = Boolean(userId) && await clientCanAccessDraft(String(userId), draftId, true);

  if (!accessible) {
    // The upload is an in-memory buffer, so rejecting leaves nothing behind.
    return userId
      ? response.status(404).json({ success: false, message: "Shipment draft not found" })
      : response.status(401).json({ success: false, message: "Unauthorized" });
  }

  return uploadShipmentParcelKycDocument(request, response);
}

export async function deleteClientShipmentParcelKycDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId, true)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return deleteShipmentParcelKycDocument(request, response);
}

export async function downloadClientShipmentParcelKycDocument(request: Request, response: Response): Promise<Response | void> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  return downloadShipmentParcelKycDocument(request, response);
}

function serializeClientDpdShipment(shipment: {
  _id: unknown;
  shipmentDraftId: unknown;
  idempotencyKey: string;
  dpdShipmentId?: string;
  dpdTransactionId?: string;
  forwardingNumber?: string;
  entryNumber?: string;
  swiftlineTrackingNumber?: string;
  parcelNumbers: string[];
  serviceCode: string;
  paymentSource: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: shipment._id,
    shipmentDraftId: shipment.shipmentDraftId,
    idempotencyKey: shipment.idempotencyKey,
    dpdShipmentId: shipment.dpdShipmentId ?? "",
    dpdTransactionId: shipment.dpdTransactionId ?? "",
    forwardingNumber: shipment.forwardingNumber ?? "",
    entryNumber: shipment.entryNumber ?? "",
    swiftlineTrackingNumber: shipment.swiftlineTrackingNumber ?? "",
    parcelNumbers: shipment.parcelNumbers,
    serviceCode: shipment.serviceCode,
    paymentSource: shipment.paymentSource,
    status: shipment.status,
    createdAt: shipment.createdAt,
    updatedAt: shipment.updatedAt
  };
}

function serializeClientLabel(label: {
  _id: unknown;
  dpdShipmentId: unknown;
  parcelNumber: string;
  labelType?: string;
  format: string;
  labelSize: string;
  fileChecksum: string;
  generatedAt: Date;
}) {
  return {
    id: label._id,
    dpdShipmentId: label.dpdShipmentId,
    parcelNumber: label.parcelNumber,
    labelType: label.labelType ?? "SWIFTLINE",
    format: label.format,
    labelSize: label.labelSize,
    fileChecksum: label.fileChecksum,
    generatedAt: label.generatedAt
  };
}

function serializeClientShipmentEvent(event: {
  _id: unknown;
  shipmentDraftId: unknown;
  dpdShipmentId?: unknown;
  status: string;
  holdReason?: string | null;
  note?: string;
  location?: string;
  customerVisible: boolean;
  eventAt: Date;
}, journey?: TrackingJourney) {
  return {
    id: String(event._id),
    shipmentDraftId: String(event.shipmentDraftId),
    dpdShipmentId: event.dpdShipmentId ? String(event.dpdShipmentId) : null,
    status: event.status,
    statusLabel: journey
      ? formatTrackingEventLabel(event.status, journey)
      : formatShipmentEventLabel(event.status),
    holdReason: event.holdReason ?? null,
    note: resolveShipmentEventNote(event.note, event.status),
    location: event.location ?? "",
    customerVisible: event.customerVisible,
    eventAt: event.eventAt
  };
}

async function ensureClientShipmentBookedEvent(params: {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  eventAt?: Date;
}) {
  await ShipmentEvent.findOneAndUpdate(
    {
      shipmentDraftId: params.shipmentDraftId,
      status: "SHIPMENT_BOOKED"
    },
    {
      $set: {
        dpdShipmentId: params.dpdShipmentId,
        customerVisible: true
      },
      $setOnInsert: {
        shipmentDraftId: params.shipmentDraftId,
        status: "SHIPMENT_BOOKED",
        note: "Shipment booked with carrier.",
        createdBy: params.userId,
        eventAt: params.eventAt ?? new Date()
      }
    },
    { upsert: true }
  ).exec();
}

function serializeClientShipmentDetails(params: {
  draft: IShipmentDraft;
  dpdShipment: {
    _id: unknown;
    shipmentDraftId: unknown;
    idempotencyKey: string;
    dpdShipmentId?: string;
    dpdTransactionId?: string;
    swiftlineTrackingNumber?: string;
    providerMode?: string;
    parcelNumbers: string[];
    serviceCode: string;
    paymentSource: string;
    status: string;
    bookingSnapshot?: unknown;
    currentShipmentSnapshot?: unknown;
    snapshotRevision?: number;
    createdAt?: Date;
    updatedAt?: Date;
  } | null;
  labels: Array<{
    _id: unknown;
    dpdShipmentId: unknown;
    parcelNumber: string;
    labelType?: string;
    providerMode?: string;
    format: string;
    labelSize: string;
    fileChecksum: string;
    generatedAt: Date;
    downloadCount: number;
    lastDownloadedAt?: Date | null;
  }>;
  events: Array<{
    _id: unknown;
    shipmentDraftId: unknown;
    dpdShipmentId?: unknown;
    status: string;
    holdReason?: string | null;
    note?: string;
    customerVisible: boolean;
    eventAt: Date;
  }>;
  currentInvoiceRevision?: number;
  currentInvoiceNumber?: string;
  journey?: TrackingJourney;
}) {
  const { draft, dpdShipment, labels, events, currentInvoiceRevision, currentInvoiceNumber, journey } = params;
  const currentEvent = events.find((event) => event.status !== "PARCEL_COLLECTED") ?? null;
  const originalBookingSnapshot = readShipmentBookingSnapshot(dpdShipment?.bookingSnapshot);
  const snapshotIsCurrent = (currentInvoiceRevision ?? 1) <= (dpdShipment?.snapshotRevision ?? 1);
  const currentShipmentSnapshot = snapshotIsCurrent
    ? readShipmentBookingSnapshot(dpdShipment?.currentShipmentSnapshot) ?? originalBookingSnapshot
    : null;
  const parcelList = currentShipmentSnapshot
    ? currentShipmentSnapshot.parcels.map((parcel) => ({
        ...(() => {
          const sourceParcel = draft.parcelList.find((draftParcel) => draftParcel.sequence === parcel.sequence);
          return { kycDocuments: serializeKycDocuments(sourceParcel?.kycDocuments) };
        })(),
        sequence: parcel.sequence,
        weightKg: parcel.actualWeightKg,
        lengthCm: typeof parcel.lengthCm === "number" ? parcel.lengthCm : null,
        widthCm: typeof parcel.widthCm === "number" ? parcel.widthCm : null,
        heightCm: typeof parcel.heightCm === "number" ? parcel.heightCm : null,
        shipmentContentType: typeof parcel.shipmentContentType === "string" ? parcel.shipmentContentType : "PARCEL",
        // Booked snapshots predate per-item capture, so items are rebuilt from
        // the description they did record.
        items: normalizeParcelItems({
          items: Array.isArray(parcel.items) ? parcel.items : null,
          contentsDescription: parcel.contentsDescription
        }),
        declaredGoodsValueMinor: typeof parcel.declaredGoodsValueMinor === "number"
          ? parcel.declaredGoodsValueMinor
          : null,
        contentsDescription: typeof parcel.contentsDescription === "string" ? parcel.contentsDescription : "",
        shipmentReference1: typeof parcel.reference === "string" ? parcel.reference : "",
        shipmentReference2: ""
      }))
    : draft.parcelList.map((parcel) => ({
        ...parcel,
        kycDocuments: serializeKycDocuments(parcel.kycDocuments)
      }));

  return {
    shipmentDraft: {
      id: String(draft._id),
      status: draft.status,
      statusLabel: formatStatus(draft.status),
      addressValidationStatus: draft.addressValidationStatus,
      serviceType: currentShipmentSnapshot?.service.type ?? draft.serviceType,
      serviceCode: currentShipmentSnapshot?.service.code ?? draft.serviceCode,
      kycUseForAllParcels: draft.kycUseForAllParcels,
      kycDocuments: serializeKycDocuments(draft.kycDocuments),
      // Shown on the shipment detail page and in the shipment list.
      csbType: normalizeCsbType(draft.csbType),
      parcelCount: parcelList.length,
      parcelList,
      consignee: currentShipmentSnapshot?.consignee ?? draft.consigneeEnteredAddress,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt
    },
    dpdShipment: dpdShipment
      ? serializeClientDpdShipment(dpdShipment)
      : null,
    bookingConfirmation: (currentInvoiceRevision ?? 1) === 1 && originalBookingSnapshot
      ? serializeShipmentBookingConfirmation(originalBookingSnapshot)
      : null,
    taxInvoiceNumber: currentInvoiceNumber ?? "",
    labels: labels.map(serializeClientLabel),
    currentEvent: currentEvent ? serializeClientShipmentEvent(currentEvent, journey) : null,
    events: normalizeVisibleTrackingHistory(events, journey)
      .map((event) => serializeClientShipmentEvent(event, journey)),
    trackingJourney: journey ?? null
  };
}

export async function getClientShipmentDetails(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  const draft = await ShipmentDraft.findById(draftId).exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment not found" });

  const dpdShipment = await DpdShipment.findOne({ shipmentDraftId: draft._id }).lean().exec();

  if (dpdShipment) {
    await ensureClientShipmentBookedEvent({
      shipmentDraftId: draft._id,
      dpdShipmentId: dpdShipment._id,
      userId: new mongoose.Types.ObjectId(userId),
      eventAt: dpdShipment.createdAt ?? draft.updatedAt ?? draft.createdAt
    });
  }

  const [labels, events, currentInvoice, originBranch, parcelActivities, parcelProgress] = await Promise.all([
    dpdShipment
      ? LabelDocument.find({
          dpdShipmentId: dpdShipment._id,
          labelVersion: dpdShipment.snapshotRevision || 1
        }).lean().exec()
      : Promise.resolve([]),
    ShipmentEvent.find({ shipmentDraftId: draft._id, customerVisible: true })
      .sort({ eventAt: -1, createdAt: -1 })
      .lean()
      .exec()
    ,
    ShipmentInvoice.findOne({ shipmentDraftId: draft._id }).select("invoiceNumber revision").lean().exec(),
    draft.branchId
      ? Branch.findById(draft.branchId).select("address.city").lean().exec()
      : Promise.resolve(null),
    loadShipmentParcelActivities(draft._id),
    loadShipmentParcelProgress(draft._id)
  ]);

  /**
   * The delivery estimate is computed here rather than stamped at booking.
   *
   * Nothing is stored, so a lane whose transit time Operations corrects is
   * reflected on every shipment still travelling it, and no backfill is needed
   * for shipments booked before routes existed. A lane with no route configured
   * yields null, and the tracking page shows no date rather than a guessed one.
   */
  const journey = await loadShipmentJourney({
    shipmentDraftId: draft._id,
    destinationCountryCode: draft.consigneeEnteredAddress?.countryCode ?? "",
    destinationCountryName: draft.consigneeEnteredAddress?.countryName ?? "",
    service: draft.serviceType === "CARGO" ? "CARGO" : "COURIER",
    events,
    originHubFallback: originBranch?.address?.city ? `${originBranch.address.city} Hub` : ""
  });
  const deliveryEstimate = await buildDeliveryEstimate({ draft, events });

  return response.status(200).json({
    success: true,
    shipment: {
      ...serializeClientShipmentDetails({
        draft,
        dpdShipment,
        labels,
        events,
        currentInvoiceRevision: currentInvoice?.revision ?? 1,
        currentInvoiceNumber: currentInvoice?.invoiceNumber ?? "",
        journey
      }),
      deliveryEstimate,
      trackingSummary: buildTrackingSummary({ draft, dpdShipment, events }),
      // What the customer has to do, if anything. Null on a shipment that is
      // simply moving, which is most of them.
      trackingAttention: buildTrackingAttention(events),
      // Client tracking receives only customer-safe parcel facts. Internal
      // offload reasons, flight identifiers and staff references stay in the
      // operations endpoint.
      parcelActivities: parcelActivities.map((activity) => ({
        parcelNumber: activity.parcelNumber,
        status: activity.status,
        eventAt: activity.eventAt,
        message: activity.customerMessage
      })),
      parcelProgress,
      trackingPosition: buildTrackingPosition({
        events: events.filter((event) => event.status !== "PARCEL_COLLECTED"),
        journey,
        destinationCity: draft.consigneeEnteredAddress?.townOrCity ?? "",
        audience: "AUTHENTICATED"
      })
    }
  });
}

export async function trackClientShipment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Sign in to track a shipment." });
  const trackingNumber = typeof request.params.trackingNumber === "string" ? request.params.trackingNumber.trim() : "";
  if (!trackingNumber || trackingNumber.length > 80) {
    return response.status(400).json({ success: false, message: "Enter a valid tracking number." });
  }

  const shipment = await resolveShipmentByTrackingNumber(trackingNumber);
  if (!shipment || !await clientCanAccessDraft(userId, String(shipment.shipmentDraftId))) {
    return response.status(404).json({ success: false, message: "No shipment was found for that tracking number." });
  }

  request.params.id = String(shipment.shipmentDraftId);
  return getClientShipmentDetails(request, response);
}

export async function createClientShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  return createShipmentAmendment(request, response, "client");
}

export async function previewClientShipmentAmendment(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found" });
  }

  return previewShipmentAmendment(request, response);
}

export async function getClientShipmentInvoice(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!userId || !await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment invoice not found" });
  }
  return getShipmentInvoice(request, response);
}

export async function downloadClientShipmentInvoicePdf(request: Request, response: Response): Promise<Response | void> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!userId || !await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment invoice not found" });
  }
  return downloadShipmentInvoicePdf(request, response);
}

// Document-only revised copies. Each wrapper re-checks that the caller's
// account owns the shipment before delegating to the shared handler. Clients
// can only read; creating, editing and deleting stay on the staff routes.
export async function listClientShipmentInvoiceRevisedDocuments(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!userId || !await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment invoice not found" });
  }
  return listShipmentInvoiceRevisedDocuments(request, response);
}

export async function getClientShipmentInvoiceRevisedDocument(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!userId || !await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment invoice not found" });
  }
  return getShipmentInvoiceRevisedDocument(request, response);
}

export async function downloadClientShipmentInvoiceRevisedDocumentPdf(request: Request, response: Response): Promise<Response | void> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!userId || !await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment invoice not found" });
  }
  return downloadShipmentInvoiceRevisedDocumentPdf(request, response);
}

// Customs ("shipment") invoice. Each wrapper re-checks that the caller's account
// owns the shipment before delegating to the shared handler.
async function guardClientDraft(request: Request, response: Response) {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!userId || !await clientCanAccessDraft(userId, draftId)) {
    response.status(404).json({ success: false, message: "Shipment invoice not found" });
    return false;
  }
  return true;
}

export async function getClientCustomsInvoice(request: Request, response: Response): Promise<Response | void> {
  if (!await guardClientDraft(request, response)) return;
  return getCustomsInvoice(request, response);
}

export async function downloadClientCustomsInvoicePdf(request: Request, response: Response): Promise<Response | void> {
  if (!await guardClientDraft(request, response)) return;
  return downloadCustomsInvoicePdf(request, response);
}

export async function downloadClientCustomsInvoiceWorkbook(request: Request, response: Response): Promise<Response | void> {
  if (!await guardClientDraft(request, response)) return;
  return downloadCustomsInvoiceWorkbook(request, response);
}

// The price the customer accepted, as returned by the cost estimate endpoint.
const clientAcceptedPricingSchema = z.object({
  acceptedPricingHash: z.string().trim().min(1).max(128).optional(),
  // Set only after the booker has been shown a DPD failure and chosen to go
  // ahead without the carrier label. Never defaulted true.
  skipDpdLabel: z.boolean().optional()
});

export async function createClientShipment(
  request: Request,
  response: Response
): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  const draftId = typeof request.params.id === "string" ? request.params.id : "";
  if (!await clientCanAccessDraft(userId, draftId, true)) {
    return response.status(404).json({ success: false, message: "Shipment draft not found" });
  }

  const acceptedPricing = clientAcceptedPricingSchema.safeParse(request.body ?? {});

  try {
    const result = await createLabelForShipmentDraft(
      draftId,
      new mongoose.Types.ObjectId(userId),
      {
        actor: "client",
        paymentSource: "BUSINESS_ACCOUNT",
        acceptedPricingHash: acceptedPricing.success ? acceptedPricing.data.acceptedPricingHash : undefined,
        skipDpdLabel: acceptedPricing.success ? acceptedPricing.data.skipDpdLabel : undefined
      }
    );
    await ensureClientShipmentBookedEvent({
      shipmentDraftId: new mongoose.Types.ObjectId(draftId),
      dpdShipmentId: result.dpdShipment._id as mongoose.Types.ObjectId,
      userId: new mongoose.Types.ObjectId(userId),
      eventAt: result.dpdShipment.createdAt
    });

    return response.status(result.reused ? 200 : 201).json({
      success: true,
      reused: result.reused,
      dpdShipment: serializeClientDpdShipment(result.dpdShipment),
      labels: result.labels.map(serializeClientLabel),
      bookingConfirmation: serializeShipmentBookingConfirmation(result.dpdShipment.bookingSnapshot),
      shipmentInvoice: {
        id: String(result.shipmentInvoice._id),
        invoiceNumber: result.shipmentInvoice.invoiceNumber,
        currency: result.shipmentInvoice.currency,
        totalAmountMinor: result.shipmentInvoice.totalAmountMinor,
        revision: result.shipmentInvoice.revision,
        status: result.shipmentInvoice.status
      }
    });
  } catch (error) {
    if (error instanceof RateCardRequiredError) {
      return response.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    }
    // The price moved between the estimate the customer accepted and this
    // booking. Nothing was reserved; the updated breakdown goes back so the panel
    // can show what changed and ask for an explicit re-accept.
    if (error instanceof ShipmentPriceChangedError) {
      return response.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
        pricing: error.currentPricing,
        pricingHash: buildPricingHash(error.currentPricing)
      });
    }

    // Nothing was booked, so the form can offer to continue without the
    // carrier label. The carrier's own wording is withheld from a customer.
    if (error instanceof DpdLabelUnavailableError) {
      return response.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }

    if (error instanceof DpdShipmentServiceError) {
      return response.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...error.details
      });
    }

    return response.status(502).json({
      success: false,
      message: "The shipment could not be created."
    });
  }
}

export async function createClientShipmentLabelAccess(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  const labelId = typeof request.params.labelId === "string" ? request.params.labelId : "";

  if (!userId || !mongoose.Types.ObjectId.isValid(labelId) || !await clientCanAccessDraft(userId, draftId)) {
    return response.status(404).json({ success: false, message: "Shipment label not found" });
  }

  const label = await LabelDocument.findById(labelId).select("dpdShipmentId").lean().exec();
  if (!label) return response.status(404).json({ success: false, message: "Shipment label not found" });

  const shipment = await DpdShipment.findOne({
    _id: label.dpdShipmentId,
    shipmentDraftId: new mongoose.Types.ObjectId(draftId)
  }).select("_id").lean().exec();
  if (!shipment) return response.status(404).json({ success: false, message: "Shipment label not found" });

  const access = await buildStoredLabelAccess({
    request,
    dpdShipmentId: String(shipment._id),
    labelId,
    userId: new mongoose.Types.ObjectId(userId),
    disposition: request.query.disposition === "attachment" ? "attachment" : "inline"
  });
  if (!access) return response.status(404).json({ success: false, message: "Shipment label not found" });

  return response.status(200).json({ success: true, ...access });
}
