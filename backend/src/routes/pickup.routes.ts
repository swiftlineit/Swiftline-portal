import { Router } from "express";
import {
  addMyPickupException, assignPickupRequestDriver, cancelInternalPickupRequest, completeMyPickupAttempt, confirmPickupRequest,
  getInternalPickupRequest, getMyPickupAttempt, listAvailablePickupDrivers, listInternalPickupRequests, listMyPickupAttempts, requestMyPickupOtp,
  requestMyPickupOtpException, requirePickupManager, reviewPickupRequestOtpException, scanMyPickupParcel,
  updateInternalPickupPartnerInfo, updateInternalPickupStatus, updateMyPickupAttemptStatus, uploadInternalPickupProof, uploadMyPickupProof, verifyMyPickupOtp,
  viewInternalPickupDocument, viewInternalPickupProof, viewMyPickupProof, markPickupRequestMissed, reschedulePickupRequest,
  listPickupCourierAddresses, savePickupCourierAddress
} from "../controllers/pickup.controller.js";
import { attachUser, requireAuthenticated, requireRole } from "../middleware/auth.middleware.js";
import { pickupProofUpload } from "../middleware/pickupProofUpload.middleware.js";

export const pickupManagementRouter = Router();
pickupManagementRouter.use(attachUser, requireAuthenticated, requirePickupManager);
pickupManagementRouter.get("/", listInternalPickupRequests);
pickupManagementRouter.get("/available-drivers", listAvailablePickupDrivers);
pickupManagementRouter.get("/courier-addresses", requireRole("admin", "operations"), listPickupCourierAddresses);
pickupManagementRouter.post("/courier-addresses", requireRole("admin", "operations"), savePickupCourierAddress);
pickupManagementRouter.put("/courier-addresses/:profileId", requireRole("admin", "operations"), savePickupCourierAddress);
pickupManagementRouter.get("/:pickupId", getInternalPickupRequest);
pickupManagementRouter.post("/:pickupId/confirm", confirmPickupRequest);
pickupManagementRouter.post("/:pickupId/status", updateInternalPickupStatus);
pickupManagementRouter.put("/:pickupId/partner-info", updateInternalPickupPartnerInfo);
pickupManagementRouter.post("/:pickupId/assign", assignPickupRequestDriver);
pickupManagementRouter.post("/:pickupId/cancel", cancelInternalPickupRequest);
pickupManagementRouter.post("/:pickupId/reschedule", reschedulePickupRequest);
pickupManagementRouter.post("/:pickupId/missed", markPickupRequestMissed);
pickupManagementRouter.get("/:pickupId/proofs/:proofId", viewInternalPickupProof);
pickupManagementRouter.post("/:pickupId/proofs", pickupProofUpload, uploadInternalPickupProof);
pickupManagementRouter.get("/:pickupId/documents/:documentId", viewInternalPickupDocument);
pickupManagementRouter.post("/:pickupId/otp-exception/review", reviewPickupRequestOtpException);

export const pickupDriverRouter = Router();
pickupDriverRouter.use(attachUser, requireRole("delivery"));
pickupDriverRouter.get("/attempts", listMyPickupAttempts);
pickupDriverRouter.get("/attempts/:attemptId", getMyPickupAttempt);
pickupDriverRouter.get("/attempts/:attemptId/proofs/:proofId", viewMyPickupProof);
pickupDriverRouter.post("/attempts/:attemptId/status", updateMyPickupAttemptStatus);
pickupDriverRouter.post("/attempts/:attemptId/otp/request", requestMyPickupOtp);
pickupDriverRouter.post("/attempts/:attemptId/otp/verify", verifyMyPickupOtp);
pickupDriverRouter.post("/attempts/:attemptId/otp/exception", requestMyPickupOtpException);
pickupDriverRouter.post("/attempts/:attemptId/scan", scanMyPickupParcel);
pickupDriverRouter.post("/attempts/:attemptId/exceptions", addMyPickupException);
pickupDriverRouter.post("/attempts/:attemptId/proofs/:proofType", pickupProofUpload, uploadMyPickupProof);
pickupDriverRouter.post("/attempts/:attemptId/complete", completeMyPickupAttempt);
