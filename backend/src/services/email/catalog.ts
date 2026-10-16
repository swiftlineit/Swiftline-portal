import type { EmailCategory } from "../../models/emailOutbox.model.js";

type CatalogEntry = {
  category: EmailCategory;
  /** Higher drains first. Money and security outrank digests and FYI mail. */
  priority: number;
};

/**
 * Every notification type that should also go out by email, with the policy
 * that governs it. A type absent from this map is in-app only- that absence is
 * the switch for adding email to an event, so new notification types stay
 * silent by default rather than surprising clients.
 *
 * TRANSACTIONAL mail ignores user preferences (§5 of the plan: invoices,
 * payments, security and legal agreements are contractual). OPERATIONAL mail is
 * preference-controlled and carries List-Unsubscribe headers.
 */
const catalog: Record<string, CatalogEntry> = {
  // Shipment lifecycle
  SHIPMENT_BOOKED: { category: "TRANSACTIONAL", priority: 85 },
  SHIPMENT_MANIFEST_GENERATED: { category: "OPERATIONAL", priority: 40 },
  SHIPMENT_CHARGE_VERIFIED: { category: "OPERATIONAL", priority: 50 },
  // Staff-facing: a held shipment cannot move until someone looks at this.
  SHIPMENT_DOCUMENT_UPLOADED: { category: "TRANSACTIONAL", priority: 70 },

  // Flight control: high/critical operational exceptions are also emailed to
  // the branch's assigned operations team and active admins. Lower-severity
  // flight information remains in-app to avoid alert fatigue.
  FLIGHT_DELAY: { category: "OPERATIONAL", priority: 90 },
  FLIGHT_OFFLOAD: { category: "OPERATIONAL", priority: 90 },
  FLIGHT_CONNECTION_RISK: { category: "OPERATIONAL", priority: 90 },
  FLIGHT_EXCEPTION: { category: "OPERATIONAL", priority: 85 },
  FLIGHT_CUSTOMS_HOLD: { category: "OPERATIONAL", priority: 95 },

  // Amendments
  SHIPMENT_AMENDMENT_REQUESTED: { category: "TRANSACTIONAL", priority: 70 },
  SHIPMENT_AMENDMENT_APPROVED: { category: "TRANSACTIONAL", priority: 70 },
  SHIPMENT_AMENDMENT_REJECTED: { category: "TRANSACTIONAL", priority: 70 },

  // Cancellations
  SHIPMENT_CANCELLATION_REQUESTED: { category: "TRANSACTIONAL", priority: 70 },
  SHIPMENT_CANCELLATION_COMPLETED: { category: "TRANSACTIONAL", priority: 70 },
  SHIPMENT_CANCELLATION_REJECTED: { category: "TRANSACTIONAL", priority: 70 },

  // Quotes
  SHIPMENT_QUOTE_REQUESTED: { category: "TRANSACTIONAL", priority: 70 },
  SHIPMENT_QUOTE_PUBLISHED: { category: "TRANSACTIONAL", priority: 75 },
  SHIPMENT_QUOTE_DECLINED: { category: "TRANSACTIONAL", priority: 70 },
  SHIPMENT_QUOTE_CONVERTED: { category: "OPERATIONAL", priority: 60 },

  // Billing statements and collections
  STATEMENT_ISSUED: { category: "TRANSACTIONAL", priority: 85 },
  PAYMENT_DUE_SOON: { category: "TRANSACTIONAL", priority: 80 },
  PAYMENT_OVERDUE: { category: "TRANSACTIONAL", priority: 90 },

  // Payments
  PAYMENT_CONFIRMED: { category: "TRANSACTIONAL", priority: 80 },
  OFFLINE_PAYMENT_SUBMITTED: { category: "TRANSACTIONAL", priority: 70 },
  CUSTOMER_ADVANCE_CREDITED: { category: "TRANSACTIONAL", priority: 70 },
  SECURITY_DEPOSIT_RECEIVED: { category: "TRANSACTIONAL", priority: 70 },

  // Credit account
  LOW_BOOKING_CAPACITY: { category: "OPERATIONAL", priority: 65 },
  CREDIT_UTILIZATION_WARNING: { category: "OPERATIONAL", priority: 65 },
  CREDIT_RECONCILIATION_ALERT: { category: "OPERATIONAL", priority: 50 },
  CREDIT_REQUEST_SUBMITTED: { category: "TRANSACTIONAL", priority: 70 },
  CREDIT_REQUEST_APPROVED: { category: "TRANSACTIONAL", priority: 80 },
  CREDIT_REQUEST_REJECTED: { category: "TRANSACTIONAL", priority: 80 },
  CREDIT_ACCOUNT_STATUS_CHANGED: { category: "TRANSACTIONAL", priority: 80 },
  CREDIT_AGREEMENT_READY: { category: "TRANSACTIONAL", priority: 80 },
  CREDIT_AGREEMENT_SIGNED: { category: "TRANSACTIONAL", priority: 80 },

  // Business account onboarding
  BUSINESS_ACCOUNT_SUBMITTED: { category: "TRANSACTIONAL", priority: 70 },
  BUSINESS_ACCOUNT_STATUS_CHANGED: { category: "TRANSACTIONAL", priority: 80 },
  BUSINESS_ACCOUNT_KYC_REVIEWED: { category: "TRANSACTIONAL", priority: 80 },
  BUSINESS_ACCOUNT_GST_BILLING_REVIEWED: { category: "TRANSACTIONAL", priority: 80 },

  // Rate cards. Commercial rather than contractual, so it is preference-
  // controlled and carries List-Unsubscribe like every other operational mail.
  RATE_CARD_SHARED: { category: "OPERATIONAL", priority: 55 },

  // Support
  SUPPORT_TICKET_CREATED: { category: "TRANSACTIONAL", priority: 70 },
  SUPPORT_TICKET_REPLY: { category: "TRANSACTIONAL", priority: 70 },
  SUPPORT_TICKET_STATUS_UPDATED: { category: "OPERATIONAL", priority: 60 },
  // Staff-facing and time-critical: a breach only matters if it is read soon.
  // Sent when a customer shares proof of delivery with their own team.
  CLIENT_ACCESS_REQUESTED: { category: "OPERATIONAL", priority: 80 },
  CLIENT_ACCESS_APPROVED: { category: "TRANSACTIONAL", priority: 85 },
  POD_AVAILABLE: { category: "TRANSACTIONAL", priority: 70 },
  SUPPORT_TICKET_SLA_BREACHED: { category: "OPERATIONAL", priority: 90 },

  // Claims.
  //
  // Client-facing claim mail is TRANSACTIONAL throughout: a claim is a money
  // matter with deadlines attached, and a client who unsubscribed from operational
  // mail must still be told their evidence is missing or their appeal window is
  // closing. Staff-facing claim mail is OPERATIONAL- it is queue management.
  CLAIM_SUBMITTED: { category: "TRANSACTIONAL", priority: 80 },
  CLAIM_DOCUMENTS_REQUIRED: { category: "TRANSACTIONAL", priority: 80 },
  CLAIM_DOCUMENT_REJECTED: { category: "TRANSACTIONAL", priority: 80 },
  CLAIM_INFORMATION_REQUESTED: { category: "TRANSACTIONAL", priority: 80 },
  CLAIM_UNDER_REVIEW: { category: "OPERATIONAL", priority: 55 },
  CLAIM_DECISION_ISSUED: { category: "TRANSACTIONAL", priority: 90 },
  // Time-critical: the client loses the right to appeal if this is missed.
  CLAIM_APPEAL_WINDOW_CLOSING: { category: "TRANSACTIONAL", priority: 90 },
  CLAIM_SETTLEMENT_ACCEPTANCE_REQUIRED: { category: "TRANSACTIONAL", priority: 85 },
  CLAIM_BANK_DETAILS_REQUIRED: { category: "TRANSACTIONAL", priority: 85 },
  CLAIM_BANK_DETAILS_REJECTED: { category: "TRANSACTIONAL", priority: 85 },
  CLAIM_PAYMENT_COMPLETED: { category: "TRANSACTIONAL", priority: 90 },
  CLAIM_CLOSED: { category: "OPERATIONAL", priority: 50 },

  CLAIM_RECEIVED_STAFF: { category: "OPERATIONAL", priority: 60 },
  CLAIM_DOCUMENTS_COMPLETE: { category: "OPERATIONAL", priority: 55 },
  CLAIM_CLIENT_REPLIED: { category: "OPERATIONAL", priority: 55 },
  CLAIM_SLA_DUE: { category: "OPERATIONAL", priority: 65 },
  CLAIM_AWAITING_DECISION: { category: "OPERATIONAL", priority: 65 },
  CLAIM_SETTLEMENT_ACCEPTED: { category: "OPERATIONAL", priority: 65 },
  CLAIM_APPEAL_SUBMITTED: { category: "OPERATIONAL", priority: 70 },
  CLAIM_RECOVERY_FOLLOW_UP: { category: "OPERATIONAL", priority: 45 },

  // Account and access mail, raised directly rather than through a notification
  CLIENT_INVITATION: { category: "TRANSACTIONAL", priority: 95 },
  PASSWORD_RESET: { category: "TRANSACTIONAL", priority: 95 },
  // Highest priority in the catalogue: someone is sitting on the sign-in screen
  // watching a countdown, so this must overtake every queued invoice and digest.
  LOGIN_OTP: { category: "TRANSACTIONAL", priority: 99 },
  BUSINESS_ACCOUNT_EMAIL_OTP: { category: "TRANSACTIONAL", priority: 99 },
  PICKUP_OTP: { category: "TRANSACTIONAL", priority: 98 },

  // Pickup requests and milestones are operationally time-bound commitments;
  // they go to the requester and the pickup branch's assigned team.
  PICKUP_REQUESTED: { category: "TRANSACTIONAL", priority: 75 },
  PICKUP_CONFIRMED: { category: "TRANSACTIONAL", priority: 75 },
  PICKUP_ASSIGNED: { category: "TRANSACTIONAL", priority: 75 },
  PICKUP_EN_ROUTE: { category: "TRANSACTIONAL", priority: 80 },
  PICKUP_COMPLETED: { category: "TRANSACTIONAL", priority: 85 },
  PICKUP_CANCELLED: { category: "TRANSACTIONAL", priority: 75 },
  PICKUP_ACTION_REQUIRED: { category: "TRANSACTIONAL", priority: 75 },
  PICKUP_MISSED: { category: "TRANSACTIONAL", priority: 75 },
  PICKUP_RESCHEDULED: { category: "TRANSACTIONAL", priority: 75 },
  PICKUP_DISPATCH_REMINDER: { category: "TRANSACTIONAL", priority: 80 }
};

export function getEmailPolicy(notificationType: string): CatalogEntry | null {
  return catalog[notificationType] ?? null;
}

export function isEmailEnabledType(notificationType: string) {
  return notificationType in catalog;
}
