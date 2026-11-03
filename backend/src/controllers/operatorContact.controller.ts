import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { OperatorContactQuery, type IOperatorContactQuery } from "../models/operatorContactQuery.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { notifyPortalUsers } from "../services/portalNotification.service.js";

const submissionSchema = z.object({
  kind: z.enum(["ISSUE", "HELP"]),
  subject: z.string().trim().min(5).max(120).refine((value) => !/[\r\n]/.test(value)),
  message: z.string().trim().min(10).max(3000),
  contactName: z.string().trim().min(2).max(160),
  contactEmail: z.email().max(320).toLowerCase(),
  contactPhone: z.string().trim().max(30).default(""),
  awbNumbers: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{5,40}$/)).max(5).default([])
}).strict();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  search: z.string().trim().max(80).default("")
}).strict();
const pageSize = 20;

function userIdFromRequest(request: Request): mongoose.Types.ObjectId | null {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value)) : null;
}

function serializeQuery(query: IOperatorContactQuery, detail = false) {
  return {
    id: String(query._id),
    kind: query.kind,
    subject: query.subject,
    contactName: query.contactName,
    contactEmail: query.contactEmail,
    contactPhone: query.contactPhone,
    businessAccountName: query.businessAccountName,
    awbNumbers: query.awbNumbers,
    createdAt: query.createdAt,
    ...(detail ? { message: query.message } : {})
  };
}

/** Clients submit to the operator owning their active business-account membership. */
export async function submitOperatorContactQuery(request: Request, response: Response): Promise<Response> {
  const context = getOperatorContext(request);
  const userId = userIdFromRequest(request);
  if (!context || !userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = submissionSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Check the contact details, message and AWB numbers." });
  const data = parsed.data;
  const awbNumbers = [...new Set(data.awbNumbers)];

  const membership = await BusinessAccountMember.findOne({ user: userId, status: "active" })
    .select("businessAccount").lean().exec();
  if (!membership) return response.status(403).json({ success: false, message: "An active business account is required to contact this operator." });
  const account = await BusinessAccount.findById(membership.businessAccount)
    .select("accountId company.companyName contact.firstName contact.lastName").lean().exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found." });

  const recentCount = await OperatorContactQuery.countDocuments({
    submittedBy: userId,
    createdAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) }
  });
  if (recentCount >= 5) return response.status(429).json({ success: false, message: "Too many requests. Please try again in 15 minutes." });

  const businessAccountName = account.company?.companyName
    || [account.contact?.firstName, account.contact?.lastName].filter(Boolean).join(" ")
    || account.accountId;
  const session = await mongoose.startSession();
  let query: IOperatorContactQuery;
  try {
    const created = await session.withTransaction(async () => {
      const [record] = await OperatorContactQuery.create([{
        businessAccountId: account._id,
        businessAccountName,
        submittedBy: userId,
        kind: data.kind,
        subject: data.subject,
        message: data.message,
        contactName: data.contactName,
        contactEmail: data.contactEmail,
        contactPhone: data.contactPhone,
        awbNumbers
      }], { session });
      if (!record) throw new Error("OPERATOR_CONTACT_QUERY_NOT_CREATED");
      await AuditLog.create([{
        action: "OPERATOR_CONTACT_QUERY_SUBMITTED",
        entityType: "TENANT",
        entityId: context.tenantId,
        performedBy: userId,
        performedAt: new Date(),
        metadata: { queryId: String(record._id), businessAccountId: String(account._id), kind: data.kind, awbCount: awbNumbers.length }
      }], { session });
      return record;
    });
    if (!created) throw new Error("OPERATOR_CONTACT_QUERY_NOT_CREATED");
    query = created;
  } finally {
    await session.endSession();
  }

  try {
    const memberships = await TenantMembership.find({
      tenantId: context.tenantId,
      status: "ACTIVE",
      role: { $in: ["OPERATOR_ADMIN", "OPERATIONS"] }
    }).select("userId").lean().exec();
    const staffIds = memberships.map((member) => member.userId);
    const activeStaff = await User.find({ _id: { $in: staffIds }, userStatus: "active" }).select("_id").lean().exec();
    const href = `/portal/${encodeURIComponent(context.slug)}/queries/${String(query._id)}`;
    await notifyPortalUsers(activeStaff.map((staff) => staff._id), {
      type: "OPERATOR_CONTACT_QUERY_SUBMITTED",
      title: data.kind === "ISSUE" ? "New client issue" : "New client help request",
      message: `${businessAccountName} · ${data.contactName}: ${data.subject}`,
      href,
      idempotencyKey: `OPERATOR_CONTACT_QUERY:${String(query._id)}`,
      businessAccountId: account._id as mongoose.Types.ObjectId,
      metadata: { queryId: query._id, businessAccountId: account._id },
      email: {
        templateKey: "OPERATOR_CONTACT_QUERY_STAFF",
        payload: {
          kind: data.kind, subject: data.subject, message: data.message,
          contactName: data.contactName, contactEmail: data.contactEmail,
          contactPhone: data.contactPhone, businessAccountName, awbNumbers, href
        }
      }
    });
  } catch (error) {
    console.error("Operator contact query notification failed.", {
      queryId: String(query._id),
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
  return response.status(201).json({ success: true, query: serializeQuery(query) });
}

/** The query inbox belongs to operator admin and operations staff only. */
export async function listOperatorContactQueries(request: Request, response: Response): Promise<Response> {
  const parsed = listSchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid query filters." });
  const { page, search } = parsed.data;
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = escaped ? { $or: [
    { subject: { $regex: escaped, $options: "i" } },
    { contactName: { $regex: escaped, $options: "i" } },
    { contactEmail: { $regex: escaped, $options: "i" } },
    { businessAccountName: { $regex: escaped, $options: "i" } },
    { awbNumbers: { $regex: escaped.toUpperCase() } }
  ] } : {};
  const [queries, total] = await Promise.all([
    OperatorContactQuery.find(filter).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize).limit(pageSize).exec(),
    OperatorContactQuery.countDocuments(filter)
  ]);
  return response.json({
    success: true,
    queries: queries.map((query) => serializeQuery(query)),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) }
  });
}

export async function getOperatorContactQuery(request: Request, response: Response): Promise<Response> {
  const queryId = typeof request.params.queryId === "string" ? request.params.queryId : "";
  if (!mongoose.Types.ObjectId.isValid(queryId)) return response.status(404).json({ success: false, message: "Query not found." });
  const query = await OperatorContactQuery.findById(queryId).exec();
  if (!query) return response.status(404).json({ success: false, message: "Query not found." });
  return response.json({ success: true, query: serializeQuery(query, true) });
}
