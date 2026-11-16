import type { EmailContent, EmailBlock } from "../layout.js";
import { asText, firstNameOf, toAbsoluteUrl } from "../format.js";
import type { EmailTemplateContext } from "./index.js";

/** Client-facing account notice. Internal audit reasons are never passed here. */
export function businessAccountSuspensionTemplate({ recipientName, payload, appUrl }: EmailTemplateContext): EmailContent {
  const accountName = asText(payload.accountName, "your business account");
  const accountId = asText(payload.accountId, "");
  const securityLock = payload.suspensionMode === "SECURITY_LOCK";
  const clientMessage = asText(payload.clientMessage, "").trim();
  const supportTeam = asText(payload.supportTeam, "your Swiftline branch");
  const href = asText(payload.href, "");
  const modeLabel = securityLock ? "security lock" : "operational hold";

  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: `Dear ${firstNameOf(recipientName)},` },
    { kind: "paragraph", text: `We have placed ${accountName} on a ${modeLabel}.` },
    ...(accountId ? [{ kind: "facts" as const, rows: [{ label: "Account ID", value: accountId }] }] : []),
    {
      kind: "paragraph",
      text: securityLock
        ? "Access to this business account, including its records and payments, is temporarily unavailable."
        : "New bookings and account changes are paused. Your team can still review shipments and documents, pay existing dues, and contact support."
    },
    ...(clientMessage ? [{ kind: "callout" as const, tone: "info" as const, text: clientMessage }] : []),
    { kind: "paragraph", text: `Please contact ${supportTeam} for assistance or to discuss the next steps.` },
    ...(!securityLock && href ? [{ kind: "button" as const, label: "View business account", url: toAbsoluteUrl(appUrl, href) }] : [])
  ];

  return {
    subject: `Business account update: ${accountName}`,
    preheader: `${accountName} has been placed on a ${modeLabel}.`,
    heading: securityLock ? "Business account security lock" : "Business account operational hold",
    blocks
  };
}
