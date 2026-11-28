import { Router } from "express";
import { exportBusinessAccountPaymentsLedger, getBusinessAccountCashReceiptPdf, getBusinessAccountPaymentsLedger } from "../controllers/adminPrepaid.controller.js";
import { attachUser, requireRole } from "../middleware/auth.middleware.js";

export const businessAccountPaymentsRouter = Router();

businessAccountPaymentsRouter.use(attachUser, requireRole("admin", "finance", "operations"));
businessAccountPaymentsRouter.get("/:businessAccountId/payments-ledger", getBusinessAccountPaymentsLedger);
businessAccountPaymentsRouter.get("/:businessAccountId/payments-ledger/export", exportBusinessAccountPaymentsLedger);
businessAccountPaymentsRouter.get("/:businessAccountId/payments-ledger/documents/cash-receipts/:receiptId", getBusinessAccountCashReceiptPdf);
