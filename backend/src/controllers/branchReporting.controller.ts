import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { PrepaidAccount } from "../models/prepaidAccount.model.js";
import {
  CounterPayment,
  counterPaymentMethodValues,
  type CounterPaymentMethod
} from "../models/counterPayment.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { User } from "../models/user.model.js";
import { normalizePortalRole } from "../utils/portalRole.js";

const INDIA_OFFSET = "+05:30";
const DAY_MS = 86_400_000;
const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDateOnly(value: string) {
  const match = dateOnlyPattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function indiaDateOnly(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export type BranchFinanceRange = {
  from: string;
  to: string;
  fromDate: Date;
  toExclusive: Date;
};

/** Date inputs are interpreted as whole India-local calendar days. */
export function resolveBranchFinanceRange(
  input: { from?: string; to?: string },
  now = new Date()
): BranchFinanceRange {
  const today = indiaDateOnly(now);
  const defaultFrom = `${today.slice(0, 7)}-01`;
  const from = input.from?.trim() || defaultFrom;
  const to = input.to?.trim() || today;

  if (!validDateOnly(from) || !validDateOnly(to)) {
    throw new Error("Select a valid reporting date range.");
  }

  const fromDate = new Date(`${from}T00:00:00${INDIA_OFFSET}`);
  const toStart = new Date(`${to}T00:00:00${INDIA_OFFSET}`);
  if (fromDate.getTime() > toStart.getTime()) {
    throw new Error("The reporting start date cannot be after the end date.");
  }

  return { from, to, fromDate, toExclusive: new Date(toStart.getTime() + DAY_MS) };
}

export function membershipAppliesToBranch(
  assignedBranches: readonly unknown[],
  accountBranchId: unknown,
  branchId: unknown
) {
  const explicit = assignedBranches.map(String).filter(Boolean);
  return explicit.length
    ? explicit.includes(String(branchId))
    : String(accountBranchId) === String(branchId);
}

function requestRole(request: Request) {
  return (request as Request & { user?: { role?: string } }).user?.role ?? "";
}

function displayName(user: { name?: string; firstName?: string; lastName?: string; email?: string }) {
  return user.name?.trim()
    || [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
    || user.email
    || "Unnamed user";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function getBranchFinanceSummary(request: Request, response: Response): Promise<Response> {
  const branchId = new mongoose.Types.ObjectId(String(request.params.branchId));
  let range: BranchFinanceRange;
  try {
    range = resolveBranchFinanceRange({
      from: typeof request.query.from === "string" ? request.query.from : undefined,
      to: typeof request.query.to === "string" ? request.query.to : undefined
    });
  } catch (error) {
    return response.status(400).json({
      success: false,
      message: error instanceof Error ? error.message : "Select a valid reporting date range."
    });
  }

  const branch = await Branch.findById(branchId).select("baseCurrency").lean().exec();
  if (!branch) return response.status(404).json({ success: false, message: "Branch not found" });

  const [individualAccount, businessAccounts] = await Promise.all([
    BusinessAccount.findOne({ accountKind: "INDIVIDUAL_SENTINEL" }).select("_id").lean().exec(),
    BusinessAccount.find({
      assignedBranch: branchId,
      accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
    })
      .select("accountId company.companyName")
      .sort({ "company.companyName": 1 })
      .lean()
      .exec()
  ]);

  const businessAccountIds = businessAccounts.map((account) => account._id);
  const invoiceDate = { $gte: range.fromDate, $lt: range.toExclusive };
  const validInvoice = {
    branchId,
    issuedAt: invoiceDate,
    status: "ISSUED" as const,
    paymentStatus: { $ne: "VOID" as const }
  };
  const businessInvoiceMatch: Record<string, unknown> = { ...validInvoice };
  if (individualAccount?._id) businessInvoiceMatch.businessAccountId = { $ne: individualAccount._id };

  const counterMatch = {
    branchId,
    recordedAt: { $gte: range.fromDate, $lt: range.toExclusive }
  };

  const [businessInvoiceRows, individualShipmentCount, prepaidAccounts, counterTotals, counterMethods, recentPayments] = await Promise.all([
    ShipmentInvoice.aggregate<{ shipments: number; invoicedMinor: number }>([
      { $match: businessInvoiceMatch },
      { $group: { _id: null, shipments: { $sum: 1 }, invoicedMinor: { $sum: "$totalAmountMinor" } } }
    ]).exec(),
    individualAccount?._id
      ? ShipmentInvoice.countDocuments({ ...validInvoice, businessAccountId: individualAccount._id }).exec()
      : Promise.resolve(0),
    PrepaidAccount.find({ businessAccountId: { $in: businessAccountIds } }).lean().exec(),
    CounterPayment.aggregate<{ collectedMinor: number; refundedMinor: number }>([
      { $match: counterMatch },
      {
        $group: {
          _id: null,
          collectedMinor: { $sum: { $cond: [{ $eq: ["$direction", "COLLECTED"] }, "$amountMinor", 0] } },
          refundedMinor: { $sum: { $cond: [{ $eq: ["$direction", "REFUNDED"] }, "$amountMinor", 0] } }
        }
      }
    ]).exec(),
    CounterPayment.aggregate<{ _id: CounterPaymentMethod; collectedMinor: number; refundedMinor: number }>([
      { $match: counterMatch },
      {
        $group: {
          _id: "$method",
          collectedMinor: { $sum: { $cond: [{ $eq: ["$direction", "COLLECTED"] }, "$amountMinor", 0] } },
          refundedMinor: { $sum: { $cond: [{ $eq: ["$direction", "REFUNDED"] }, "$amountMinor", 0] } }
        }
      }
    ]).exec(),
    CounterPayment.find(counterMatch)
      .populate("recordedBy", "name email")
      .sort({ recordedAt: -1 })
      .limit(5)
      .lean()
      .exec()
  ]);

  const accountById = new Map(businessAccounts.map((account) => [String(account._id), account]));
  const walletRows = prepaidAccounts.map((wallet) => {
    const account = accountById.get(String(wallet.businessAccountId));
    const availableBalanceMinor = wallet.status === "ACTIVE"
      ? Math.max(wallet.cashBalanceMinor - wallet.reservedBalanceMinor, 0)
      : 0;
    return {
      id: String(wallet._id),
      businessAccountId: String(wallet.businessAccountId),
      accountId: account?.accountId ?? "",
      companyName: account?.company?.companyName ?? account?.accountId ?? "",
      status: wallet.status,
      walletBalanceMinor: wallet.cashBalanceMinor,
      reservedBalanceMinor: wallet.reservedBalanceMinor,
      availableBalanceMinor
    };
  });

  const walletTotals = walletRows.reduce(
    (totals, wallet) => ({
      walletBalanceMinor: totals.walletBalanceMinor + wallet.walletBalanceMinor,
      reservedBalanceMinor: totals.reservedBalanceMinor + wallet.reservedBalanceMinor,
      availableBalanceMinor: totals.availableBalanceMinor + wallet.availableBalanceMinor
    }),
    { walletBalanceMinor: 0, reservedBalanceMinor: 0, availableBalanceMinor: 0 }
  );

  const recentDraftIds = recentPayments.map((payment) => payment.shipmentDraftId);
  const [recentDrafts, recentBookings] = await Promise.all([
    ShipmentDraft.find({ _id: { $in: recentDraftIds } })
      .select("consignorAddress.contactName consignorAddress.mobileNumber")
      .lean()
      .exec(),
    DpdShipment.find({ shipmentDraftId: { $in: recentDraftIds } })
      .select("shipmentDraftId swiftlineTrackingNumber")
      .lean()
      .exec()
  ]);
  const draftById = new Map(recentDrafts.map((draft) => [String(draft._id), draft]));
  const trackingByDraftId = new Map(recentBookings.map((booking) => [
    String(booking.shipmentDraftId),
    booking.swiftlineTrackingNumber ?? ""
  ]));
  const methodByName = new Map(counterMethods.map((method) => [method._id, method]));
  const payments = recentPayments.map((payment) => {
    const draft = draftById.get(String(payment.shipmentDraftId));
    const recorder = payment.recordedBy as unknown as { name?: string; email?: string } | null;
    return {
      id: String(payment._id),
      shipmentDraftId: String(payment.shipmentDraftId),
      trackingNumber: trackingByDraftId.get(String(payment.shipmentDraftId)) ?? "",
      customerName: draft?.consignorAddress?.contactName ?? "",
      customerMobile: draft?.consignorAddress?.mobileNumber ?? "",
      direction: payment.direction,
      amountMinor: payment.amountMinor,
      method: payment.method,
      reference: payment.reference,
      recordedBy: recorder?.name || recorder?.email || "",
      recordedAt: payment.recordedAt
    };
  });

  const businessInvoices = businessInvoiceRows[0];
  const individualMoney = counterTotals[0] ?? { collectedMinor: 0, refundedMinor: 0 };
  return response.status(200).json({
    success: true,
    period: { from: range.from, to: range.to },
    // Counter payments and prepaid accounts are stored in INR today.
    // Do not relabel them with a branch profile currency that may differ.
    currency: "INR",
    business: {
      shipments: numberValue(businessInvoices?.shipments),
      invoicedMinor: numberValue(businessInvoices?.invoicedMinor),
      linkedAccounts: businessAccounts.length,
      walletCount: walletRows.length,
      ...walletTotals,
      wallets: walletRows
    },
    individual: {
      shipments: individualShipmentCount,
      collectedMinor: individualMoney.collectedMinor,
      refundedMinor: individualMoney.refundedMinor,
      netMinor: individualMoney.collectedMinor - individualMoney.refundedMinor,
      methods: counterPaymentMethodValues.map((method) => {
        const totals = methodByName.get(method);
        const collectedMinor = totals?.collectedMinor ?? 0;
        const refundedMinor = totals?.refundedMinor ?? 0;
        return { method, collectedMinor, refundedMinor, netMinor: collectedMinor - refundedMinor };
      }),
      recentPayments: payments
    }
  });
}

export async function getBranchUsers(request: Request, response: Response): Promise<Response> {
  const branchId = new mongoose.Types.ObjectId(String(request.params.branchId));
  const actorRole = requestRole(request);

  const internalPromise = User.find({
    $or: [
      { role: "admin" },
      {
        role: { $in: ["operations", "finance", "delivery", "hr"] },
        assignedBranches: branchId
      }
    ]
  })
    .select("name firstName lastName email phone role userStatus lastLogin staffProfile.designation")
    .lean()
    .exec();

  const accountPromise = actorRole === "hr"
    ? Promise.resolve([])
    : BusinessAccount.find({
        assignedBranch: branchId,
        accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
      })
        .select("accountId company.companyName assignedBranch")
        .lean()
        .exec();

  const [internalUsers, accounts] = await Promise.all([internalPromise, accountPromise]);
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));
  const memberships = accounts.length
    ? await BusinessAccountMember.find({
        businessAccount: { $in: accounts.map((account) => account._id) },
        status: { $ne: "removed" }
      })
        .select("businessAccount user role assignedBranches status")
        .lean()
        .exec()
    : [];
  const clientUsers = memberships.length
    ? await User.find({ _id: { $in: memberships.map((membership) => membership.user) } })
        .select("name firstName lastName email phone userStatus lastLogin")
        .lean()
        .exec()
    : [];
  const clientById = new Map(clientUsers.map((user) => [String(user._id), user]));

  const internalRows = internalUsers.map((user) => {
    const role = normalizePortalRole(user.role);
    return {
      id: String(user._id),
      userId: String(user._id),
      name: displayName(user),
      email: user.email,
      phone: user.phone ?? "",
      kind: role === "admin" ? "ADMINISTRATOR" : "INTERNAL_STAFF",
      role,
      organization: user.staffProfile?.designation ?? "Swiftline",
      branchAccess: role === "admin" ? "GLOBAL" : "ASSIGNED",
      accessStatus: user.userStatus,
      loginStatus: user.userStatus,
      lastLogin: user.lastLogin ?? null,
      detailId: String(user._id)
    };
  });

  const businessRows = memberships.flatMap((membership) => {
    const account = accountById.get(String(membership.businessAccount));
    const user = clientById.get(String(membership.user));
    if (!account || !user || !membershipAppliesToBranch(membership.assignedBranches ?? [], account.assignedBranch, branchId)) {
      return [];
    }
    return [{
      id: String(membership._id),
      userId: String(user._id),
      name: displayName(user),
      email: user.email,
      phone: user.phone ?? "",
      kind: "BUSINESS_ACCOUNT",
      role: membership.role,
      organization: account.company?.companyName ?? account.accountId,
      accountId: account.accountId,
      branchAccess: (membership.assignedBranches ?? []).length ? "ASSIGNED" : "INHERITED",
      accessStatus: membership.status,
      loginStatus: user.userStatus,
      lastLogin: user.lastLogin ?? null,
      detailId: account.accountId
    }];
  });

  const users = [...internalRows, ...businessRows].sort((left, right) => left.name.localeCompare(right.name));
  const active = users.filter((user) => user.accessStatus === "active" && user.loginStatus === "active").length;

  return response.status(200).json({
    success: true,
    users,
    totals: {
      all: users.length,
      businessAccounts: users.filter((user) => user.kind === "BUSINESS_ACCOUNT").length,
      internalStaff: users.filter((user) => user.kind === "INTERNAL_STAFF").length,
      administrators: users.filter((user) => user.kind === "ADMINISTRATOR").length,
      active,
      inactive: users.length - active
    }
  });
}
