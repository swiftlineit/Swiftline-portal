import type { Request, Response } from "express";
import mongoose from "mongoose";
import type { QueryFilter } from "mongoose";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { BusinessAccount, type IBusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditBillingStatement } from "../models/creditBillingStatement.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { OperatorContactQuery } from "../models/operatorContactQuery.model.js";
import { ShipmentAmendment } from "../models/shipmentAmendment.model.js";
import { ShipmentCancellation } from "../models/shipmentCancellation.model.js";
import { ShipmentDraft, type IShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentEvent } from "../models/shipmentEvent.model.js";
import { ShipmentInvoice, type IShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { Tenant } from "../models/tenant.model.js";
import { getCreditBalances, getMemberCreditPermissions } from "../services/creditAccount.service.js";
import { buildOperatorAccountAccessFilter } from "../services/operatorDirectory.service.js";

const recentLimit = 5;
const dayCount = 14;
const dayMs = 86_400_000;
const indiaOffsetMs = 19_800_000;
const inTransitStatuses = new Set(["IN_TRANSIT", "DESTINATION_ARRIVED", "OUT_FOR_DELIVERY"]);

function indiaDay(date: Date) {
  return new Date(date.getTime() + indiaOffsetMs).toISOString().slice(0, 10);
}

function accountName(account: { company?: { companyName?: string }; contact?: { firstName?: string; lastName?: string }; accountId?: string }) {
  return account.company?.companyName?.trim()
    || [account.contact?.firstName, account.contact?.lastName].filter(Boolean).join(" ").trim()
    || account.accountId || "Business account";
}

async function countInTransitShipments(filter: QueryFilter<IShipmentDraft>, tenantId: mongoose.Types.ObjectId, customerVisibleOnly: boolean) {
  const draftIds = await ShipmentDraft.distinct("_id", filter).exec() as mongoose.Types.ObjectId[];
  if (!draftIds.length) return 0;

  let count = 0;
  const batchSize = 750;
  for (let offset = 0; offset < draftIds.length; offset += batchSize) {
    const batch = draftIds.slice(offset, offset + batchSize);
    const latest = await ShipmentEvent.aggregate<{ _id: mongoose.Types.ObjectId; status: string }>([
      { $match: {
        tenantId,
        shipmentDraftId: { $in: batch },
        ...(customerVisibleOnly ? { customerVisible: true } : {})
      } },
      { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
      { $group: { _id: "$shipmentDraftId", status: { $first: "$status" } } }
    ]).exec();
    count += latest.filter((event) => inTransitStatuses.has(event.status)).length;
  }
  return count;
}

export async function getOperatorHome(request: Request, response: Response) {
  const context = getOperatorContext(request);
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  if (!context || !user?._id || !mongoose.Types.ObjectId.isValid(String(user._id))) {
    return response.status(401).json({ success: false, message: "Unauthorized" });
  }

  const tenantId = context.tenantId;
  const isClient = context.role === "CLIENT";
  const isFinance = context.role === "FINANCE";
  const isAdmin = context.role === "OPERATOR_ADMIN";
  const memberRows = isClient ? await BusinessAccountMember.find({
    tenantId, user: new mongoose.Types.ObjectId(String(user._id)), status: "active"
  }).select("businessAccount role creditPermissions").lean().exec() : [];
  const clientAccountIds = memberRows.map((member) => member.businessAccount);
  const financialAccountIds = memberRows
    .filter((member) => getMemberCreditPermissions(member.role, member.creditPermissions).includes("viewCreditDetails"))
    .map((member) => member.businessAccount);
  const accountFilter: QueryFilter<IBusinessAccount> = {
    tenantId,
    accountKind: { $ne: "INDIVIDUAL_SENTINEL" as const },
    ...buildOperatorAccountAccessFilter({
      role: context.role,
      assignedBranches: context.assignedBranches,
      clientAccountIds
    })
  };
  const branchOrAccountScope = isClient
    ? { businessAccountId: { $in: clientAccountIds } }
    : isAdmin ? {} : { branchId: { $in: context.assignedBranches } };
  const shipmentFilter: QueryFilter<IShipmentDraft> = {
    tenantId, deletedAt: null,
    bookingState: { $in: ["BOOKED", "REVIEW_REQUIRED"] as const },
    ...branchOrAccountScope
  };
  const now = new Date();
  const today = indiaDay(now);
  const todayStartUtc = new Date(`${today}T00:00:00.000Z`).getTime() - indiaOffsetMs;
  const todayEndUtc = todayStartUtc + dayMs;
  const indiaDate = new Date(now.getTime() + indiaOffsetMs);
  const monthStartUtc = Date.UTC(indiaDate.getUTCFullYear(), indiaDate.getUTCMonth(), 1) - indiaOffsetMs;
  const nextMonthStartUtc = Date.UTC(indiaDate.getUTCFullYear(), indiaDate.getUTCMonth() + 1, 1) - indiaOffsetMs;
  const firstDay = new Date(todayStartUtc - (dayCount - 1) * dayMs);
  const invoiceScopeFilter: QueryFilter<IShipmentInvoice> = {
    tenantId,
    paymentStatus: { $ne: "VOID" },
    ...(isClient
      ? { businessAccountId: { $in: clientAccountIds } }
      : isAdmin ? {} : { branchId: { $in: context.assignedBranches } })
  };
  const invoiceFilter: QueryFilter<IShipmentInvoice> = { ...invoiceScopeFilter, createdAt: { $gte: firstDay } };

  const [shipmentCount, recentDrafts, invoiceTrend, accountStatuses, bookedToday, bookedThisMonth, inTransit, tenant] = await Promise.all([
    ShipmentDraft.countDocuments(shipmentFilter).exec(),
    ShipmentDraft.find(shipmentFilter)
      .select("businessAccountId allocatedTrackingNumber consigneeEnteredAddress parcelCount updatedAt")
      .sort({ updatedAt: -1, _id: -1 }).limit(recentLimit).lean().exec(),
    ShipmentInvoice.aggregate<{ _id: string; count: number; amountMinor: number }>([
      { $match: invoiceFilter },
      { $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
        count: { $sum: 1 }, amountMinor: { $sum: "$totalAmountMinor" }
      } }
    ]).exec(),
    isClient ? Promise.resolve([]) : BusinessAccount.aggregate<{ _id: string; count: number }>([
      { $match: accountFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }
    ]).exec(),
    ShipmentInvoice.countDocuments({ ...invoiceScopeFilter, createdAt: { $gte: new Date(todayStartUtc), $lt: new Date(todayEndUtc) } }).exec(),
    ShipmentInvoice.countDocuments({ ...invoiceScopeFilter, createdAt: { $gte: new Date(monthStartUtc), $lt: new Date(nextMonthStartUtc) } }).exec(),
    isFinance ? Promise.resolve(0) : countInTransitShipments(shipmentFilter, tenantId, isClient),
    Tenant.findOne({ _id: tenantId, kind: "OPERATOR", status: "ACTIVE" }).select("slug branding.banners").lean().exec()
  ]);

  const recentIds = recentDrafts.map((draft) => draft._id);
  const recentAccountIds = [...new Set(recentDrafts.map((draft) => String(draft.businessAccountId)))].map((id) => new mongoose.Types.ObjectId(id));
  const [bookings, events, recentAccounts] = recentIds.length ? await Promise.all([
    DpdShipment.find({ tenantId, shipmentDraftId: { $in: recentIds } })
      .select("shipmentDraftId swiftlineTrackingNumber createdAt").lean().exec(),
    ShipmentEvent.aggregate<{ _id: mongoose.Types.ObjectId; status: string }>([
      { $match: {
        tenantId, shipmentDraftId: { $in: recentIds },
        ...(isClient ? { customerVisible: true } : {})
      } },
      { $sort: { shipmentDraftId: 1, eventAt: -1, createdAt: -1 } },
      { $group: { _id: "$shipmentDraftId", status: { $first: "$status" } } }
    ]).exec(),
    BusinessAccount.find({ tenantId, _id: { $in: recentAccountIds } })
      .select("company.companyName contact.firstName contact.lastName accountId").lean().exec()
  ]) : [[], [], []];
  const recentInvoices = recentIds.length ? await ShipmentInvoice.find({ tenantId, shipmentDraftId: { $in: recentIds }, paymentStatus: { $ne: "VOID" as const } })
    .select("shipmentDraftId totalAmountMinor currency createdAt")
    .lean().exec() : [];
  const bookingByDraft = new Map(bookings.map((row) => [String(row.shipmentDraftId), row]));
  const invoiceByDraft = new Map(recentInvoices.map((row) => [String(row.shipmentDraftId), row]));
  const eventByDraft = new Map(events.map((row) => [String(row._id), row.status]));
  const accountById = new Map(recentAccounts.map((row) => [String(row._id), row]));
  const recentShipments = recentDrafts.map((draft) => {
    const booking = bookingByDraft.get(String(draft._id));
    const invoice = invoiceByDraft.get(String(draft._id));
    const account = accountById.get(String(draft.businessAccountId));
    return {
      id: String(draft._id),
      awb: booking?.swiftlineTrackingNumber || draft.allocatedTrackingNumber || "—",
      accountName: account ? accountName(account) : "Business account",
      consignee: draft.consigneeEnteredAddress?.companyName || draft.consigneeEnteredAddress?.contactName || "—",
      destinationCountry: draft.consigneeEnteredAddress?.countryName || draft.consigneeEnteredAddress?.countryCode || "—",
      status: eventByDraft.get(String(draft._id)) || "SHIPMENT_BOOKED",
      parcelCount: draft.parcelCount,
      bookingAmountMinor: invoice?.totalAmountMinor ?? 0,
      currency: invoice?.currency || "INR",
      bookedAt: booking?.createdAt || invoice?.createdAt || null
    };
  });

  const trendByDay = new Map(invoiceTrend.map((row) => [row._id, row]));
  const trend = Array.from({ length: dayCount }, (_, index) => {
    const day = indiaDay(new Date(todayStartUtc + (index - dayCount + 1) * dayMs));
    const row = trendByDay.get(day);
    return { day, count: row?.count || 0, ...(!isClient ? { amountMinor: row?.amountMinor || 0 } : {}) };
  });

  if (isClient) {
    const creditAccounts = financialAccountIds.length
      ? await BusinessCreditAccount.find({ tenantId, businessAccountId: { $in: financialAccountIds } })
        .select("businessAccountId status validFrom validUntil approvedCreditLimitMinor reservedCreditMinor unbilledCreditMinor invoicedOutstandingMinor customerAdvanceBalanceMinor reservedAdvanceMinor")
        .lean().exec()
      : [];
    const credit = creditAccounts.reduce((sum, account) => {
      const balances = getCreditBalances(account, now);
      sum.availableCapacityMinor += balances.availableBookingCapacityMinor;
      sum.totalOwedMinor += balances.totalOwedMinor;
      sum.usedCreditMinor += balances.usedCreditMinor;
      sum.creditLimitMinor += account.approvedCreditLimitMinor;
      return sum;
    }, { availableCapacityMinor: 0, totalOwedMinor: 0, usedCreditMinor: 0, creditLimitMinor: 0 });
    return response.json({
      success: true, role: context.role, shipmentCount, bookedToday, bookedThisMonth, inTransit,
      banners: (tenant?.branding?.banners ?? []).map((banner) => ({
        id: String(banner._id), heading: banner.heading || "", description: banner.description || ""
      })),
      trend, recentShipments,
      credit: financialAccountIds.length ? credit : null
    });
  }

  if (isFinance) {
    const accountIds = await BusinessAccount.distinct("_id", accountFilter).exec() as mongoose.Types.ObjectId[];
    const creditRows = accountIds.length ? await BusinessCreditAccount.find({
      tenantId, businessAccountId: { $in: accountIds }
    }).select("businessAccountId status unbilledCreditMinor invoicedOutstandingMinor")
      .lean().exec() : [];
    const creditStatuses = creditRows.reduce<Record<string, number>>((result, row) => {
      result[row.status] = (result[row.status] || 0) + 1;
      return result;
    }, {});
    const outstandingMinor = creditRows.reduce((sum, row) => sum + row.unbilledCreditMinor + row.invoicedOutstandingMinor, 0);
    const overdue = accountIds.length ? await CreditBillingStatement.aggregate<{ _id: null; amountMinor: number; count: number }>([
      { $match: {
        tenantId, businessAccountId: { $in: accountIds }, dueAt: { $lt: now },
        outstandingAmountMinor: { $gt: 0 }, status: { $nin: ["PAID", "VOID"] }
      } },
      { $group: { _id: null, amountMinor: { $sum: "$outstandingAmountMinor" }, count: { $sum: 1 } } }
    ]).exec() : [];
    return response.json({
      success: true, role: context.role, shipmentCount, bookedToday, bookedThisMonth, inTransit,
      banners: (tenant?.branding?.banners ?? []).map((banner) => ({
        id: String(banner._id), heading: banner.heading || "", description: banner.description || ""
      })),
      trend, recentShipments,
      creditStatuses,
      finance: {
        activeCreditAccounts: creditStatuses.ACTIVE || 0,
        pendingCreditReviews: creditStatuses.PENDING_REVIEW || 0,
        outstandingMinor,
        overdueMinor: overdue[0]?.amountMinor || 0,
        overdueStatements: overdue[0]?.count || 0
      }
    });
  }

  const pendingAccountCount = accountStatuses.find((row) => row._id === "pending_review")?.count || 0;
  const pendingAccounts = await BusinessAccount.find({ ...accountFilter, status: "pending_review" })
    .select("company.companyName contact.firstName contact.lastName accountId createdAt")
    .sort({ createdAt: -1 }).limit(3).lean().exec();
  const changeScope = isAdmin ? {} : { branchId: { $in: context.assignedBranches } };
  const canReadQueries = context.accessMode === "MEMBER";
  const weekAgo = new Date(now.getTime() - 7 * dayMs);
  const [amendments, cancellations, queriesThisWeek, latestQueries] = await Promise.all([
    ShipmentAmendment.countDocuments({ tenantId, status: "REQUESTED", ...changeScope }).exec(),
    ShipmentCancellation.countDocuments({ tenantId, status: "REQUESTED", ...changeScope }).exec(),
    canReadQueries ? OperatorContactQuery.countDocuments({ tenantId, createdAt: { $gte: weekAgo } }).exec() : Promise.resolve(0),
    canReadQueries ? OperatorContactQuery.find({ tenantId }).select("subject businessAccountName kind createdAt")
      .sort({ createdAt: -1 }).limit(3).lean().exec() : Promise.resolve([])
  ]);
  return response.json({
    success: true, role: context.role, shipmentCount, bookedToday, bookedThisMonth, inTransit,
    banners: (tenant?.branding?.banners ?? []).map((banner) => ({
      id: String(banner._id), heading: banner.heading || "", description: banner.description || ""
    })),
    trend, recentShipments,
    accountStatuses: accountStatuses.map((row) => ({ status: row._id, count: row.count })),
    operations: {
      pendingAccountReviews: pendingAccountCount,
      pendingChanges: amendments + cancellations,
      pendingAmendments: amendments,
      pendingCancellations: cancellations,
      queriesThisWeek,
      pendingAccounts: pendingAccounts.map((account) => ({
        id: String(account._id), name: accountName(account), createdAt: account.createdAt
      })),
      latestQueries: latestQueries.map((query) => ({
        id: String(query._id), subject: query.subject,
        accountName: query.businessAccountName, kind: query.kind, createdAt: query.createdAt
      }))
    }
  });
}
