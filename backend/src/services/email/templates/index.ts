import type { EmailContent } from "../layout.js";
import { asText, firstNameOf, toAbsoluteUrl } from "../format.js";
import { shipmentBookedClientTemplate, shipmentBookedStaffTemplate } from "./shipmentBooked.js";
import { clientInvitationTemplate } from "./clientInvitation.js";
import { passwordResetTemplate } from "./passwordReset.js";
import { loginOtpTemplate } from "./loginOtp.js";
import { pickupOtpTemplate } from "./pickupOtp.js";
import { rateCardSharedTemplate } from "./rateCardShared.js";
import { claimDecisionTemplate } from "./claimDecision.js";
import { businessAccountOtpTemplate } from "./businessAccountOtp.js";
import { publicShipmentBookedTemplate } from "./publicShipmentBooked.js";

export type EmailTemplateContext = {
  recipientName: string;
  payload: Record<string, unknown>;
  /** Public portal origin, from CLIENT_URL. */
  appUrl: string;
};

export type EmailTemplate = (context: EmailTemplateContext) => EmailContent;

/**
 * Renders any notification that has no bespoke template. A portal notification
 * already carries a title, a message and a deep link, which is exactly enough
 * for a correct, on-brand email- so every existing notification type gets
 * usable mail without 34 hand-written files, and a bespoke template is only
 * written where the email needs more than the in-app card shows.
 */
const genericNotificationTemplate: EmailTemplate = ({ recipientName, payload, appUrl }) => {
  const title = asText(payload.title, "Update from Swiftline Portal");
  const message = asText(payload.message, "");
  const href = asText(payload.href, "");

  return {
    subject: title,
    preheader: message.slice(0, 140),
    heading: title,
    blocks: [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      ...(message ? [{ kind: "paragraph" as const, text: message }] : []),
      ...(href ? [{ kind: "button" as const, label: "Open in portal", url: toAbsoluteUrl(appUrl, href) }] : [])
    ]
  };
};

const registry: Record<string, EmailTemplate> = {
  SHIPMENT_BOOKED_CLIENT: shipmentBookedClientTemplate,
  SHIPMENT_BOOKED_STAFF: shipmentBookedStaffTemplate,
  PUBLIC_SHIPMENT_BOOKED: publicShipmentBookedTemplate,
  CLIENT_INVITATION: clientInvitationTemplate,
  PASSWORD_RESET: passwordResetTemplate,
  LOGIN_OTP: loginOtpTemplate,
  BUSINESS_ACCOUNT_EMAIL_OTP: businessAccountOtpTemplate,
  PICKUP_OTP: pickupOtpTemplate,
  RATE_CARD_SHARED: rateCardSharedTemplate,
  // Every other claim notification renders through the generic template; only
  // the decision needs to carry arithmetic and an appeal deadline.
  CLAIM_DECISION: claimDecisionTemplate
};

export function getEmailTemplate(templateKey: string): EmailTemplate {
  return registry[templateKey] ?? genericNotificationTemplate;
}

export function hasEmailTemplate(templateKey: string) {
  return templateKey in registry;
}
