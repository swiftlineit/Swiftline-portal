import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { operationsUser } from "../middleware/operationsBranchAccess.middleware.js";
import {
  createDirectOperationsScanSession,
  createOperationsScanSession,
  endOperationsScanSession,
  getActiveOperationsScanSession,
  getOperationsScanSession,
  OperationsScanSessionError,
  pairOperationsScanSession,
  updateOperationsScanSessionBag
} from "../services/operationsScanSession.service.js";

function actor(request: Request) {
  const user = operationsUser(request);
  if (!user || !mongoose.Types.ObjectId.isValid(String(user._id))) return null;
  return {
    userId: new mongoose.Types.ObjectId(String(user._id)),
    role: user.role,
    assignedBranchIds: (user.assignedBranches ?? []).map(String)
  };
}

function sendError(response: Response, error: unknown) {
  if (error instanceof OperationsScanSessionError) {
    return response.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

export async function createSession(request: Request, response: Response) {
  try {
    const currentActor = actor(request);
    const parsed = z.object({ activeBagId: z.string().trim().min(1).optional() }).safeParse(request.body ?? {});
    if (!currentActor) return response.status(401).json({ success: false, message: "Unauthorized" });
    if (!parsed.success) return response.status(400).json({ success: false, message: "The phone scanner request is invalid." });
    return response.status(201).json({
      success: true,
      ...(await createOperationsScanSession({
        manifestId: String(request.params.manifestId),
        activeBagId: parsed.data.activeBagId,
        actor: currentActor
      }))
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function createDirectSession(request: Request, response: Response) {
  try {
    const currentActor = actor(request);
    if (!currentActor) return response.status(401).json({ success: false, message: "Unauthorized" });
    return response.status(201).json({
      success: true,
      ...(await createDirectOperationsScanSession({
        manifestId: String(request.params.manifestId),
        actor: currentActor
      }))
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function pairSession(request: Request, response: Response) {
  try {
    const currentActor = actor(request);
    const parsed = z.object({ token: z.string().trim().min(40).max(200) }).safeParse(request.body);
    if (!currentActor) return response.status(401).json({ success: false, message: "Unauthorized" });
    if (!parsed.success) return response.status(400).json({ success: false, message: "The phone pairing code is incomplete." });
    return response.json({
      success: true,
      session: await pairOperationsScanSession({ token: parsed.data.token, actor: currentActor })
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function getSessionStatus(request: Request, response: Response) {
  try {
    const currentActor = actor(request);
    if (!currentActor) return response.status(401).json({ success: false, message: "Unauthorized" });
    return response.json({
      success: true,
      session: await getOperationsScanSession({ sessionId: String(request.params.sessionId), actor: currentActor })
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function getActiveSession(request: Request, response: Response) {
  try {
    const currentActor = actor(request);
    if (!currentActor) return response.status(401).json({ success: false, message: "Unauthorized" });
    return response.json({
      success: true,
      session: await getActiveOperationsScanSession({
        manifestId: String(request.params.manifestId),
        actor: currentActor
      })
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function changeSessionBag(request: Request, response: Response) {
  try {
    const currentActor = actor(request);
    const parsed = z.object({ activeBagId: z.string().trim().min(1) }).safeParse(request.body);
    if (!currentActor) return response.status(401).json({ success: false, message: "Unauthorized" });
    if (!parsed.success) return response.status(400).json({ success: false, message: "Select an open bag." });
    return response.json({
      success: true,
      session: await updateOperationsScanSessionBag({
        sessionId: String(request.params.sessionId),
        manifestId: String(request.params.manifestId),
        activeBagId: parsed.data.activeBagId,
        actor: currentActor
      })
    });
  } catch (error) {
    return sendError(response, error);
  }
}

export async function disconnectSession(request: Request, response: Response) {
  try {
    const currentActor = actor(request);
    if (!currentActor) return response.status(401).json({ success: false, message: "Unauthorized" });
    return response.json({
      success: true,
      session: await endOperationsScanSession({
        sessionId: String(request.params.sessionId),
        manifestId: String(request.params.manifestId),
        actor: currentActor
      })
    });
  } catch (error) {
    return sendError(response, error);
  }
}
