import type { EmailContent } from "../layout.js";
import type { EmailTemplateContext } from "./index.js";
import { asText, firstNameOf, formatDateTime } from "../format.js";

export function clientInvitationTemplate(context: EmailTemplateContext): EmailContent {
  const { payload, recipientName } = context;
  const companyName = asText(payload.companyName, "your organisation");
  const requiresSignIn = payload.requiresSignIn === true;
  const actionLabel = requiresSignIn ? "Sign in and accept access" : "Create your password";

  return {
    subject: requiresSignIn
      ? `Accept your Swiftline Portal access for ${companyName}`
      : `Activate your Swiftline Portal access for ${companyName}`,
    preheader: requiresSignIn
      ? "Sign in with your existing account to accept this access."
      : "Create your password to activate your Swiftline Portal account.",
    heading: requiresSignIn ? "Accept your portal access" : "Activate your portal access",
    blocks: [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      {
        kind: "paragraph",
        text: requiresSignIn
          ? `You have been invited to access ${companyName} on the Swiftline Portal. Sign in with your existing portal account to accept this access. Your password will not change.`
          : `You have been invited to access ${companyName} on the Swiftline Portal. Use the secure link below to create your password and activate your account.`
      },
      { kind: "button", label: actionLabel, url: asText(payload.activationUrl, "") },
      {
        kind: "callout",
        tone: "warning",
        text: `This activation link expires on ${formatDateTime(payload.expiresAt as string)}.`
      },
      { kind: "note", text: "If you were not expecting this invitation you can safely ignore this email." }
    ]
  };
}
