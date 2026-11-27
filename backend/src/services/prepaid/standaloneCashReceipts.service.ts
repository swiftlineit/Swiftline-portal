import mongoose from "mongoose";
import { AuditLog } from "../../models/auditLog.model.js";
import { Branch } from "../../models/branch.model.js";
import { BusinessAccount } from "../../models/businessAccount.model.js";
import { CashReceipt } from "../../models/cashReceipt.model.js";
import { User } from "../../models/user.model.js";
import { notifyActiveAdmins, notifyOperationsStaff } from "../portalNotification.service.js";
import { getTenantContext, getTenantIdForWrite } from "../tenantScope.service.js";

export type StandaloneCashReceiptInput = {
  idempotencyKey: string;
  // Omitted for walk-in/manual receipts. Account-based receipts keep the id so
  // the receipt remains linked to the customer's ledger identity.
  businessAccountId?: mongoose.Types.ObjectId | null;
  branchId: mongoose.Types.ObjectId;
  staffUserId: mongoose.Types.ObjectId;
  customerName: string;
  gstin?: string;
  address?: string;
  mobileNumber?: string;
  receiptDate: Date;
  amountMinor: number;
  paymentReference: string;
  customerReference?: string;
  destination?: string;
  service?: "COURIER" | "CARGO";
  pieces?: number;
  weightKg?: number;
};

type ResolvedStandaloneDetails = {
  businessAccountId: string;
  branchId: string;
  gstin: string;
  address: string;
  mobileNumber: string;
};

/**
 * Idempotency checks compare the final snapshot, not the raw request, so an
 * account-based retry with no explicit address/GSTIN/phone still matches the
 * values that were auto-filled from the account on the first attempt.
 */
function sameReceiptRequest(
  receipt: InstanceType<typeof CashReceipt>,
  input: StandaloneCashReceiptInput,
  resolved: ResolvedStandaloneDetails
) {
  return (receipt.businessAccountId ? String(receipt.businessAccountId) : "") === resolved.businessAccountId
    && String(receipt.branchId) === resolved.branchId
    && receipt.customerNameSnapshot === input.customerName.trim()
    && receipt.gstinSnapshot === resolved.gstin
    && receipt.addressSnapshot === resolved.address
    && (receipt.businessMobileNumberSnapshot ?? "") === resolved.mobileNumber
    && receipt.receiptDate.getTime() === input.receiptDate.getTime()
    && receipt.totalReceivedMinor === input.amountMinor
    && receipt.cashCustodyReference === input.paymentReference.trim()
    && receipt.destinationSnapshot === (input.destination?.trim() ?? "")
    && receipt.serviceSnapshot === (input.service ?? "")
    && (receipt.piecesSnapshot ?? null) === (input.pieces ?? null)
    && (receipt.weightKgSnapshot ?? null) === (input.weightKg ?? null)
    && receipt.customerReference === (input.customerReference?.trim() ?? "");
}

export async function createStandaloneCashReceipt(input: StandaloneCashReceiptInput) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error("Enter a valid amount received.");
  if (input.pieces !== undefined && (!Number.isSafeInteger(input.pieces) || input.pieces < 1)) throw new Error("Enter a valid shipment pieces count.");
  if (input.weightKg !== undefined && (!Number.isFinite(input.weightKg) || input.weightKg < 0)) throw new Error("Enter a valid shipment weight.");
  if (!input.idempotencyKey.trim()) throw new Error("Receipt request reference is required.");
  if (!input.customerName.trim() || !input.paymentReference.trim()) {
    throw new Error("Complete the customer and payment reference details.");
  }
  if (!Number.isFinite(input.receiptDate.getTime())) throw new Error("Enter a valid receipt date.");
  if (getTenantContext()?.kind === "OPERATOR") throw new Error("Standalone cash receipts are only available in Swiftline Operations.");

  const tenantId = await getTenantIdForWrite();
  const [account, staff, branchExists] = await Promise.all([
    input.businessAccountId
      ? BusinessAccount.findOne({
          _id: input.businessAccountId,
          tenantId,
          assignedBranch: input.branchId,
          accountKind: { $ne: "INDIVIDUAL_SENTINEL" }
        }).select("accountId company.gstin company.registeredAddress company.addressLine2 company.city company.stateOrProvince company.postalCode company.addressCountry contact.countryCode contact.mobileNumber").lean().exec()
      : Promise.resolve(null),
    User.findOne({ _id: input.staffUserId, userStatus: "active" }).select("name firstName lastName").lean().exec(),
    // Manual receipts do not go through the account/branch pairing check, so
    // verify the branch explicitly before writing a tenant-scoped receipt.
    Branch.exists({ _id: input.branchId, tenantId }).exec()
  ]);
  if (input.businessAccountId && !account) throw new Error("Select an active business account assigned to this branch.");
  if (!branchExists) throw new Error("Select a valid branch for this receipt.");
  if (!staff) throw new Error("The signed-in staff account could not be verified.");

  const staffName = staff.name || `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() || "Swiftline Staff";
  const accountMobileNumber = [account?.contact?.countryCode, account?.contact?.mobileNumber]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.trim())
    .join(" ");
  const accountGstin = account?.company?.gstin?.trim().toUpperCase() || "";
  const accountAddress = [
    account?.company?.registeredAddress,
    account?.company?.addressLine2,
    account?.company?.city,
    account?.company?.stateOrProvince,
    account?.company?.postalCode,
    account?.company?.addressCountry
  ].filter((part): part is string => Boolean(part?.trim())).map((part) => part.trim()).join(", ");
  const gstin = input.gstin?.trim().toUpperCase() || accountGstin;
  const address = input.address?.trim() || accountAddress;
  const mobileNumber = input.mobileNumber?.trim() || accountMobileNumber;
  const resolved: ResolvedStandaloneDetails = {
    businessAccountId: input.businessAccountId ? String(input.businessAccountId) : "",
    branchId: String(input.branchId),
    gstin,
    address,
    mobileNumber
  };

  const existing = await CashReceipt.findOne({
    tenantId,
    receiptType: "STANDALONE",
    standaloneIdempotencyKey: input.idempotencyKey.trim()
  }).exec();
  if (existing) {
    if (!sameReceiptRequest(existing, input, resolved)) throw new Error("This receipt request reference was already used for different details.");
    return { receipt: existing, created: false };
  }

  const receiptId = new mongoose.Types.ObjectId();
  const receiptDateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const now = new Date();
  const session = await mongoose.startSession();
  let receipt: InstanceType<typeof CashReceipt> | null = null;
  try {
    await session.withTransaction(async () => {
      const competing = await CashReceipt.findOne({
        tenantId,
        receiptType: "STANDALONE",
        standaloneIdempotencyKey: input.idempotencyKey.trim()
      }).session(session).exec();
      if (competing) {
        if (!sameReceiptRequest(competing, input, resolved)) throw new Error("This receipt request reference was already used for different details.");
        receipt = competing;
        return;
      }
      const [created] = await CashReceipt.create([{
        _id: receiptId,
        tenantId,
        receiptNumber: `CR-${receiptDateKey.replaceAll("-", "")}-${receiptId.toString().slice(-8).toUpperCase()}`,
        receiptType: "STANDALONE",
        standaloneIdempotencyKey: input.idempotencyKey.trim(),
        status: "FINALIZED",
        customerType: input.businessAccountId ? "BUSINESS" : "INDIVIDUAL",
        businessAccountId: input.businessAccountId ?? null,
        branchId: input.branchId,
        shipmentDraftId: null,
        activeShipmentKey: null,
        pricingHash: "",
        pricingRevision: 0,
        totalReceivedMinor: input.amountMinor,
        currency: "INR",
        allocations: [],
        unappliedAmountMinor: 0,
        customerNameSnapshot: input.customerName.trim(),
        businessMobileNumberSnapshot: mobileNumber,
        gstinSnapshot: gstin,
        addressSnapshot: address,
        receiptDate: input.receiptDate,
        accountIdSnapshot: account?.accountId ?? "",
        destinationSnapshot: input.destination?.trim() ?? "",
        serviceSnapshot: input.service ?? "",
        piecesSnapshot: input.pieces ?? null,
        weightKgSnapshot: input.weightKg ?? null,
        customerReference: input.customerReference?.trim() ?? "",
        cashCustodyReference: input.paymentReference.trim(),
        note: "",
        createdBy: input.staffUserId,
        createdByNameSnapshot: staffName,
        cashRecordedBy: input.staffUserId,
        cashRecordedByNameSnapshot: staffName,
        bookedBy: null,
        bookedByNameSnapshot: "",
        issuedAt: now,
        version: 0
      }], { session });
      if (!created) throw new Error("Cash receipt could not be created.");
      receipt = created;
      await AuditLog.create([{
        tenantId,
        action: "STANDALONE_CASH_RECEIPT_CREATED",
        entityType: "CASH_RECEIPT",
        entityId: created._id,
        performedBy: input.staffUserId,
        performedAt: now,
        metadata: {
          receiptNumber: created.receiptNumber,
          businessAccountId: input.businessAccountId ?? null,
          branchId: input.branchId,
          amountMinor: input.amountMinor,
          standalone: true
        }
      }], { session });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 11000) {
      const duplicate = await CashReceipt.findOne({
        tenantId,
        receiptType: "STANDALONE",
        standaloneIdempotencyKey: input.idempotencyKey.trim()
      }).exec();
      if (duplicate && sameReceiptRequest(duplicate, input, resolved)) return { receipt: duplicate, created: false };
    }
    throw error;
  } finally {
    await session.endSession();
  }
  const finalizedReceipt = receipt as unknown as InstanceType<typeof CashReceipt> | null;
  if (!finalizedReceipt) throw new Error("Cash receipt could not be created.");

  const attachmentRefs = [{
    kind: "CASH_RECEIPT_PDF" as const,
    refId: finalizedReceipt._id as mongoose.Types.ObjectId,
    filename: `CASH-RECEIPT-${finalizedReceipt.receiptNumber}.pdf`
  }];
  const notice = {
    type: "CASH_RECEIPT_AVAILABLE" as const,
    title: "Standalone cash receipt recorded",
    message: `Cash receipt ${finalizedReceipt.receiptNumber} for INR ${(finalizedReceipt.totalReceivedMinor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} was recorded by ${staffName}.`,
    href: "/dashboard/cash-receipts",
    businessAccountId: finalizedReceipt.businessAccountId ?? null,
    metadata: { cashReceiptId: String(finalizedReceipt._id), receiptNumber: finalizedReceipt.receiptNumber, standalone: true }
  };
  await Promise.allSettled([
    notifyOperationsStaff({ ...notice, idempotencyKey: `STANDALONE_CASH_RECEIPT:${String(finalizedReceipt._id)}:OPS`, email: { attachmentRefs } }),
    notifyActiveAdmins({ ...notice, idempotencyKey: `STANDALONE_CASH_RECEIPT:${String(finalizedReceipt._id)}:ADMIN`, email: { attachmentRefs } })
  ]);
  return { receipt: finalizedReceipt, created: true };
}
