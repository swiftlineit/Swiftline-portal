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
  manifestNumber: string;
  branchId: mongoose.Types.ObjectId;
  status: string;
  manifest: Record<string, unknown>;
  documents: ArchivedManifestDocument[];
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
  manifestNumber: { type: String, required: true, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, required: true },
  manifest: { type: mongoose.Schema.Types.Mixed, required: true },
  documents: { type: [documentSchema], default: [] },
  archivedAt: { type: Date, required: true, index: true },
  archivedBy: { type: mongoose.Schema.Types.ObjectId, required: true }
}, { versionKey: false });

export const OperationsManifestArchive = mongoose.model<IOperationsManifestArchive>("OperationsManifestArchive", schema);
