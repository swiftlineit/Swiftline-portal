import { Router, type Request, type Response, type NextFunction } from "express";
import mongoose from "mongoose";
import { attachUser, requireAuthenticated } from "../middleware/auth.middleware.js";
import { featureAnnouncementUpload } from "../middleware/featureAnnouncementUpload.middleware.js";
import { AuditLog } from "../models/auditLog.model.js";
import { FeatureAnnouncement, FeatureAnnouncementView, announcementRoles, type AnnouncementRole, type IFeatureAnnouncement } from "../models/featureAnnouncement.model.js";
import { allowedRolesForTarget, announcementInputSchema, announcementTargets, canonicalVideoUrl } from "../services/featureAnnouncement.service.js";
import { getTenantIdForWrite } from "../services/tenantScope.service.js";
import { matchesDeclaredType } from "../services/storage/fileSignature.js";
import { assertValidStorageKey, featureAnnouncementImageKey } from "../services/storage/keys.js";
import { deleteObject, putObject, StorageObjectNotFoundError, streamObjectToResponse } from "../services/storage/storage.service.js";

type Actor = { _id: mongoose.Types.ObjectId; role: AnnouncementRole };
const actor = (request: Request) => (request as Request & { user: Actor }).user;
const safe = (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => { void handler(request, response).catch(next); };
const validId = (id: unknown): id is string => typeof id === "string" && mongoose.isValidObjectId(id);

function dto(item: IFeatureAnnouncement, seen = false, role?: AnnouncementRole) {
  const contentBlocks = item.contentBlocks?.length
    ? item.contentBlocks.map((block) => block.type === "image"
      ? { type: "image" as const, imageId: String(block.imageId), alt: block.alt ?? "" }
      : { type: "text" as const, text: block.text ?? "" })
    : [{ type: "text" as const, text: item.body }];
  return {
    id: String(item._id), title: item.title, summary: item.summary, body: item.body, contentBlocks,
    targetHref: role === "client" && item.clientTargetHref ? item.clientTargetHref : item.targetHref,
    clientTargetHref: item.clientTargetHref, roles: item.roles, videoUrl: item.videoUrl,
    status: item.status, startsAt: item.startsAt, endsAt: item.endsAt,
    revision: item.revision, seen, createdAt: item.createdAt, updatedAt: item.updatedAt
  };
}

function contentBlockSnapshot(blocks: IFeatureAnnouncement["contentBlocks"]) {
  return JSON.stringify(blocks.map((block) => block.type === "image"
    ? { type: "image", imageId: String(block.imageId), alt: block.alt ?? "" }
    : { type: "text", text: block.text ?? "" }));
}

async function writeAudit(action: "FEATURE_ANNOUNCEMENT_CREATED" | "FEATURE_ANNOUNCEMENT_UPDATED" | "FEATURE_ANNOUNCEMENT_STATUS_CHANGED", item: IFeatureAnnouncement, by: mongoose.Types.ObjectId, previousStatus?: string) {
  await AuditLog.create({
    action, entityType: "FEATURE_ANNOUNCEMENT", entityId: item._id,
    performedBy: by, performedAt: new Date(),
    metadata: { status: item.status, previousStatus, revision: item.revision, roles: item.roles, targetHref: item.targetHref, clientTargetHref: item.clientTargetHref, startsAt: item.startsAt, endsAt: item.endsAt }
  });
}

export const featureAnnouncementRouter = Router();
featureAnnouncementRouter.use(attachUser, requireAuthenticated, (request, response, next) => {
  const role = (request as Request & { user?: { role?: string } }).user?.role;
  if (!role || !(announcementRoles as readonly string[]).includes(role)) {
    return response.status(403).json({ success: false, message: "This account does not have access to feature announcements." });
  }
  return next();
});
featureAnnouncementRouter.use((_request, response, next) => { response.setHeader("Cache-Control", "private, no-store"); next(); });

function requireAnnouncementManager(request: Request, response: Response, next: NextFunction) {
  const role = actor(request).role;
  if (role !== "admin" && role !== "operations") {
    return response.status(403).json({
      success: false,
      message: "Only admin or operations users can manage announcements. Sign in with an authorized staff account."
    });
  }
  return next();
}

featureAnnouncementRouter.get("/mine", safe(async (request, response) => {
  const user = actor(request);
  const now = new Date();
  const items = await FeatureAnnouncement.find({ status: "PUBLISHED", roles: user.role, startsAt: { $lte: now }, endsAt: { $gt: now } })
    .sort({ startsAt: -1, _id: -1 }).limit(50).exec();
  const views = await FeatureAnnouncementView.find({ userId: user._id, announcementId: { $in: items.map((item) => item._id) } }).select("announcementId seenRevision").lean().exec();
  const seen = new Map(views.map((view) => [String(view.announcementId), view.seenRevision]));
  response.json({ success: true, data: { announcements: items.map((item) => dto(item, (seen.get(String(item._id)) ?? 0) >= item.revision, user.role)) } });
}));

featureAnnouncementRouter.post("/:id/seen", safe(async (request, response) => {
  const user = actor(request);
  if (!validId(request.params.id)) { response.status(400).json({ success: false, message: "Invalid announcement." }); return; }
  const now = new Date();
  const item = await FeatureAnnouncement.findOne({ _id: request.params.id, status: "PUBLISHED", roles: user.role, startsAt: { $lte: now }, endsAt: { $gt: now } }).exec();
  if (!item) { response.status(404).json({ success: false, message: "Announcement is unavailable." }); return; }
  try {
    await FeatureAnnouncementView.updateOne(
      { userId: user._id, announcementId: item._id },
      { $max: { seenRevision: item.revision }, $set: { seenAt: now }, $setOnInsert: { userId: user._id, announcementId: item._id } },
      { upsert: true }
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 11000)) throw error;
    await FeatureAnnouncementView.updateOne({ userId: user._id, announcementId: item._id }, { $max: { seenRevision: item.revision }, $set: { seenAt: now } });
  }
  response.json({ success: true, data: { id: String(item._id), revision: item.revision } });
}));

featureAnnouncementRouter.get("/:id/images/:imageId", safe(async (request, response) => {
  const { id, imageId } = request.params;
  if (!validId(id) || !validId(imageId)) { response.status(404).json({ success: false, message: "Image not found." }); return; }
  const item = await FeatureAnnouncement.findById(id).exec();
  if (!item) { response.status(404).json({ success: false, message: "Image not found." }); return; }

  const user = actor(request);
  const manager = user.role === "admin" || user.role === "operations";
  const now = new Date();
  const activeForUser = item.status === "PUBLISHED"
    && item.roles.includes(user.role)
    && item.startsAt !== null && item.startsAt <= now
    && item.endsAt !== null && item.endsAt > now;
  if (!manager && !activeForUser) { response.status(404).json({ success: false, message: "Image not found." }); return; }

  const image = item.images?.find((entry) => String(entry._id) === imageId);
  if (!image) { response.status(404).json({ success: false, message: "Image not found." }); return; }
  try {
    assertValidStorageKey(image.storageKey);
    await streamObjectToResponse({ response, key: image.storageKey, contentType: image.mimeType, filename: image.originalName, disposition: "inline" });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) { response.status(404).json({ success: false, message: "Image not found." }); return; }
    throw error;
  }
}));

featureAnnouncementRouter.use("/manage", requireAnnouncementManager);
featureAnnouncementRouter.get("/manage/targets", (_request, response) => {
  response.json({ success: true, data: { targets: announcementTargets.map((href) => ({ href, roles: allowedRolesForTarget(href) })) } });
});
featureAnnouncementRouter.get("/manage", safe(async (request, response) => {
  const before = request.query.before;
  if (before !== undefined && !validId(before)) { response.status(400).json({ success: false, message: "Invalid announcement cursor." }); return; }
  const items = await FeatureAnnouncement.find(before ? { _id: { $lt: before } } : {}).sort({ _id: -1 }).limit(51).exec();
  const page = items.slice(0, 50);
  response.json({ success: true, data: { announcements: page.map((item) => dto(item)), nextCursor: items.length > 50 ? String(page[page.length - 1]!._id) : null } });
}));

function parseInput(request: Request, response: Response) {
  let payload: unknown = request.body;
  if (typeof request.body?.announcement === "string") {
    try { payload = JSON.parse(request.body.announcement); }
    catch { response.status(400).json({ success: false, message: "Announcement details could not be read." }); return null; }
  }
  const result = announcementInputSchema.safeParse(payload);
  if (!result.success) {
    response.status(400).json({ success: false, message: result.error.issues[0]?.message ?? "Invalid announcement." });
    return null;
  }
  try {
    const contentBlocks = result.data.contentBlocks ?? [{ type: "text" as const, text: result.data.body }];
    const body = contentBlocks.filter((block) => block.type === "text").map((block) => block.text.trim()).filter(Boolean).join("\n\n");
    return { ...result.data, body, contentBlocks, videoUrl: canonicalVideoUrl(result.data.videoUrl ?? null) };
  }
  catch (error) { response.status(400).json({ success: false, message: error instanceof Error ? error.message : "Invalid video URL." }); return null; }
}

function uploadedImages(request: Request) {
  return (request.files as Record<string, Express.Multer.File[]> | undefined)?.images ?? [];
}

async function buildMedia(
  itemId: mongoose.Types.ObjectId,
  input: NonNullable<ReturnType<typeof parseInput>>,
  files: Express.Multer.File[],
  existingImages: IFeatureAnnouncement["images"],
  response: Response
) {
  const blocks = input.contentBlocks;
  const imageBlocks = blocks.filter((block) => block.type === "image");
  const usedImageIds = imageBlocks.filter((block) => block.type === "image" && block.imageId).map((block) => block.imageId!);
  const fileIndexes = imageBlocks.filter((block) => block.type === "image" && block.fileIndex !== undefined).map((block) => block.fileIndex!);
  if (new Set(usedImageIds).size !== usedImageIds.length) {
    response.status(400).json({ success: false, message: "Place each saved image only once in the guide." });
    return null;
  }
  if (files.length !== fileIndexes.length || fileIndexes.some((index, position) => index !== position)) {
    response.status(400).json({ success: false, message: "The selected guide images could not be matched to the content." });
    return null;
  }
  if (imageBlocks.length > 4) {
    response.status(400).json({ success: false, message: "An announcement can include up to four images." });
    return null;
  }
  const existingById = new Map(existingImages.map((image) => [String(image._id), image]));
  if (usedImageIds.some((id) => !existingById.has(id))) {
    response.status(400).json({ success: false, message: "A saved guide image is no longer available. Reload the announcement and try again." });
    return null;
  }
  if (files.some((file) => !matchesDeclaredType(file.buffer, file.mimetype))) {
    response.status(400).json({ success: false, message: "An uploaded guide image does not match its file type." });
    return null;
  }

  const storedImages: IFeatureAnnouncement["images"] = [];
  const uploadedKeys: string[] = [];
  try {
    for (const file of files) {
      const stored = await putObject({ key: featureAnnouncementImageKey(String(itemId), file.originalname), body: file.buffer, contentType: file.mimetype, originalName: file.originalname });
      uploadedKeys.push(stored.key);
      storedImages.push({
        _id: new mongoose.Types.ObjectId(), originalName: file.originalname.slice(0, 200), storageKey: stored.key,
        mimeType: file.mimetype as IFeatureAnnouncement["images"][number]["mimeType"], size: file.size, uploadedAt: new Date()
      });
    }
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => deleteObject(key).catch(() => undefined)));
    throw error;
  }

  const newImageIds = storedImages.map((image) => String(image._id));
  let newImageIndex = 0;
  const contentBlocks = blocks.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text.trim() };
    if (block.imageId) return { type: "image" as const, imageId: new mongoose.Types.ObjectId(block.imageId), alt: block.alt };
    const imageId = new mongoose.Types.ObjectId(newImageIds[newImageIndex++]!);
    return { type: "image" as const, imageId, alt: block.alt };
  });
  const keptImages = existingImages.filter((image) => usedImageIds.includes(String(image._id)));
  return {
    body: contentBlocks.filter((block) => block.type === "text").map((block) => block.text.trim()).filter(Boolean).join("\n\n"),
    contentBlocks,
    images: [...keptImages, ...storedImages],
    removedStorageKeys: existingImages.filter((image) => !usedImageIds.includes(String(image._id))).map((image) => image.storageKey),
    uploadedKeys
  };
}

featureAnnouncementRouter.post("/manage", featureAnnouncementUpload, safe(async (request, response) => {
  const input = parseInput(request, response);
  if (!input) return;
  if (input.status === "ARCHIVED" || input.status === "PAUSED") { response.status(400).json({ success: false, message: "Create a draft before pausing or archiving." }); return; }
  const by = actor(request)._id;
  const tenantId = await getTenantIdForWrite();
  const item = new FeatureAnnouncement({ ...input, tenantId, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null, createdBy: by, updatedBy: by });
  const media = await buildMedia(item._id, input, uploadedImages(request), [], response);
  if (!media) return;
  item.set({ body: media.body, contentBlocks: media.contentBlocks, images: media.images });
  try { await item.save(); }
  catch (error) { await Promise.all(media.uploadedKeys.map((key) => deleteObject(key).catch(() => undefined))); throw error; }
  await writeAudit("FEATURE_ANNOUNCEMENT_CREATED", item, by);
  response.status(201).json({ success: true, data: { announcement: dto(item) } });
}));

featureAnnouncementRouter.patch("/manage/:id", featureAnnouncementUpload, safe(async (request, response) => {
  if (!validId(request.params.id)) { response.status(400).json({ success: false, message: "Invalid announcement." }); return; }
  const input = parseInput(request, response);
  if (!input) return;
  const item = await FeatureAnnouncement.findById(request.params.id).exec();
  if (!item) { response.status(404).json({ success: false, message: "Announcement not found in this workspace." }); return; }
  if (item.status === "ARCHIVED") { response.status(409).json({ success: false, message: "Archived announcements cannot be changed." }); return; }
  if (item.status === "DRAFT" && input.status === "PAUSED") { response.status(400).json({ success: false, message: "Publish before pausing an announcement." }); return; }
  const media = await buildMedia(item._id, input, uploadedImages(request), item.images ?? [], response);
  if (!media) return;
  const previousStatus = item.status;
  const contentChanged = item.title !== input.title || item.summary !== input.summary || item.body !== media.body || item.videoUrl !== input.videoUrl || item.targetHref !== input.targetHref || item.clientTargetHref !== (input.clientTargetHref ?? null) || JSON.stringify([...item.roles].sort()) !== JSON.stringify([...input.roles].sort()) || contentBlockSnapshot(item.contentBlocks ?? []) !== JSON.stringify(media.contentBlocks.map((block) => block.type === "image"
    ? { type: "image", imageId: String(block.imageId), alt: block.alt ?? "" }
    : { type: "text", text: block.text ?? "" }));
  if (contentChanged && (item.status === "PUBLISHED" || input.status === "PUBLISHED")) item.revision += 1;
  item.set({ ...input, body: media.body, contentBlocks: media.contentBlocks, images: media.images, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null, updatedBy: actor(request)._id });
  try { await item.save(); }
  catch (error) { await Promise.all(media.uploadedKeys.map((key) => deleteObject(key).catch(() => undefined))); throw error; }
  await Promise.all(media.removedStorageKeys.map((key) => deleteObject(key).catch(() => undefined)));
  await writeAudit(previousStatus !== item.status ? "FEATURE_ANNOUNCEMENT_STATUS_CHANGED" : "FEATURE_ANNOUNCEMENT_UPDATED", item, actor(request)._id, previousStatus);
  response.json({ success: true, data: { announcement: dto(item) } });
}));
