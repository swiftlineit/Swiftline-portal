import type { Request, Response } from "express";
import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { deleteBookedShipment } from "../services/shipmentDraftDeletion.service.js";
import { ShipmentDraftPolicyError } from "../services/shipmentDraftPolicy.service.js";
import {
  allShipmentStatuses,
  bookedShipmentStatuses,
  listBookedShipments,
  summarizeBookedShipments
} from "../services/shipmentListing.service.js";
import {
  normalizeShipmentDestinationRegions,
  type ShipmentDestinationRegionCode
} from "../services/shipmentDestinationRegions.js";
import { dateRangeParams } from "../utils/dateRangeFilter.js";
import { shipmentExportColumns } from "../services/export/exportColumns.js";
import {
  describeFilters,
  exportFormat,
  listWindow,
  sendTableExport,
  type TableExportFormat
} from "../services/export/tableExportHttp.js";
import { allowedBranchIds } from "../middleware/branchAccess.middleware.js";

function staffBranchIds(request: Request, requested: mongoose.Types.ObjectId | null) {
  const allowed = allowedBranchIds(request);
  if (allowed === null) return requested ? [requested] : undefined;
  const ids = allowed.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
  if (!requested) return ids;
  return ids.some((id) => String(id) === String(requested)) ? [requested] : [];
}

function getUserId(request: Request) {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function objectIdParam(request: Request, key: string) {
  const value = typeof request.query[key] === "string" ? request.query[key] : "";
  return value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function destinationRegionsParam(request: Request): ShipmentDestinationRegionCode[] {
  const raw = request.query.destinationRegions;
  const values = Array.isArray(raw)
    ? raw.flatMap((value) => String(value).split(","))
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  return normalizeShipmentDestinationRegions(values);
}

function pagination(request: Request) {
  return {
    page: Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1),
    limit: Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "20"), 10) || 20))
  };
}

/**
 * Sends the shipment list as a file when one was asked for.
 *
 * Both audiences share it so the columns, the title and the filter caption are
 * identical whichever portal the export came from.
 */
function sendShipmentExport(
  request: Request,
  response: Response,
  format: TableExportFormat,
  shipments: unknown[],
  accountLabel: string
) {
  return sendTableExport(response, format, {
    title: "Shipments",
    columns: shipmentExportColumns,
    rows: shipments as never[],
    accountLabel,
    appliedFilters: describeFilters({
      Status: request.query.status,
      Search: request.query.search,
      From: request.query.dateFrom,
      To: request.query.dateTo,
      Rebooked: request.query.rebooked === "1" || request.query.rebooked === "true" ? "Yes" : undefined
    })
  });
}

export async function listAdminBookedShipments(request: Request, response: Response) {
  const businessAccountId = objectIdParam(request, "businessAccountId");
  const branchId = objectIdParam(request, "branchId");
  const format = exportFormat(request);

  const result = await listBookedShipments({
    ...(format ? listWindow(request, format) : pagination(request)),
    actorRole: "admin",
    status: typeof request.query.status === "string" ? request.query.status : "",
    attention: request.query.attention === "1" || request.query.attention === "true",
    bookedDate: typeof request.query.bookedDate === "string" ? request.query.bookedDate : "",
    rebookedOnly: request.query.rebooked === "1" || request.query.rebooked === "true",
    search: typeof request.query.search === "string" ? request.query.search.slice(0, 80) : "",
    sort: typeof request.query.sort === "string" ? request.query.sort : "",
    destinationRegions: destinationRegionsParam(request),
    ...dateRangeParams(request.query),
    businessAccountIds: businessAccountId ? [businessAccountId] : undefined,
    branchIds: staffBranchIds(request, branchId),
    // Staff see every booking that reached the carrier, so this table and the DPD
    // labels panel no longer disagree about which shipments exist.
    bookingStatuses: allShipmentStatuses
  });

  if (format) return sendShipmentExport(request, response, format, result.shipments, "Swiftline staff");
  return response.status(200).json({ success: true, ...result });
}

export async function summarizeAdminBookedShipments(request: Request, response: Response) {
  const businessAccountId = objectIdParam(request, "businessAccountId");
  const branchId = objectIdParam(request, "branchId");
  const summary = await summarizeBookedShipments({
    actorRole: "admin",
    businessAccountIds: businessAccountId ? [businessAccountId] : undefined,
    branchIds: staffBranchIds(request, branchId),
    bookingStatuses: allShipmentStatuses
  });

  return response.status(200).json({ success: true, ...summary });
}

/**
 * Removes a booked shipment from the staff and client lists. Admin only.
 *
 * Scoped to shipments that actually reached the carrier, which is exactly what
 * this router lists. An unbooked draft is sent back to the drafts endpoint
 * instead, so it keeps going through the deletion blockers there rather than
 * round the side of them.
 */
export async function deleteBookedShipmentHandler(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const draftId = typeof request.params.draftId === "string" ? request.params.draftId : "";
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    return response.status(404).json({ success: false, message: "Shipment not found." });
  }

  const draft = await ShipmentDraft.findOne({ _id: draftId, deletedAt: null }).exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment not found." });

  const booked = await DpdShipment.exists({ shipmentDraftId: draft._id });
  if (!booked) {
    return response.status(409).json({
      success: false,
      message: "This shipment has not been booked with the carrier. Delete it from the shipment drafts list instead."
    });
  }

  const portalRole = (request as Request & { user?: { role?: unknown } }).user?.role;
  try {
    await deleteBookedShipment({
      draft,
      userId,
      portalRole: typeof portalRole === "string" ? portalRole : ""
    });
  } catch (error) {
    if (error instanceof ShipmentDraftPolicyError) {
      return response.status(error.statusCode).json({ success: false, message: error.message });
    }
    throw error;
  }

  return response.status(200).json({
    success: true,
    message: "Shipment deleted.",
    shipmentDraftId: draftId
  });
}

export async function listClientBookedShipments(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const format = exportFormat(request);

  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount assignedBranches")
    .lean()
    .exec();
  if (!memberships.length) {
    return response.status(200).json({
      success: true,
      shipments: [],
      pagination: { page: 1, limit: pagination(request).limit, total: 0, totalPages: 1 }
    });
  }

  const requestedAccountId = objectIdParam(request, "businessAccountId");
  const allowedAccountIds = memberships.map((membership) => membership.businessAccount);
  if (requestedAccountId && !allowedAccountIds.some((id) => String(id) === String(requestedAccountId))) {
    return response.status(403).json({ success: false, message: "This business account is not available for your login." });
  }
  const businessAccountIds = requestedAccountId ? [requestedAccountId] : allowedAccountIds;

  // Members restricted to specific branches only see those branches. Members with
  // no explicit branches fall back to their account's assigned branch.
  const scoped = memberships.filter((membership) => businessAccountIds
    .some((id) => String(id) === String(membership.businessAccount)));
  const explicitBranchIds = scoped.flatMap((membership) => membership.assignedBranches ?? []);
  let branchIds = explicitBranchIds;
  if (!branchIds.length) {
    const accounts = await BusinessAccount.find({ _id: { $in: businessAccountIds } })
      .select("assignedBranch")
      .lean()
      .exec();
    branchIds = accounts.map((account) => account.assignedBranch).filter(Boolean) as typeof branchIds;
  }
  const requestedBranchId = objectIdParam(request, "branchId");
  if (requestedBranchId && !branchIds.some((id) => String(id) === String(requestedBranchId))) {
    return response.status(403).json({ success: false, message: "This branch is not assigned to your login." });
  }

  const result = await listBookedShipments({
    ...(format ? listWindow(request, format) : pagination(request)),
    actorRole: "client",
    status: typeof request.query.status === "string" ? request.query.status : "",
    attention: request.query.attention === "1" || request.query.attention === "true",
    rebookedOnly: request.query.rebooked === "1" || request.query.rebooked === "true",
    search: typeof request.query.search === "string" ? request.query.search.slice(0, 80) : "",
    sort: typeof request.query.sort === "string" ? request.query.sort : "",
    ...dateRangeParams(request.query),
    businessAccountIds,
    branchIds: requestedBranchId ? [requestedBranchId] : branchIds,
    // Customers only ever see shipments that completed. A booking still being
    // reconciled with the carrier is internal.
    bookingStatuses: bookedShipmentStatuses
  });

  if (format) {
    const label = result.shipments[0]?.businessAccountName ?? "";
    return sendShipmentExport(request, response, format, result.shipments, label);
  }
  return response.status(200).json({ success: true, ...result });
}
