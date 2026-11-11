import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export const announcementRoles = ["admin", "operations", "finance", "delivery", "hr", "client"] as const;
export type AnnouncementRole = (typeof announcementRoles)[number];
export const announcementStatuses = ["DRAFT", "PUBLISHED", "PAUSED", "ARCHIVED"] as const;
export type AnnouncementStatus = (typeof announcementStatuses)[number];

export type FeatureAnnouncementContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; imageId: mongoose.Types.ObjectId; alt: string };

export interface IFeatureAnnouncementImage {
  _id: mongoose.Types.ObjectId;
  originalName: string;
  storageKey: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  size: number;
  uploadedAt: Date;
}

export interface IFeatureAnnouncement extends mongoose.Document, TenantOwnedFields {
  title: string;
  summary: string;
  body: string;
  contentBlocks: FeatureAnnouncementContentBlock[];
  images: IFeatureAnnouncementImage[];
  targetHref: string;
  clientTargetHref: string | null;
  roles: AnnouncementRole[];
  videoUrl: string | null;
  status: AnnouncementStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  revision: number;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const announcementSchema = new mongoose.Schema<IFeatureAnnouncement>({
  title: { type: String, required: true, trim: true, maxlength: 100 },
  summary: { type: String, required: true, trim: true, maxlength: 180 },
  body: { type: String, required: true, trim: true, maxlength: 2000 },
  contentBlocks: {
    type: [new mongoose.Schema({
      type: { type: String, required: true, enum: ["text", "image"] },
      text: { type: String, maxlength: 2000 },
      imageId: { type: mongoose.Schema.Types.ObjectId },
      alt: { type: String, trim: true, maxlength: 200, default: "" }
    }, { _id: false })],
    default: []
  },
  images: {
    type: [new mongoose.Schema<IFeatureAnnouncementImage>({
      originalName: { type: String, required: true, trim: true, maxlength: 200 },
      storageKey: { type: String, required: true, trim: true, maxlength: 1024 },
      mimeType: { type: String, required: true, enum: ["image/jpeg", "image/png", "image/webp"] },
      size: { type: Number, required: true, min: 1 },
      uploadedAt: { type: Date, default: Date.now }
    })],
    default: []
  },
  targetHref: { type: String, required: true, maxlength: 180 },
  clientTargetHref: { type: String, default: null, maxlength: 180 },
  roles: { type: [String], required: true, enum: announcementRoles },
  videoUrl: { type: String, default: null, maxlength: 300 },
  status: { type: String, required: true, enum: announcementStatuses, default: "DRAFT" },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  revision: { type: Number, required: true, min: 1, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });
announcementSchema.index({ status: 1, startsAt: 1, endsAt: 1 }, { name: "announcement_window" });
addTenantOwnership(announcementSchema);
export const FeatureAnnouncement = mongoose.model<IFeatureAnnouncement>("FeatureAnnouncement", announcementSchema);

export interface IFeatureAnnouncementView extends mongoose.Document, TenantOwnedFields {
  announcementId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  seenRevision: number;
  seenAt: Date;
}
const viewSchema = new mongoose.Schema<IFeatureAnnouncementView>({
  announcementId: { type: mongoose.Schema.Types.ObjectId, ref: "FeatureAnnouncement", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  seenRevision: { type: Number, required: true, min: 1 },
  seenAt: { type: Date, required: true }
});
viewSchema.index({ tenantId: 1, userId: 1, announcementId: 1 }, { unique: true, name: "uniq_announcement_view" });
addTenantOwnership(viewSchema);
export const FeatureAnnouncementView = mongoose.model<IFeatureAnnouncementView>("FeatureAnnouncementView", viewSchema);
