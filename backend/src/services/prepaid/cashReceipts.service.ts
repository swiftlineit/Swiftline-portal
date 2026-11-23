import mongoose from "mongoose";
import { BusinessAccount } from "../../models/businessAccount.model.js";
import { CashAllocationEvent } from "../../models/cashAllocationEvent.model.js";
import { CashReceipt } from "../../models/cashReceipt.model.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import { User } from "../../models/user.model.js";
import { buildPricingHash } from "../shipmentCostEstimate.service.js";
import { buildPricingInputFromDraft, calculateShipmentPricingEstimate } from "../shipmentPricing.service.js";
import { notifyActiveAdmins, notifyBusinessFinancialMembers, notifyOperationsStaff } from "../portalNotification.service.js";

type HistoricalAllocationInput = {
  statementId: mongoose.Types.ObjectId;
  amountMinor: number;
};

function staffDisplayName(user: { name?: string; firstName?: string; lastName?: string; email?: string }) {
  return user.name?.trim()
    || [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
    || user.email?.trim()
    || "Swiftline staff";
}

function assertPositiveMinor(amount: number, label: string) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`${label} must be a positive integer minor-unit amount.`);
}

async function buildReceiptContext(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  staffUserId: mongoose.Types.ObjectId;
  acceptedPricingHash: string;
}) {
  const [draft, user] = await Promise.all([
    ShipmentDraft.findById(input.shipmentDraftId).exec(),
    User.findById(input.staffUserId).select("name firstName lastName email role userStatus").lean().exec()
  ]);
  if (!draft || draft.deletedAt) throw new Error("Shipment draft not found.");
  if (draft.customerType !== "BUSINESS") {
    throw new Error("Offline cash receipts for shipment booking are available only to business accounts.");
  }
  if (!user || user.userStatus !== "active" || !["admin", "operations"].includes(user.role)) {
    throw new Error("Only an active admin or operations user can record cash received.");
  }
  if (!["EDITABLE", "BOOKING"].includes(draft.bookingState)) throw new Error("Cash can be recorded only for an unbooked shipment draft.");

  const pricing = await calculateShipmentPricingEstimate(buildPricingInputFromDraft(draft));
  if (pricing.missingRate) throw new Error("Rates are not available for this shipment.");
  const pricingHash = buildPricingHash(pricing);
  if (pricingHash !== input.acceptedPricingHash) throw new Error("The shipment price changed. Review the updated total before recording cash.");
  const shipmentAmountMinor = Math.round(pricing.totalAmount * 100);
  assertPositiveMinor(shipmentAmountMinor, "Shipment amount");

  const account = await BusinessAccount.findById(draft.businessAccountId)
    .select("accountId company.companyName contact.firstName contact.lastName accountKind")
    .lean()
    .exec();
  if (!account) throw new Error("Business account not found.");

  const customerName = account.company?.companyName?.trim()
    || [account.contact?.firstName, account.contact?.lastName].filter(Boolean).join(" ").trim()
    || account.accountId;
  const destination = [
    draft.consigneeEnteredAddress.addressLine1,
    draft.consigneeEnteredAddress.addressLine2,
    draft.consigneeEnteredAddress.townOrCity,
    draft.consigneeEnteredAddress.county,
    draft.consigneeEnteredAddress.postcode,
    draft.consigneeEnteredAddress.countryName || draft.consigneeEnteredAddress.countryCode
  ].filter(Boolean).join(", ");

  return {
    draft,
    pricingHash,
    shipmentAmountMinor,
    staffName: staffDisplayName(user),
    customerName,
    accountId: account.accountId,
    destination,
    service: draft.serviceType === "CARGO" ? "Cargo" : "Courier",
    pieces: Math.max(draft.parcelList.length || draft.parcelCount || 1, 1),
    weightKg: draft.parcelList.reduce((sum, parcel) => sum + (parcel.weightKg || 0), 0),
    pricingRevision: draft.__v ?? 0
  };
}

export async function saveCashReceiptDraft(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  staffUserId: mongoose.Types.ObjectId;
  acceptedPricingHash: string;
  totalReceivedMinor: number;
  cashCustodyReference: string;
  customerName: string;
  receiptDate: Date;
  customerReference?: string;
  note?: string;
  historicalAllocations?: HistoricalAllocationInput[];
}) {
  assertPositiveMinor(input.totalReceivedMinor, "Cash received");
  if (!input.cashCustodyReference.trim()) throw new Error("Cash custody reference is required.");
  const context = await buildReceiptContext(input);
  const customerName = input.customerName.trim();
  if (!customerName) throw new Error("Enter the business account name for the receipt.");
  if (!(input.receiptDate instanceof Date) || !Number.isFinite(input.receiptDate.getTime())) throw new Error("Enter a valid receipt date.");
  if (input.totalReceivedMinor !== context.shipmentAmountMinor) {
    throw new Error("Cash received must match the full shipment total before it can be booked.");
  }
  if (input.historicalAllocations?.length) throw new Error("Shipment cash receipts can only pay for this shipment.");
  const unappliedAmountMinor = 0;
  const allocations = [{
    allocationType: "SHIPMENT" as const,
    targetId: context.draft._id as mongoose.Types.ObjectId,
    amountMinor: context.shipmentAmountMinor,
    reference: "Shipment draft"
  }];

  const existingReceipt = await CashReceipt.findOne({
    shipmentDraftId: context.draft._id,
    status: { $in: ["DRAFT", "FINALIZED"] }
  }).sort({ issuedAt: -1, updatedAt: -1 }).exec();
  if (existingReceipt?.status === "FINALIZED") {
    if (existingReceipt.pricingHash !== context.pricingHash
      || existingReceipt.totalReceivedMinor !== input.totalReceivedMinor
      || existingReceipt.cashCustodyReference !== input.cashCustodyReference.trim()) {
      throw new Error("A receipt was already issued for this shipment. Contact admin to record a correction.");
    }
    return existingReceipt;
  }
  const existing = existingReceipt?.status === "DRAFT" ? existingReceipt : null;
  if (existing) {
    const updated = await CashReceipt.findOneAndUpdate(
      { _id: existing._id, status: "DRAFT", version: existing.version },
      {
        $set: {
          totalReceivedMinor: input.totalReceivedMinor,
          allocations,
          unappliedAmountMinor,
          pricingHash: context.pricingHash,
          pricingRevision: context.pricingRevision,
          customerNameSnapshot: customerName,
          receiptDate: input.receiptDate,
          accountIdSnapshot: context.accountId,
          destinationSnapshot: context.destination,
          serviceSnapshot: context.service,
          piecesSnapshot: context.pieces,
          weightKgSnapshot: context.weightKg,
          customerReference: input.customerReference?.trim() ?? "",
          cashCustodyReference: input.cashCustodyReference.trim(),
          note: input.note?.trim() ?? "",
          createdBy: input.staffUserId,
          createdByNameSnapshot: context.staffName
        },
        $inc: { version: 1 }
      },
      { returnDocument: "after", runValidators: true }
    ).exec();
    if (!updated) throw new Error("Cash receipt draft changed while it was being saved. Please reload and try again.");
    return updated;
  }

  const receiptId = new mongoose.Types.ObjectId();
  const dateKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).replaceAll("-", "");
  const [receipt] = await CashReceipt.create([{
    _id: receiptId,
    receiptNumber: `CR-${dateKey}-${receiptId.toString().slice(-8).toUpperCase()}`,
    status: "DRAFT",
    customerType: context.draft.customerType === "INDIVIDUAL" ? "INDIVIDUAL" : "BUSINESS",
    businessAccountId: context.draft.businessAccountId,
    branchId: context.draft.branchId,
    shipmentDraftId: context.draft._id,
    activeShipmentKey: String(context.draft._id),
    pricingHash: context.pricingHash,
    pricingRevision: context.pricingRevision,
    totalReceivedMinor: input.totalReceivedMinor,
    currency: "INR",
    allocations,
    unappliedAmountMinor,
    customerNameSnapshot: customerName,
    receiptDate: input.receiptDate,
    accountIdSnapshot: context.accountId,
    destinationSnapshot: context.destination,
    serviceSnapshot: context.service,
    piecesSnapshot: context.pieces,
    weightKgSnapshot: context.weightKg,
    customerReference: input.customerReference?.trim() ?? "",
    cashCustodyReference: input.cashCustodyReference.trim(),
    note: input.note?.trim() ?? "",
    createdBy: input.staffUserId,
    createdByNameSnapshot: context.staffName,
    version: 0
  }]);
  if (!receipt) throw new Error("Cash receipt draft could not be created.");
  return receipt;
}

export async function finalizeCashReceiptForBooking(input: {
  cashReceiptId: mongoose.Types.ObjectId;
  shipmentDraftId: mongoose.Types.ObjectId;
  staffUserId: mongoose.Types.ObjectId;
  acceptedPricingHash: string;
}) {
  const context = await buildReceiptContext(input);
  const session = await mongoose.startSession();
  try {
    let result: InstanceType<typeof CashReceipt> | null = null;
    await session.withTransaction(async () => {
      const receipt = await CashReceipt.findOne({
        _id: input.cashReceiptId,
        shipmentDraftId: input.shipmentDraftId
      }).session(session).exec();
      if (!receipt) throw new Error("Cash receipt draft not found.");
      if (receipt.status === "FINALIZED") {
        if (receipt.pricingHash !== context.pricingHash) throw new Error("The finalized cash receipt does not match the current shipment price.");
        result = receipt;
        return;
      }
      if (receipt.status !== "DRAFT") throw new Error("This cash receipt cannot be finalized.");
      if (receipt.pricingHash !== context.pricingHash || receipt.pricingHash !== input.acceptedPricingHash) {
        throw new Error("The shipment price changed. Update the cash receipt before booking.");
      }
      if (receipt.allocations.length !== 1 || receipt.allocations[0]?.allocationType !== "SHIPMENT") {
        throw new Error("Shipment cash receipts can only pay for this shipment.");
      }
      const shipmentAllocation = receipt.allocations[0];
      if (
        !shipmentAllocation
        || String(shipmentAllocation.targetId) !== String(input.shipmentDraftId)
        || shipmentAllocation.amountMinor !== context.shipmentAmountMinor
      ) throw new Error("The cash receipt must allocate the full current shipment price.");

      const finalized = await CashReceipt.findOneAndUpdate(
        { _id: receipt._id, status: "DRAFT", version: receipt.version },
        {
          $set: {
            status: "FINALIZED",
            cashRecordedBy: input.staffUserId,
            cashRecordedByNameSnapshot: context.staffName,
            bookedBy: input.staffUserId,
            bookedByNameSnapshot: context.staffName,
            issuedAt: new Date()
          },
          $inc: { version: 1 }
        },
        { returnDocument: "after", runValidators: true, session }
      ).exec();
      if (!finalized) throw new Error("Cash receipt changed while it was being finalized.");

      const events = finalized.allocations.map((allocation, index) => ({
        cashReceiptId: finalized._id,
        businessAccountId: finalized.businessAccountId,
        branchId: finalized.branchId,
        eventType: "RECEIPT_FINALIZED" as const,
        amountMinor: allocation.amountMinor,
        shipmentDraftId: allocation.allocationType === "SHIPMENT" ? finalized.shipmentDraftId : null,
        creditStatementId: null,
        idempotencyKey: `CASH_RECEIPT_FINALIZED:${String(finalized._id)}:${index}`,
        reason: allocation.reference,
        createdBy: input.staffUserId
      }));
      await CashAllocationEvent.create(events, { session, ordered: true });
      const receiptAttachment = [{
        kind: "CASH_RECEIPT_PDF" as const,
        refId: finalized._id as mongoose.Types.ObjectId,
        filename: `CASH-RECEIPT-${finalized.receiptNumber}.pdf`
      }];
      const cashMessage = `Cash receipt ${finalized.receiptNumber} for INR ${(finalized.totalReceivedMinor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is available. Shipment booking is being completed.`;
      if (finalized.customerType === "BUSINESS") {
        await notifyBusinessFinancialMembers(finalized.businessAccountId, {
          type: "CASH_RECEIPT_AVAILABLE",
          title: "Cash receipt available",
          message: cashMessage,
          href: "/client/documents?documentType=CASH_RECEIPT",
          idempotencyKey: `CASH_RECEIPT_AVAILABLE:${String(finalized._id)}:CLIENT`,
          businessAccountId: finalized.businessAccountId,
          metadata: { cashReceiptId: finalized._id, shipmentDraftId: finalized.shipmentDraftId },
          email: { attachmentRefs: receiptAttachment }
        }, session);
      }
      await notifyOperationsStaff({
        type: "CASH_RECEIPT_AVAILABLE",
        title: "Cash receipt recorded",
        message: `${cashMessage} Recorded by ${finalized.cashRecordedByNameSnapshot}.`,
        href: `/dashboard/dpd-labels/${String(finalized.shipmentDraftId)}`,
        idempotencyKey: `CASH_RECEIPT_AVAILABLE:${String(finalized._id)}:STAFF`,
        businessAccountId: finalized.businessAccountId,
        metadata: { cashReceiptId: finalized._id, shipmentDraftId: finalized.shipmentDraftId },
        email: { attachmentRefs: receiptAttachment }
      }, session);
      await notifyActiveAdmins({
        type: "CASH_RECEIPT_AVAILABLE",
        title: "Cash receipt recorded",
        message: `${cashMessage} Recorded by ${finalized.cashRecordedByNameSnapshot}.`,
        href: `/dashboard/shipments/${String(finalized.shipmentDraftId)}`,
        idempotencyKey: `CASH_RECEIPT_AVAILABLE:${String(finalized._id)}:ADMIN`,
        businessAccountId: finalized.businessAccountId,
        metadata: { cashReceiptId: finalized._id, shipmentDraftId: finalized.shipmentDraftId },
        email: { attachmentRefs: receiptAttachment }
      }, session);
      result = finalized;
    });
    const finalizedReceipt = result as InstanceType<typeof CashReceipt> | null;
    if (!finalizedReceipt) throw new Error("Cash receipt could not be finalized.");
    return finalizedReceipt;
  } finally {
    await session.endSession();
  }
}
