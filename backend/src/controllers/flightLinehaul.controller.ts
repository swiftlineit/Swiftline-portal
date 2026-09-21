import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { FlightLinehaul } from "../models/flightLinehaul.model.js";
import { FlightDocument } from "../models/flightDocument.model.js";
import { flightBranchIds } from "../middleware/flightLinehaulBranchAccess.middleware.js";
import * as service from "../services/flightLinehaul.service.js";
import { streamObjectToResponse } from "../services/storage/storage.service.js";

function userId(request: Request) {
  const id = String((request as Request & { user?: { _id?: unknown } }).user?._id ?? "");
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function parsedBody<T>(response: Response, schema: z.ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  response.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? "Check the entered details." });
  return null;
}

function sendError(response: Response, error: unknown) {
  if (error instanceof service.FlightLinehaulServiceError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
    return response.status(409).json({ success: false, message: "Duplicate operation detected. Refresh and try again." });
  }
  throw error;
}

const createSchema = z.object({
  branchId: z.string().min(1),
  flightNumber: z.string().trim().min(2).max(20),
  airlineName: z.string().trim().min(2).max(120),
  mawbNumber: z.string().trim().regex(/^\d{3}-?\d{8}$/, "Enter a valid MAWB (e.g., 098-12345678)."),
  originIataCode: z.string().trim().regex(/^[A-Za-z]{3}$/, "Origin IATA must be 3 letters."),
  destinationIataCode: z.string().trim().regex(/^[A-Za-z]{3}$/, "Destination IATA must be 3 letters."),
  transitIataCode: z.string().trim().max(3).optional().default(""),
  scheduledDepartureAt: z.string().min(1),
  scheduledArrivalAt: z.string().min(1),
  capacityKg: z.coerce.number().positive().max(100000),
  destinationAgent: z.string().trim().max(1000).optional().default(""),
  finalMileCarrier: z.string().trim().max(200).optional().default(""),
  manifestId: z.string().trim().min(1, "Select a dispatched operations manifest."),
  connection: z
    .object({
      transitAirportCode: z.string().trim().max(3).optional().default(""),
      scheduledArrivalAt: z.string().optional().nullable(),
      scheduledDepartureAt: z.string().optional().nullable()
    })
    .optional()
    .nullable()
});

export async function createFlight(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, createSchema, request.body);
    if (!input) return;
    const payload: Parameters<typeof service.createFlightLinehaul>[0] = {
      branchId: input.branchId,
      flightNumber: input.flightNumber,
      airlineName: input.airlineName,
      mawbNumber: input.mawbNumber,
      originIataCode: input.originIataCode,
      destinationIataCode: input.destinationIataCode,
      transitIataCode: input.transitIataCode,
      scheduledDepartureAt: input.scheduledDepartureAt,
      scheduledArrivalAt: input.scheduledArrivalAt,
      capacityKg: input.capacityKg,
      destinationAgent: input.destinationAgent,
      finalMileCarrier: input.finalMileCarrier,
      manifestId: input.manifestId,
      connection: input.connection as never,
      userId: actorId
    };
    const flight = await service.createFlightLinehaul(payload);
    return response.status(201).json({ success: true, message: "Flight created and manifest attached.", flightId: String((flight as unknown as { _id: unknown })._id), flightLinehaulNumber: (flight as unknown as { flightLinehaulNumber: string }).flightLinehaulNumber });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function listFlights(request: Request, response: Response) {
  try {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(15),
        status: z.string().optional(),
        branchId: z.string().optional(),
        search: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional()
      })
      .safeParse(request.query);
    if (!query.success) return response.status(400).json({ success: false, message: "Flight filters are invalid." });
    const allowedBranchIds = flightBranchIds(request);
    if (query.data.branchId && allowedBranchIds !== null && !allowedBranchIds.includes(query.data.branchId)) {
      return response.status(403).json({ success: false, message: "You do not have access to this branch." });
    }
    const result = await service.listFlightLinehauls({ ...query.data, allowedBranchIds });
    return response.json({ success: true, ...result });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function getFlightSummary(request: Request, response: Response) {
  try {
    const allowedBranchIds = flightBranchIds(request);
    const result = await service.getFlightLinehaulSummary({ allowedBranchIds });
    return response.json({ success: true, ...result });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function getFlight(request: Request, response: Response) {
  try {
    const allowedBranchIds = flightBranchIds(request);
    const result = await service.getFlightLinehaulDetail(String(request.params.flightId), { allowedBranchIds });
    return response.json({ success: true, ...result });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function updateFlight(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(
      response,
      z.object({
        airlineName: z.string().trim().max(120).optional(),
        mawbNumber: z.string().trim().max(40).optional(),
        originIataCode: z.string().trim().max(3).optional(),
        destinationIataCode: z.string().trim().max(3).optional(),
        transitIataCode: z.string().trim().max(3).optional(),
        scheduledDepartureAt: z.string().optional(),
        scheduledArrivalAt: z.string().optional(),
        capacityKg: z.coerce.number().positive().max(100000).optional(),
        destinationAgent: z.string().trim().max(1000).optional(),
        finalMileCarrier: z.string().trim().max(200).optional()
      }),
      request.body
    );
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const flight = await service.updateFlightLinehaul({ flightId: String(request.params.flightId), updates: input, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Flight updated.", flight });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function transitionStatus(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(
      response,
      z.object({
        toStatus: z.enum([
          "PLANNED",
          "BOOKING_CONFIRMED",
          "CARGO_ALLOCATED",
          "MANIFEST_READY",
          "HANDED_TO_AIRLINE",
          "DEPARTED",
          "IN_TRANSIT",
          "CONNECTION",
          "ARRIVED_DESTINATION",
          "CUSTOMS",
          "HANDED_TO_FINAL_MILE",
          "CLOSED",
          "CANCELLED"
        ]),
        reason: z.string().trim().max(500).optional().default(""),
        metadata: z.record(z.string(), z.unknown()).optional().default({})
      }),
      request.body
    );
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    if (input.toStatus === "CANCELLED") {
      if (!input.reason || input.reason.trim().length < 5) return response.status(400).json({ success: false, message: "Cancellation reason must be at least 5 characters." });
      const flight = await service.cancelFlightLinehaul({ flightId: String(request.params.flightId), reason: input.reason, userId: actorId, allowedBranchIds });
      return response.json({ success: true, message: "Flight cancelled.", flight });
    }
    const flight = await service.transitionFlightStatus({ flightId: String(request.params.flightId), toStatus: input.toStatus as never, reason: input.reason, metadata: input.metadata, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: `Flight moved to ${input.toStatus}.`, flight });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function cancelFlight(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, z.object({ reason: z.string().trim().min(5).max(500) }), request.body);
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const flight = await service.cancelFlightLinehaul({ flightId: String(request.params.flightId), reason: input.reason, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Flight cancelled.", flight });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function searchEligibleShipments(request: Request, response: Response) {
  try {
    const query = z
      .object({
        q: z.string().optional(),
        branchId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        excludeFlightId: z.string().optional()
      })
      .safeParse(request.query);
    if (!query.success) return response.status(400).json({ success: false, message: "Search filters invalid." });
    const allowedBranchIds = flightBranchIds(request);
    const result = await service.searchEligibleShipments({ ...query.data, allowedBranchIds });
    return response.json({ success: true, ...result });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function allocateShipments(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, z.object({ shipmentDraftIds: z.array(z.string().min(1)).min(1).max(100) }), request.body);
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const result = await service.allocateShipments({ flightId: String(request.params.flightId), shipmentDraftIds: input.shipmentDraftIds, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: `${result.allocatedCount} shipment(s) allocated.`, ...result });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function removeAllocation(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, z.object({ reason: z.string().trim().min(3).max(500) }), request.body);
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    await service.removeAllocation({ flightId: String(request.params.flightId), allocationId: String(request.params.allocationId), reason: input.reason, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Allocation removed." });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function moveAllocation(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, z.object({ targetFlightId: z.string().min(1), reason: z.string().trim().min(3).max(500) }), request.body);
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    await service.moveAllocation({ sourceFlightId: String(request.params.flightId), allocationId: String(request.params.allocationId), targetFlightId: input.targetFlightId, reason: input.reason, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Shipment moved to target flight." });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function attachManifest(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, z.object({ manifestId: z.string().min(1) }), request.body);
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const manifest = await service.attachManifest({ flightId: String(request.params.flightId), manifestId: input.manifestId, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: `${manifest.manifestNumber} attached.`, manifest });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function detachManifest(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, z.object({ reason: z.string().trim().max(500).optional().default("") }), request.body ?? {});
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    await service.detachManifest({ flightId: String(request.params.flightId), manifestId: String(request.params.manifestId), reason: input.reason, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Manifest detached." });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function listAttachableManifests(request: Request, response: Response) {
  try {
    const allowedBranchIds = flightBranchIds(request);
    const manifests = await service.listAttachableManifests({ flightId: String(request.params.flightId), allowedBranchIds });
    return response.json({ success: true, manifests });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function updateConnection(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(
      response,
      z.object({
        transitAirportCode: z.string().trim().min(3).max(3),
        scheduledArrivalAt: z.string().optional().nullable(),
        scheduledDepartureAt: z.string().optional().nullable(),
        actualArrivalAt: z.string().optional().nullable(),
        actualDepartureAt: z.string().optional().nullable()
      }),
      request.body
    );
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const flight = await service.updateConnection({ flightId: String(request.params.flightId), ...input, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Connection updated.", flight });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function createOffload(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(
      response,
      z.object({
        reason: z.string().trim().min(5).max(1000),
        offloadReason: z.enum(["AIRLINE_OFFLOAD", "CAPACITY", "WEATHER", "CUSTOMS", "MISSED_CONNECTION", "DAMAGE", "SECURITY", "OTHER"]),
        airline: z.string().trim().max(120).optional().default(""),
        affectedParcels: z.array(z.object({
          shipmentDraftId: z.string().trim().min(1),
          parcelNumber: z.string().trim().min(1).max(80)
        })).min(1).max(100),
        responsibleEmployeeId: z.string().optional().nullable()
      }),
      request.body
    );
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const offload = await service.createOffload({ flightId: String(request.params.flightId), ...input, userId: actorId, allowedBranchIds });
    return response.status(201).json({ success: true, message: "Offload recorded.", offload });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function updateHandover(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(
      response,
      z.object({
        arrivalAt: z.string().optional().nullable(),
        customsStatus: z.enum(["PENDING", "SUBMITTED", "CLEARED", "HELD"]).optional(),
        customsNote: z.string().trim().max(500).optional(),
        customsClearedAt: z.string().optional().nullable(),
        destinationAgent: z.string().trim().max(1000).optional(),
        finalMileCarrier: z.string().trim().max(200).optional(),
        handoverAt: z.string().optional().nullable(),
        handoverReference: z.string().trim().max(120).optional()
      }),
      request.body
    );
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const flight = await service.updateDestinationHandover({ flightId: String(request.params.flightId), ...input, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Destination handover updated.", flight });
  } catch (error) {
    return sendError(response, error);
  }
}

// Documents
export async function listDocuments(request: Request, response: Response) {
  try {
    const allowedBranchIds = flightBranchIds(request);
    const documents = await service.listFlightDocuments(String(request.params.flightId), allowedBranchIds);
    return response.json({ success: true, documents });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function uploadDocument(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const file = (request as Request & { file?: Express.Multer.File }).file;
    if (!file) return response.status(400).json({ success: false, message: "Select a file to upload." });
    const body = parsedBody(response, z.object({ documentType: z.string().trim().min(1), note: z.string().trim().max(500).optional().default("") }), request.body);
    if (!body) return;
    const allowedBranchIds = flightBranchIds(request);
    const doc = await service.uploadFlightDocument({ flightId: String(request.params.flightId), documentType: body.documentType.toUpperCase(), note: body.note, file: { originalname: file.originalname, mimetype: file.mimetype, size: file.size, buffer: file.buffer }, userId: actorId, allowedBranchIds });
    return response.status(201).json({ success: true, message: "Document uploaded.", document: doc });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function deleteDocument(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const allowedBranchIds = flightBranchIds(request);
    await service.deleteFlightDocument({ flightId: String(request.params.flightId), documentId: String(request.params.documentId), userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Document deleted." });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function downloadDocument(request: Request, response: Response) {
  try {
    const allowedBranchIds = flightBranchIds(request);
    const flightId = String(request.params.flightId);
    const documentId = String(request.params.documentId);
    const flight = await FlightLinehaul.findById(flightId).select("branchId").lean().exec();
    if (!flight) return response.status(404).json({ success: false, message: "Flight was not found." });
    if (allowedBranchIds !== null && allowedBranchIds !== undefined && !allowedBranchIds.includes(String(flight.branchId))) {
      return response.status(403).json({ success: false, message: "You do not have access to this flight's branch." });
    }
    const doc = await FlightDocument.findOne({ _id: documentId, flightLinehaulId: flightId }).lean().exec();
    if (!doc) return response.status(404).json({ success: false, message: "Document was not found." });
    return streamObjectToResponse({ response, key: doc.storageKey, contentType: doc.mimeType, filename: doc.originalName, disposition: request.query.view === "1" ? "inline" : "attachment" });
  } catch (error) {
    return sendError(response, error);
  }
}

// Exceptions
export async function listExceptions(request: Request, response: Response) {
  try {
    const allowedBranchIds = flightBranchIds(request);
    const query = z
      .object({
        flightId: z.string().optional(),
        status: z.string().optional(),
        severity: z.string().optional(),
        type: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional()
      })
      .safeParse(request.query);
    if (!query.success) return response.status(400).json({ success: false, message: "Exception filters invalid." });
    // If listing for a specific flight via path param
    const flightId = request.params.flightId ? String(request.params.flightId) : query.data.flightId;
    const result = await service.listFlightExceptions({ ...query.data, flightId, allowedBranchIds });
    return response.json({ success: true, ...result });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function acknowledgeException(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const allowedBranchIds = flightBranchIds(request);
    const exception = await service.acknowledgeException({ exceptionId: String(request.params.exceptionId), userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Exception acknowledged.", exception });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function updateException(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(
      response,
      z.object({
        assignedTo: z.string().optional().nullable(),
        status: z.enum(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
        resolutionNotes: z.string().trim().max(1000).optional()
      }),
      request.body
    );
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const exception = await service.updateExceptionAssignment({ exceptionId: String(request.params.exceptionId), assignedTo: input.assignedTo ?? null, status: input.status, resolutionNotes: input.resolutionNotes, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Exception updated.", exception });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function resolveException(request: Request, response: Response) {
  try {
    const actorId = userId(request);
    if (!actorId) return response.status(401).json({ success: false, message: "Unauthorized" });
    const input = parsedBody(response, z.object({ resolutionNotes: z.string().trim().min(5).max(1000) }), request.body);
    if (!input) return;
    const allowedBranchIds = flightBranchIds(request);
    const exception = await service.resolveException({ exceptionId: String(request.params.exceptionId), resolutionNotes: input.resolutionNotes, userId: actorId, allowedBranchIds });
    return response.json({ success: true, message: "Exception resolved.", exception });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function listAllExceptions(request: Request, response: Response) {
  try {
    const allowedBranchIds = flightBranchIds(request);
    const query = z
      .object({
        status: z.string().optional(),
        severity: z.string().optional(),
        type: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
        flightId: z.string().optional()
      })
      .safeParse(request.query);
    if (!query.success) return response.status(400).json({ success: false, message: "Filters invalid." });
    const result = await service.listFlightExceptions({ ...query.data, allowedBranchIds });
    return response.json({ success: true, ...result });
  } catch (error) {
    return sendError(response, error);
  }
}
