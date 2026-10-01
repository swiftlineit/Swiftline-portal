import mongoose from "mongoose";

export type ArchivedManifestDocument = {
  format: "xlsx" | "pdf" | "edi" | "opsEdi" | "mhbs" | "csbVEdi" | "uk";
  key: string;
  filename: string;
  contentType: string;
  checksumSha256: string;
};

export interface IOperationsManifestArchive extends mongoose.Document {
  _id: mongoose.Types.ObjectId;
  originalManifestId?: mongoose.Types.ObjectId | null;
  recordType: "ARCHIVED";
  manifestNumber: string;
  branchId: mongoose.Types.ObjectId;
  status: string;
  manifest: Record<string, unknown>;
  linkedFlight: Record<string, unknown> | null;
  documents: ArchivedManifestDocument[];
  deletionMode: "ARCHIVE" | "PERMANENT";
  deletionReason: string;
  archivedAt: Date;
  archivedBy: mongoose.Types.ObjectId;
}

const documentSchema = new mongoose.Schema<ArchivedManifestDocument>({
  format: { type: String, required: true },
  key: { type: String, required: true },
  filename: { type: String, required: true },
  contentType: { type: String, required: true },
  checksumSha256: { type: String, required: true }
}, { _id: false });

const schema = new mongoose.Schema<IOperationsManifestArchive>({
  _id: { type: mongoose.Schema.Types.ObjectId, required: true },
  originalManifestId: { type: mongoose.Schema.Types.ObjectId, default: null },
  recordType: { type: String, enum: ["ARCHIVED"], default: "ARCHIVED", required: true },
  manifestNumber: { type: String, required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, required: true },
  manifest: { type: mongoose.Schema.Types.Mixed, required: true },
  linkedFlight: { type: mongoose.Schema.Types.Mixed, default: null },
  documents: { type: [documentSchema], default: [] },
  deletionMode: { type: String, enum: ["ARCHIVE", "PERMANENT"], default: "ARCHIVE", required: true },
  deletionReason: { type: String, trim: true, maxlength: 500, default: "" },
  archivedAt: { type: Date, required: true, index: true },
  archivedBy: { type: mongoose.Schema.Types.ObjectId, required: true }
}, { versionKey: false });

schema.index(
  { branchId: 1, archivedAt: -1 },
  { name: "idx_operations_manifest_archive_branch_archived" }
);

export const OperationsManifestArchive = mongoose.model<IOperationsManifestArchive>("OperationsManifestArchive", schema);
