import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { serializeCreditAccount } from "../services/creditAccount.service.js";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional()
}).strict();

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildOperatorCreditListFilter(input: {
  tenantId: mongoose.Types.ObjectId;
  role: "OPERATOR_ADMIN" | "OPERATIONS" | "FINANCE" | "CLIENT";
  assignedBranches: readonly mongoose.Types.ObjectId[];
  search?: string;
}) {
  const clauses: Record<string, unknown>[] = [
    { tenantId: input.tenantId },
    { accountKind: { $ne: "INDIVIDUAL_SENTINEL" } },
    { status: { $in: ["approved", "active"] } }
  ];
  if (input.role !== "OPERATOR_ADMIN") {
    clauses.push({ assignedBranch: { $in: input.assignedBranches } });
  }
  if (input.search) {
    const pattern = new RegExp(escapeRegExp(input.search), "i");
    clauses.push({ $or: [
      { accountId: pattern },
      { "company.companyName": pattern }
    ] });
  }
  return { $and: clauses };
}

export async function listOperatorCreditAccounts(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  if (!context || context.role === "CLIENT") {
    return response.status(403).json({ success: false, message: "Operator credit access is not available." });
  }
  const parsed = listQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return response.status(400).json({ success: false, message: "Invalid credit account filters.", errors: parsed.error.flatten() });
  }

  const query = buildOperatorCreditListFilter({
    tenantId: context.tenantId,
    role: context.role,
    assignedBranches: context.assignedBranches,
    search: parsed.data.search || undefined
  });
  const skip = (parsed.data.page - 1) * parsed.data.pageSize;
  const [total, businesses] = await Promise.all([
    BusinessAccount.countDocuments(query).exec(),
    BusinessAccount.find(query)
      .select("accountId status company.companyName assignedBranch updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(parsed.data.pageSize)
      .lean()
      .exec()
  ]);
  const businessIds = businesses.map((business) => business._id as mongoose.Types.ObjectId);
  const creditAccounts = await BusinessCreditAccount.find({
    tenantId: context.tenantId,
    businessAccountId: { $in: businessIds }
  }).exec();
  const creditByBusinessId = new Map(creditAccounts.map((account) => [String(account.businessAccountId), account]));
  const results = businesses.map((business) => {
    const creditAccount = creditByBusinessId.get(String(business._id));
    return {
      businessAccount: {
        id: String(business._id),
        accountId: business.accountId,
        companyName: business.company?.companyName || business.accountId,
        status: business.status,
        branchId: business.assignedBranch ? String(business.assignedBranch) : null
      },
      creditAccount: creditAccount
        ? serializeCreditAccount(creditAccount)
        : {
            id: "",
            businessAccountId: String(business._id),
            status: "NOT_REQUESTED",
            currency: "INR",
            requestedCreditLimitMinor: 0,
            approvedCreditLimitMinor: 0,
            usedCreditMinor: 0,
            reservedCreditMinor: 0,
            unbilledCreditMinor: 0,
            invoicedOutstandingMinor: 0,
            totalOwedMinor: 0,
            availableCreditMinor: 0,
            availableAdvanceMinor: 0,
            availableBookingCapacityMinor: 0,
            paymentTermsDays: 30,
            billingCycle: "MONTHLY"
          }
    };
  });

  return response.status(200).json({
    success: true,
    creditAccounts: results,
    pagination: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      totalPages: Math.ceil(total / parsed.data.pageSize)
    }
  });
}
