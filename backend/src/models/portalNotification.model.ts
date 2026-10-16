import mongoose from "mongoose";

export const portalNotificationTypeValues = [
  "STATEMENT_ISSUED",
  "PAYMENT_DUE_SOON",
  "PAYMENT_OVERDUE",
  "PAYMENT_CONFIRMED",
  "LOW_BOOKING_CAPACITY",
  "CREDIT_UTILIZATION_WARNING",
  "CREDIT_RECONCILIATION_ALERT",
  "OFFLINE_PAYMENT_SUBMITTED",
  "SHIPMENT_CANCELLATION_REQUESTED",
  "SHIPMENT_CANCELLATION_COMPLETED",
  "SHIPMENT_CANCELLATION_REJECTED",
  "SHIPMENT_QUOTE_REQUESTED",
  "SHIPMENT_QUOTE_PUBLISHED",
  "SHIPMENT_QUOTE_DECLINED",
  "SHIPMENT_QUOTE_CONVERTED",
  "SHIPMENT_BOOKED",
  "SHIPMENT_MANIFEST_GENERATED",
  "SHIPMENT_AMENDMENT_REQUESTED",
  "SHIPMENT_AMENDMENT_APPROVED",
  "SHIPMENT_AMENDMENT_REJECTED",
  "SHIPMENT_CHARGE_VERIFIED",
  "BUSINESS_ACCOUNT_SUBMITTED",
  "BUSINESS_ACCOUNT_STATUS_CHANGED",
  "BUSINESS_ACCOUNT_KYC_REVIEWED",
  "BUSINESS_ACCOUNT_GST_BILLING_REVIEWED",
  "CREDIT_REQUEST_SUBMITTED",
  "CREDIT_REQUEST_APPROVED",
  "CREDIT_REQUEST_REJECTED",
  "CREDIT_ACCOUNT_STATUS_CHANGED",
  "CREDIT_AGREEMENT_READY",
  "CREDIT_AGREEMENT_SIGNED",
  "CUSTOMER_ADVANCE_CREDITED",
  "SECURITY_DEPOSIT_RECEIVED",
  "SUPPORT_TICKET_CREATED",
  "SUPPORT_TICKET_REPLY",
  "SUPPORT_TICKET_STATUS_UPDATED",
  "SUPPORT_TICKET_SLA_BREACHED",
  "RATE_CARD_SHARED",
  "SERVICE_DISRUPTION",
  "PICKUP_REQUESTED",
  "PICKUP_CONFIRMED",
  "PICKUP_ASSIGNED",
  "PICKUP_EN_ROUTE",
  "PICKUP_COMPLETED",
  "PICKUP_CANCELLED",
  "PICKUP_ACTION_REQUIRED",
  "PICKUP_MISSED",
  "PICKUP_RESCHEDULED",
  "PICKUP_DISPATCH_REMINDER"
  ,"DELIVERY_ASSIGNED"
  ,"DELIVERY_COMPLETED"
  ,"POD_SUBMITTED"
  ,"POD_VERIFIED"
  ,"POD_ACTION_REQUIRED"
  ,"POD_DISPUTED"
  ,"POD_AVAILABLE"
  ,"CLIENT_ACCESS_REQUESTED"
  ,"CLIENT_ACCESS_APPROVED"
  ,"SHIPMENT_DOCUMENT_UPLOADED"
  ,"FLIGHT_DELAY"
  ,"FLIGHT_OFFLOAD"
  ,"FLIGHT_CONNECTION_RISK"
  ,"FLIGHT_EXCEPTION"
  ,"FLIGHT_DEPARTED"
  ,"FLIGHT_ARRIVED"
  ,"FLIGHT_CUSTOMS_HOLD"
  ,"FLIGHT_FINAL_MILE_HANDOVER"
  // Claims. Client-facing events first, then the ones only staff ever see.
  ,"CLAIM_SUBMITTED"
  ,"CLAIM_DOCUMENTS_REQUIRED"
  ,"CLAIM_DOCUMENT_REJECTED"
  ,"CLAIM_INFORMATION_REQUESTED"
  ,"CLAIM_UNDER_REVIEW"
  ,"CLAIM_DECISION_ISSUED"
  ,"CLAIM_APPEAL_WINDOW_CLOSING"
  ,"CLAIM_SETTLEMENT_ACCEPTANCE_REQUIRED"
  ,"CLAIM_BANK_DETAILS_REQUIRED"
  ,"CLAIM_BANK_DETAILS_REJECTED"
  ,"CLAIM_PAYMENT_COMPLETED"
  ,"CLAIM_CLOSED"
  ,"CLAIM_RECEIVED_STAFF"
  ,"CLAIM_DOCUMENTS_COMPLETE"
  ,"CLAIM_CLIENT_REPLIED"
  ,"CLAIM_SLA_DUE"
  ,"CLAIM_AWAITING_DECISION"
  ,"CLAIM_SETTLEMENT_ACCEPTED"
  ,"CLAIM_APPEAL_SUBMITTED"
  ,"CLAIM_RECOVERY_FOLLOW_UP"
] as const;
export type PortalNotificationType = (typeof portalNotificationTypeValues)[number];

export interface IPortalNotification extends mongoose.Document {
  recipientUserId: mongoose.Types.ObjectId;
  businessAccountId?: mongoose.Types.ObjectId | null;
  type: PortalNotificationType;
  title: string;
  message: string;
  href: string;
  idempotencyKey: string;
  readAt?: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const portalNotificationSchema = new mongoose.Schema<IPortalNotification>({
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  businessAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BusinessAccount", default: null, index: true },
  type: { type: String, enum: portalNotificationTypeValues, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 500 },
  href: { type: String, required: true, trim: true, maxlength: 300 },
  idempotencyKey: { type: String, required: true, unique: true, trim: true, maxlength: 300 },
  readAt: { type: Date, default: null, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: false });

portalNotificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });

export const PortalNotification = mongoose.model<IPortalNotification>(
  "PortalNotification",
  portalNotificationSchema
);
