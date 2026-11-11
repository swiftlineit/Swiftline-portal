import { requestJson } from "@/lib/shipmentsList";

export type AnnouncementRole = "admin" | "operations" | "finance" | "delivery" | "hr" | "client";
export type AnnouncementStatus = "DRAFT" | "PUBLISHED" | "PAUSED" | "ARCHIVED";
export type FeatureAnnouncementTextBlock = { type: "text"; text: string };
export type FeatureAnnouncementImageBlock = { type: "image"; imageId: string; alt: string; previewUrl?: string };
export type FeatureAnnouncementContentBlock = FeatureAnnouncementTextBlock | FeatureAnnouncementImageBlock;
export type FeatureAnnouncementDraftBlock = FeatureAnnouncementTextBlock | {
  type: "image"; imageId?: string; alt: string; file?: File; previewUrl?: string;
};
export type FeatureAnnouncement = {
  id: string; title: string; summary: string; body: string; targetHref: string; clientTargetHref: string | null;
  contentBlocks: FeatureAnnouncementContentBlock[]; roles: AnnouncementRole[]; videoUrl: string | null; status: AnnouncementStatus;
  startsAt: string | null; endsAt: string | null; revision: number; seen: boolean;
  createdAt: string; updatedAt: string;
};
export type FeatureAnnouncementInput = Pick<FeatureAnnouncement, "title" | "summary" | "body" | "targetHref" | "clientTargetHref" | "roles" | "videoUrl" | "status" | "startsAt" | "endsAt"> & {
  contentBlocks: FeatureAnnouncementDraftBlock[];
};
const base = "/api/v1/feature-announcements";

/** Defense in depth for previews and stored links: only known video players can enter an iframe. */
export function embeddableVideoUrl(input: string | null): string | null {
  if (!input) return null;
  let url: URL;
  const markdownLink = input.trim().match(/^\[[^\]]+\]\((https:\/\/[^)]+)\)$/);
  try { url = new URL(markdownLink?.[1] ?? input); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (host === "youtu.be") id = url.pathname.slice(1);
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"].includes(host)) {
    id = url.pathname === "/watch" ? url.searchParams.get("v") ?? undefined : url.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)$/)?.[1];
  }
  if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
    id = url.pathname.match(/^\/(?:video\/)?(\d+)$/)?.[1];
    if (id) return `https://player.vimeo.com/video/${id}`;
  }
  return null;
}

export async function listMyAnnouncements() {
  const result = await requestJson<{ data: { announcements: FeatureAnnouncement[] } }>(`${base}/mine`);
  return result.data.announcements;
}
export async function markAnnouncementSeen(id: string) {
  await requestJson(`${base}/${encodeURIComponent(id)}/seen`, { method: "POST" });
}
export async function listManagedAnnouncements(before?: string) {
  const result = await requestJson<{ data: { announcements: FeatureAnnouncement[]; nextCursor: string | null } }>(`${base}/manage${before ? `?before=${encodeURIComponent(before)}` : ""}`);
  return result.data;
}
export async function listAnnouncementTargets() {
  const result = await requestJson<{ data: { targets: Array<{ href: string; roles: AnnouncementRole[] }> } }>(`${base}/manage/targets`);
  return result.data.targets;
}
export async function saveAnnouncement(input: FeatureAnnouncementInput, id?: string) {
  const files: File[] = [];
  const contentBlocks = input.contentBlocks.map((block) => {
    if (block.type === "text") return block;
    if (block.file) {
      const fileIndex = files.push(block.file) - 1;
      return { type: "image" as const, fileIndex, alt: block.alt };
    }
    if (!block.imageId) throw new Error("Each guide image needs a file or a saved image reference.");
    return { type: "image" as const, imageId: block.imageId, alt: block.alt };
  });
  const formData = new FormData();
  formData.append("announcement", JSON.stringify({ ...input, contentBlocks }));
  files.forEach((file) => formData.append("images", file, file.name));
  const result = await requestJson<{ data: { announcement: FeatureAnnouncement } }>(id ? `${base}/manage/${id}` : `${base}/manage`, {
    method: id ? "PATCH" : "POST", body: formData
  });
  return result.data.announcement;
}

export function announcementImagePath(announcementId: string, imageId: string) {
  return `${base}/${encodeURIComponent(announcementId)}/images/${encodeURIComponent(imageId)}`;
}
