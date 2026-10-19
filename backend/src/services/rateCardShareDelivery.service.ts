import { env } from "../config/env.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import type { IEmailAttachmentRef } from "../models/emailOutbox.model.js";
import type { IRateCardShare } from "../models/rateCardShare.model.js";
import { enqueueEmails, resolveUserRecipients, type EmailRecipient } from "./email/enqueue.js";
import { formatShareService, shareDocumentBasename } from "./rateCardShare.service.js";
import { buildShareLinks, buildWhatsAppLink, buildWhatsAppMessage, summariseShare } from "./rateCardShareMessage.service.js";

// The commercial audience inside a business account. Tracking-only members book
// nothing and price nothing, so a rate card is noise to them.
const RATE_CARD_MEMBER_ROLES = ["account_owner", "account_admin", "operations", "finance"] as const;

function money(value: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(value)} / kg`;
}

function buildAttachmentRefs(share: IRateCardShare): IEmailAttachmentRef[] {
  const basename = shareDocumentBasename(share);
  // PDF first: resolveAttachments drops from the tail when the size budget runs
  // out, and the PDF is the copy a customer actually reads.
  return [
    { kind: "RATE_CARD_SHARE_PDF", refId: share._id as IEmailAttachmentRef["refId"], filename: `${basename}.pdf` },
    { kind: "RATE_CARD_SHARE_XLSX", refId: share._id as IEmailAttachmentRef["refId"], filename: `${basename}.xlsx` }
  ];
}

function buildEmailPayload(share: IRateCardShare, viewUrl: string, senderName: string) {
  const summary = summariseShare(share);
  const { terms } = share;

  return {
    shareNumber: share.shareNumber,
    documentType: share.adjustmentMode === "NONE" ? "RATE_CARD" : "EXTERNAL_PROPOSAL",
    title: share.title,
    currency: share.currency,
    viewUrl,
    senderName,
    validFrom: terms.validFrom.toISOString(),
    validUntil: terms.validUntil.toISOString(),
    countryCount: summary.countryCount,
    slabCount: summary.slabCount,
    highlights: summary.bestRates
      .filter((entry) => entry.lowest > 0)
      .map((entry) => ({ service: formatShareService(entry.service), lowest: money(entry.lowest, share.currency) })),
    termsRows: [
      terms.fuelSurchargePercent > 0 ? { label: "Fuel surcharge", value: `${terms.fuelSurchargePercent}%` } : null,
      terms.gstPercent > 0 ? { label: "GST", value: `${terms.gstPercent}% included as applicable` } : null,
      terms.minChargeableWeightKg > 0 ? { label: "Min chargeable weight", value: `${terms.minChargeableWeightKg} kg` } : null,
      terms.volumetricDivisor > 0 ? { label: "Volumetric divisor", value: `L x W x H (cm) / ${terms.volumetricDivisor}` } : null,
      terms.remarks.trim() ? { label: "Terms", value: terms.remarks.trim() } : null
    ].filter(Boolean)
  };
}

/**
 * Queues the rate card email to every addressable recipient and returns the
 * ready-to-open WhatsApp links.
 *
 * Business-account recipients deliberately get no PortalNotification: the rate
 * card tray in the client shell is its own inbox, and writing a bell
 * notification too would announce the same thing twice.
 */
export async function deliverRateCardShare(input: {
  share: IRateCardShare;
  token: string;
  senderName: string;
}) {
  const { share, token, senderName } = input;
  const links = buildShareLinks(env.CLIENT_URL, String(share._id), token);

  let enqueued = 0;

  if (share.channels.includes("EMAIL")) {
    const memberUserIds = share.recipientAccounts.length
      ? (await BusinessAccountMember.find({
        businessAccount: { $in: share.recipientAccounts.map((account) => account.businessAccountId) },
        status: "active",
        role: { $in: RATE_CARD_MEMBER_ROLES }
      }).select("user").lean().exec()).map((member) => member.user)
      : [];

    const recipients: EmailRecipient[] = [
      ...await resolveUserRecipients(memberUserIds),
      ...share.recipientEmails.map((entry) => ({ userId: null, email: entry.email, name: entry.name }))
    ];

    const result = await enqueueEmails({
      notificationType: "RATE_CARD_SHARED",
      // Keyed on the share, which is created once per send, so a retried
      // request cannot mail the same customer the same card twice.
      idempotencyKey: `RATE_CARD_SHARED:${String(share._id)}`,
      recipients,
      businessAccountId: share.recipientAccounts.length === 1 ? share.recipientAccounts[0]?.businessAccountId ?? null : null,
      subject: `${share.adjustmentMode === "NONE" ? "Swiftline rate card" : "Swiftline external rate proposal"} - ${share.shareNumber}`,
      templateKey: "RATE_CARD_SHARED",
      payload: buildEmailPayload(share, links.view, senderName),
      attachmentRefs: buildAttachmentRefs(share)
    });

    enqueued = result.enqueued;
  }

  const whatsappLinks = share.channels.includes("WHATSAPP")
    ? share.recipientPhones.map((entry) => {
      const message = buildWhatsAppMessage({ share, links, recipientName: entry.name, senderName });
      return { phone: entry.phone, name: entry.name, url: buildWhatsAppLink(entry.phone, message), message };
    })
    : [];

  return { links, emailsQueued: enqueued, whatsappLinks };
}
