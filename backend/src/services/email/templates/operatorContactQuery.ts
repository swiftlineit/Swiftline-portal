import type { EmailContent } from "../layout.js";
import type { EmailTemplateContext } from "./index.js";
import { asText, toAbsoluteUrl } from "../format.js";

export function operatorContactQueryStaffTemplate({ payload, appUrl }: EmailTemplateContext): EmailContent {
  const awbNumbers = Array.isArray(payload.awbNumbers)
    ? payload.awbNumbers.filter((value): value is string => typeof value === "string")
    : [];
  return {
    subject: `${payload.kind === "ISSUE" ? "Client issue" : "Client help request"}: ${asText(payload.subject)}`,
    preheader: `${asText(payload.businessAccountName)} · ${asText(payload.contactName)}`,
    heading: payload.kind === "ISSUE" ? "New client issue" : "New client help request",
    blocks: [
      { kind: "facts", rows: [
        { label: "Business account", value: asText(payload.businessAccountName) },
        { label: "Contact", value: asText(payload.contactName) },
        { label: "Email", value: asText(payload.contactEmail) },
        { label: "Phone", value: asText(payload.contactPhone, "Not provided") },
        ...(awbNumbers.length ? [{ label: "AWB numbers", value: awbNumbers.join(", ") }] : [])
      ] },
      { kind: "paragraph", text: asText(payload.message) },
      { kind: "button", label: "View query", url: toAbsoluteUrl(appUrl, asText(payload.href)) }
    ]
  };
}
