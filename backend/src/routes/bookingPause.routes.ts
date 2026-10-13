import { Router } from "express";
import {
  createBookingPause,
  deleteBookingPause,
  listActiveBookingPauses,
  listBookingPauses,
  toggleBookingPause,
  updateDpdBookingSetting,
  updateBookingPause
} from "../controllers/bookingPause.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const bookingPauseRouter = Router();

// All booking-pause management is admin/operations only, like operations-advisory.
bookingPauseRouter.use(attachUser);
bookingPauseRouter.use(requireRole("admin", "operations"));

// Public/active view for staff (same filter as client)
bookingPauseRouter.get("/active", listActiveBookingPauses);
bookingPauseRouter.patch("/dpd-booking", updateDpdBookingSetting);

bookingPauseRouter.get("/", listBookingPauses);
bookingPauseRouter.post("/", createBookingPause);
bookingPauseRouter.patch("/:id", updateBookingPause);
bookingPauseRouter.patch("/:id/toggle", toggleBookingPause);
bookingPauseRouter.delete("/:id", deleteBookingPause);
