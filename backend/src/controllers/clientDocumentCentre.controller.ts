import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import {
  clientDocumentTypeValues,
  listClientDocumentCentre
} from "../services/clientDocumentCentre.service.js";
import { resolveClientScope } from "../utils/clientScope.js";

const dateValue = /^\d{4}-\d{2}-\d{2}$/;
const querySchema = z.object({
  businessAccountId: z.string().trim().min(1),
  branchId: z.string().trim().optional(),
  documentType: z.enum(clientDocumentTypeValues).optional(),
  awb: z.string().trim().max(80).optional(),
  destination: z.string().trim().max(120).optional(),
  dateFrom: z.string().regex(dateValue, "Enter a valid start date.").optional(),
  dateTo: z.string().regex(dateValue, "Enter a valid end date.").optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
}).refine(
  (input) => !input.dateFrom || !input.dateTo || input.dateFrom <= input.dateTo,
  { message: "The end date must be on or after the start date.", path: ["dateTo"] }
);

export async function listClientDocuments(
  request: Request,
  response: Response,
  next: NextFunction
) {
  try {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return response.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Check the document filters."
      });
    }

    const scope = await resolveClientScope(request);
    if (!scope.ok) {
      return response.status(scope.status).json({ success: false, message: scope.message });
    }
    const authenticatedUserId = (request as Request & { user?: { _id?: unknown } }).user?._id;
    if (!authenticatedUserId || !mongoose.Types.ObjectId.isValid(String(authenticatedUserId))) {
      return response.status(401).json({ success: false, message: "Unauthorized" });
    }

    const result = await listClientDocumentCentre(scope, {
      documentType: parsed.data.documentType,
      awb: parsed.data.awb,
      destination: parsed.data.destination,
      dateFrom: parsed.data.dateFrom ? new Date(`${parsed.data.dateFrom}T00:00:00.000Z`) : undefined,
      dateTo: parsed.data.dateTo ? new Date(`${parsed.data.dateTo}T23:59:59.999Z`) : undefined,
      page: parsed.data.page,
      limit: parsed.data.limit
    }, new mongoose.Types.ObjectId(String(authenticatedUserId)));

    return response.status(200).json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
}
