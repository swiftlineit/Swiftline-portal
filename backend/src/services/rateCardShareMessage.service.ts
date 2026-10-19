import type { IRateCardShare } from "../models/rateCardShare.model.js";
import { buildPublicShareUrl, formatShareService, groupShareRows, rateCardDisplayAmount } from "./rateCardShare.service.js";

function date(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata"
  }).format(value);
}

function rate(value: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(value)}`;
}

export type RateCardShareLinks = {
  view: string;
  pdf: string;
  excel: string;
};

/**
 * Every outbound link points at the portal's own public rate card page, which
 * holds the token and fetches the document itself. Keeping one origin means the
 * recipient sees a Swiftline URL rather than a raw API host, and the download
 * links survive the API moving behind a different domain.
 */
export function buildShareLinks(appUrl: string, shareId: string, token: string): RateCardShareLinks {
  const view = buildPublicShareUrl(appUrl, shareId, token);
  return {
    view,
    pdf: `${view}&download=pdf`,
    excel: `${view}&download=excel`
  };
}

/**
 * The lowest rate in each service, which is the number a customer scans for
 * first. Used as the teaser in WhatsApp and the email preheader rather than
 * dumping the whole tariff into a chat bubble.
 */
export function summariseShare(share: IRateCardShare) {
  const groups = groupShareRows(share.rows);
  const countries = new Set(groups.map((group) => group.countryCode));
  const services = [...new Set(groups.map((group) => group.service))];
  const bestRates = services.map((service) => {
    const rates = share.rows.filter((row) => row.service === service).map((row) => rateCardDisplayAmount(row));
    return { service, lowest: rates.length ? Math.min(...rates) : 0 };
  });

  return { countryCount: countries.size, slabCount: share.rows.length, services, bestRates, groups };
}

/**
 * WhatsApp body text. Uses WhatsApp's own markup (*bold*, _italic_) rather than
 * HTML, and stays short: a chat message that has to be scrolled does not get
 * read, so the tariff itself lives behind the link.
 */
export function buildWhatsAppMessage(input: {
  share: IRateCardShare;
  links: RateCardShareLinks;
  recipientName: string;
  senderName: string;
}) {
  const { share, links, recipientName, senderName } = input;
  const summary = summariseShare(share);
  const greeting = recipientName.trim() ? `Hello ${recipientName.trim().split(/\s+/)[0]},` : "Hello,";
  const isExternalProposal = share.adjustmentMode !== "NONE";
  const documentLabel = isExternalProposal ? "external rate proposal" : "rate card";

  const highlights = summary.bestRates
    .filter((entry) => entry.lowest > 0)
    .map((entry) => `• ${formatShareService(entry.service)} from *${rate(entry.lowest, share.currency)}* / kg`);

  const extras = [
    share.terms.fuelSurchargePercent > 0 ? `• Fuel surcharge: ${share.terms.fuelSurchargePercent}%` : "",
    share.terms.gstPercent > 0 ? `• GST: ${share.terms.gstPercent}% included as applicable` : "",
    share.terms.minChargeableWeightKg > 0 ? `• Min chargeable weight: ${share.terms.minChargeableWeightKg} kg` : "",
    share.terms.remarks.trim() ? `• Terms: ${share.terms.remarks.trim()}` : ""
  ].filter(Boolean);

  return [
    isExternalProposal ? `*SWIFTLINE - EXTERNAL RATE PROPOSAL*` : `*SWIFTLINE - YOUR RATE CARD*`,
    `_Ref ${share.shareNumber}_`,
    "",
    greeting,
    "",
    `Please find our latest ${documentLabel}, ${share.title}, covering *${summary.countryCount} ${summary.countryCount === 1 ? "destination" : "destinations"}* across ${summary.slabCount} weight ${summary.slabCount === 1 ? "slab" : "slabs"}.`,
    ...(highlights.length ? ["", ...highlights] : []),
    "",
    `*Valid:* ${date(share.terms.validFrom)} to ${date(share.terms.validUntil)}`,
    ...(extras.length ? extras : []),
    "",
    `*View the full ${documentLabel}*`,
    links.view,
    "",
    `*Download PDF*`,
    links.pdf,
    "",
    `*Download Excel*`,
    links.excel,
    "",
    `Rates exclude duties, destination-country taxes and destination charges. Happy to walk you through the details.`,
    "",
    `Regards,`,
    senderName,
    `Swiftline`
  ].join("\n");
}

/**
 * A wa.me click-to-chat link. The phone must be digits only in international
 * form; anything else and wa.me silently opens an empty chat, so a recipient
 * without a usable number gets a text-only link the sender can paste manually.
 */
export function buildWhatsAppLink(phone: string, message: string) {
  const digits = phone.replace(/\D/g, "");
  const text = encodeURIComponent(message);
  return digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`;
}
