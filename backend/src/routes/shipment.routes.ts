import { Router } from "express";
import {
  deleteBookedShipmentHandler,
  listAdminBookedShipments,
  listStaffOperationsManifestOptions,
  summarizeAdminBookedShipments
} from "../controllers/shipmentListing.controller.js";
import {
  downloadStaffShipmentDocument,
  listStaffShipmentDocuments,
  searchStaff
} from "../controllers/clientOverview.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const shipmentRouter = Router();

shipmentRouter.use(attachUser);
// Delivery works the booked-shipment list alongside operations.
shipmentRouter.use(requireRole("admin", "operations", "delivery"));
// Staff global search, over every account this user may see.
shipmentRouter.get("/search", searchStaff);
shipmentRouter.get("/summary", summarizeAdminBookedShipments);
shipmentRouter.get("/operations-manifests/options", listStaffOperationsManifestOptions);
// Documents the customer sent after booking, which is where a held shipment
// gets unblocked.
shipmentRouter.get("/:draftId/documents", listStaffShipmentDocuments);
shipmentRouter.get("/:draftId/documents/:documentId", downloadStaffShipmentDocument);
shipmentRouter.get("/", listAdminBookedShipments);
// Narrower than the router-wide floor: operations and delivery work this list
// every day, but taking a booked shipment off it is an admin decision.
shipmentRouter.delete("/:draftId", requireRole("admin"), deleteBookedShipmentHandler);
