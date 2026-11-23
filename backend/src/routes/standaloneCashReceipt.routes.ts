import { Router } from "express";
import {
  createStandaloneCashReceiptHandler,
  downloadStandaloneCashReceiptPdf,
  exportStandaloneCashReceipts,
  listStandaloneCashReceipts
} from "../controllers/standaloneCashReceipt.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const standaloneCashReceiptRouter = Router();

standaloneCashReceiptRouter.use(attachUser, requireRole("admin", "operations"));
standaloneCashReceiptRouter.get("/export", exportStandaloneCashReceipts);
standaloneCashReceiptRouter.get("/", listStandaloneCashReceipts);
standaloneCashReceiptRouter.post("/", createStandaloneCashReceiptHandler);
standaloneCashReceiptRouter.get("/:receiptId/pdf", downloadStandaloneCashReceiptPdf);
