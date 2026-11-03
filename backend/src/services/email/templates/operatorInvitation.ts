import type { EmailContent } from "../layout.js";
import type { EmailTemplateContext } from "./index.js";
import { asText, firstNameOf, formatDateTime } from "../format.js";

export function operatorInvitationTemplate(context: EmailTemplateContext): EmailContent {
  const { payload, recipientName } = context;
  const companyName = asText(payload.companyName, "your operator company");

  return {
    subject: `Set up your ${companyName} operator portal`,
    preheader: "Accept your invitation to manage your company's portal.",
    heading: "Your operator portal invitation",
    blocks: [
      { kind: "paragraph", text: `Hello ${firstNameOf(recipientName)},` },
      {
        kind: "paragraph",
        text: `You have been invited to administer ${companyName}'s separate portal workspace on the Swiftline domain. Operator administrator access is separate from Swiftline staff permissions and does not grant access to Swiftline's operational portal.`
      },
      { kind: "button", label: "Accept invitation", url: asText(payload.activationUrl, "") },
      {
        kind: "callout",
        tone: "warning",
        text: `This invitation expires on ${formatDateTime(payload.expiresAt as string)}.`
      },
      { kind: "note", text: "If you already use Swiftline Portal, sign in with that account before accepting. If you were not expecting this invitation, ignore this email." }
    ]
  };
}
