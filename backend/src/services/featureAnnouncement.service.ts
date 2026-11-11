import { z } from "zod";
import { announcementRoles, announcementStatuses } from "../models/featureAnnouncement.model.js";

// These are actual sidebar destinations. Keep this list aligned when navigation changes.
export const announcementTargets = [
  "/dashboard", "/dashboard/shipments?view=all", "/dashboard/tracking", "/dashboard/amendments",
  "/dashboard/cancellations", "/dashboard/shipment-manifests", "/dashboard/operations-manifests",
  "/dashboard/flight-linehauls", "/dashboard/operations-scans", "/dashboard/pickups", "/dashboard/drivers",
  "/dashboard/pod", "/dashboard/operations-advisory", "/dashboard/flight-cost-drafts",
  "/dashboard/swiftline-routes", "/dashboard/quote-requests", "/dashboard/counter-sales",
  "/dashboard/country-rate-card", "/dashboard/finance/profitability", "/dashboard/business-accounts",
  "/dashboard/credit-accounts", "/dashboard/branches", "/dashboard/users",
  "/dashboard/tickets", "/dashboard/claims",
  "/client/dashboard", "/client/dpd-labels", "/client/dpd-labels#drafts", "/client/shipments",
  "/client/address-book", "/client/tracking", "/client/pickups", "/client/manifests", "/client/pods",
  "/client/exceptions", "/client/actions", "/client/documents", "/client/customs", "/client/get-quote",
  "/client/quotes", "/client/rate-card", "/client/serviceability", "/client/credit",
  "/client/credit/statements", "/client/payments", "/client/claims", "/client/tickets",
  "/client/profile", "/client/team", "/client/activity", "/client/operations-calendar"
] as const;

const operationsOnly = new Set<string>([
  "/dashboard/amendments", "/dashboard/cancellations", "/dashboard/shipment-manifests",
  "/dashboard/operations-manifests", "/dashboard/flight-linehauls", "/dashboard/operations-scans",
  "/dashboard/pickups", "/dashboard/drivers", "/dashboard/pod", "/dashboard/operations-advisory",
  "/dashboard/flight-cost-drafts", "/dashboard/swiftline-routes", "/dashboard/quote-requests",
  "/dashboard/business-accounts", "/dashboard/tickets"
]);
const shipmentView = new Set<string>(["/dashboard/shipments?view=all", "/dashboard/tracking"]);
const operationsFinance = new Set<string>(["/dashboard/counter-sales", "/dashboard/country-rate-card", "/dashboard/credit-accounts"]);

export function allowedRolesForTarget(target: string): readonly (typeof announcementRoles)[number][] {
  if (target.startsWith("/client/")) return ["client"];
  if (target === "/dashboard") return ["admin", "operations", "finance", "delivery", "hr"];
  if (operationsOnly.has(target)) return ["admin", "operations"];
  if (shipmentView.has(target)) return ["admin", "operations", "delivery"];
  if (operationsFinance.has(target)) return ["admin", "operations", "finance"];
  if (target === "/dashboard/finance/profitability") return ["admin", "finance"];
  if (target === "/dashboard/branches") return ["admin", "operations", "finance", "hr"];
  if (target === "/dashboard/users") return ["admin", "hr"];
  if (target === "/dashboard/claims") return ["admin", "operations", "finance", "delivery"];
  return ["admin"]; // Remaining known staff destination: Operators.
}

export function canonicalVideoUrl(input: string | null): string | null {
  if (!input) return null;
  let url: URL;
  const markdownLink = input.trim().match(/^\[[^\]]+\]\((https:\/\/[^)]+)\)$/);
  try { url = new URL(markdownLink?.[1] ?? input); } catch { throw new Error("Enter a valid YouTube or Vimeo URL."); }
  if (url.protocol !== "https:") throw new Error("Video links must use HTTPS.");
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (host === "youtu.be") id = url.pathname.slice(1);
  if (host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com" || host === "www.youtube-nocookie.com") {
    id = url.pathname === "/watch" ? url.searchParams.get("v") ?? undefined : url.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)$/)?.[1];
  }
  if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (host === "vimeo.com" || host === "www.vimeo.com" || host === "player.vimeo.com") {
    id = url.pathname.match(/^\/(?:video\/)?(\d+)$/)?.[1];
    if (id) return `https://player.vimeo.com/video/${id}`;
  }
  throw new Error("Use a standard YouTube or Vimeo video URL.");
}

const announcementContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(2000) }),
  z.object({
    type: z.literal("image"),
    imageId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
    fileIndex: z.number().int().min(0).max(3).optional(),
    alt: z.string().trim().max(200).default("")
  }).refine((block) => Boolean(block.imageId) !== (block.fileIndex !== undefined), {
    message: "Each guide image must reference an existing image or an uploaded file."
  })
]);

export const announcementInputSchema = z.object({
  title: z.string().trim().min(3).max(100),
  summary: z.string().trim().min(10).max(180),
  body: z.string().trim().min(10).max(2000),
  contentBlocks: z.array(announcementContentBlockSchema).max(9).optional(),
  targetHref: z.enum(announcementTargets),
  clientTargetHref: z.enum(announcementTargets).nullable().optional(),
  roles: z.array(z.enum(announcementRoles)).min(1).max(announcementRoles.length),
  videoUrl: z.string().trim().max(300).nullable().optional(),
  status: z.enum(announcementStatuses),
  startsAt: z.string().datetime({ offset: true }).nullable(),
  endsAt: z.string().datetime({ offset: true }).nullable()
}).superRefine((value, context) => {
  if (value.contentBlocks) {
    const imageBlocks = value.contentBlocks.filter((block) => block.type === "image");
    const text = value.contentBlocks.filter((block) => block.type === "text").map((block) => block.text.trim()).filter(Boolean).join("\n\n");
    if (imageBlocks.length > 4) {
      context.addIssue({ code: "custom", path: ["contentBlocks"], message: "An announcement can include up to four images." });
    }
    if (text.length < 10 || text.length > 2000) {
      context.addIssue({ code: "custom", path: ["contentBlocks"], message: "Details must include 10 to 2,000 characters of text." });
    }
    const fileIndexes = imageBlocks.filter((block) => block.fileIndex !== undefined).map((block) => block.fileIndex);
    const imageIds = imageBlocks.filter((block) => block.imageId).map((block) => block.imageId);
    if (new Set(fileIndexes).size !== fileIndexes.length || new Set(imageIds).size !== imageIds.length) {
      context.addIssue({ code: "custom", path: ["contentBlocks"], message: "Each guide image can only be placed once." });
    }
  }
  const staff = value.roles.filter((role) => role !== "client");
  const client = value.roles.includes("client");
  if (staff.some((role) => !allowedRolesForTarget(value.targetHref).includes(role)) || (client && !staff.length && !allowedRolesForTarget(value.targetHref).includes("client"))) {
    context.addIssue({ code: "custom", path: ["roles"], message: "Every selected role must have access to the menu destination." });
  }
  if (client && staff.length && (!value.clientTargetHref || !allowedRolesForTarget(value.clientTargetHref).includes("client"))) {
    context.addIssue({ code: "custom", path: ["clientTargetHref"], message: "Choose a client menu destination for this shared announcement." });
  }
  if ((!client || !staff.length) && value.clientTargetHref) {
    context.addIssue({ code: "custom", path: ["clientTargetHref"], message: "A second destination is only used for shared staff and client announcements." });
  }
  if (value.status === "PUBLISHED" && !value.startsAt) {
    context.addIssue({ code: "custom", path: ["startsAt"], message: "A publication time is required." });
  }
  if (value.status === "PUBLISHED" && !value.endsAt) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "An end time is required." });
  }
  if (value.status === "PUBLISHED" && value.endsAt && Date.parse(value.endsAt) <= Date.now()) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "End time must be in the future." });
  }
  if (value.startsAt && value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "End time must follow publication time." });
  }
});
