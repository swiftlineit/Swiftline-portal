import mongoose from "mongoose";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import type { IOperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestArchive, type ArchivedManifestDocument } from "../models/operationsManifestArchive.model.js";
import { buildManifestDocumentModel, parseCurrentManifestSnapshot } from "./manifestDocument.service.js";
import { buildOperationsManifestExcel, buildOperationsManifestPdf, OperationsManifestServiceError } from "./operationsManifest.service.js";
import { buildOperationsManifestEdi } from "./edi/ediExport.service.js";
import { buildOperationsManifestOpsEdi } from "./opsEdi/opsEdiExport.service.js";
import { buildOperationsManifestMhbsEdi } from "./mhbsEdi/mhbsEdiExport.service.js";
import { buildOperationsManifestCsbVEdi } from "./csbVEdi/csbVEdiExport.service.js";
import { buildOperationsManifestUkExcel, ukOperationsManifestFilename } from "./operationsManifestUk.service.js";
import { operationsManifestArchiveKey } from "./storage/keys.js";
import { deleteObject, putObject } from "./storage/storage.service.js";

type ArchiveFormat = ArchivedManifestDocument["format"];
type PreparedDocument = { format: ArchiveFormat; filename: string; contentType: string; buffer: Buffer };

/** Render while the live manifest and its draft references still exist. */
export async function stageOperationsManifestArchive(manifest: IOperationsManifest) {
  const snapshot = parseCurrentManifestSnapshot(manifest.sealedSnapshot, manifest.header);
  if (!snapshot) throw new OperationsManifestServiceError("This issued manifest has no sealed snapshot to archive.", 409);

  const model = buildManifestDocumentModel(snapshot);
  const draftIds = [...new Set(model.consignments.map((item) => item.shipmentDraftId))];
  const drafts = await ShipmentDraft.find({ _id: { $in: draftIds } }).select("csbType").lean().exec();
  const csbVOnly = draftIds.length > 0 && drafts.length === draftIds.length && drafts.every((draft) => draft.csbType === "CSB_V");
  const number = manifest.manifestNumber;
  const documents: PreparedDocument[] = [
    { format: "xlsx", filename: `ops-manifest-${number}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await buildOperationsManifestExcel(manifest) },
    { format: "pdf", filename: `ops-manifest-${number}.pdf`, contentType: "application/pdf", buffer: await buildOperationsManifestPdf(manifest) },
  ];

  const optional: Array<{ format: ArchiveFormat; filename: string; contentType: string; build: () => Promise<Buffer> }> = [
    { format: "edi", filename: `edi-${number}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", build: () => buildOperationsManifestEdi(manifest) },
    { format: "opsEdi", filename: `ops-edi-${number}.xls`, contentType: "application/vnd.ms-excel", build: async () => (await buildOperationsManifestOpsEdi(manifest)).buffer },
    { format: "mhbs", filename: `mhbs-${number}.xls`, contentType: "application/vnd.ms-excel", build: async () => (await buildOperationsManifestMhbsEdi(manifest)).buffer },
  ];
  if (csbVOnly) optional.push({ format: "csbVEdi", filename: `csb-v-${number}.xls`, contentType: "application/vnd.ms-excel", build: () => buildOperationsManifestCsbVEdi(manifest) });
  if (snapshot.header.destinationCountryCode === "GB") optional.push({ format: "uk", filename: ukOperationsManifestFilename(number), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", build: () => buildOperationsManifestUkExcel(manifest) });

  // An issued export must not silently disappear during deletion. If one cannot
  // be rendered, leave the live manifest intact so staff can resolve it first.
  for (const item of optional) {
    documents.push({ ...item, buffer: await item.build() });
  }

  const stored: ArchivedManifestDocument[] = [];
  try {
    for (const document of documents) {
      const key = operationsManifestArchiveKey(String(manifest._id), document.filename);
      const result = await putObject({ key, body: document.buffer, contentType: document.contentType });
      stored.push({ format: document.format, key: result.key, filename: document.filename, contentType: document.contentType, checksumSha256: result.checksumSha256 });
    }
    return stored;
  } catch (error) {
    await Promise.allSettled(stored.map((document) => deleteObject(document.key)));
    throw error;
  }
}

export async function removeStagedArchiveDocuments(documents: ArchivedManifestDocument[]) {
  await Promise.allSettled(documents.map((document) => deleteObject(document.key)));
}

export async function listOperationsManifestArchives(allowedBranchIds: string[] | null, page: number, limit: number) {
  const filter = allowedBranchIds === null ? {} : { branchId: { $in: allowedBranchIds } };
  const [items, total] = await Promise.all([
    OperationsManifestArchive.find(filter).sort({ archivedAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
    OperationsManifestArchive.countDocuments(filter).exec()
  ]);
  return {
    items: items.map((item) => ({
      id: String(item._id), manifestNumber: item.manifestNumber, status: item.status,
      branchId: String(item.branchId), archivedAt: item.archivedAt,
      header: (item.manifest as Record<string, unknown>).header,
      documents: item.documents.map(({ format, filename }) => ({ format, filename }))
    })),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  };
}

export async function getOperationsManifestArchive(id: string, allowedBranchIds: string[] | null) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new OperationsManifestServiceError("Archived manifest was not found.", 404);
  const archive = await OperationsManifestArchive.findById(id).lean().exec();
  if (!archive) throw new OperationsManifestServiceError("Archived manifest was not found.", 404);
  if (allowedBranchIds !== null && !allowedBranchIds.includes(String(archive.branchId))) {
    throw new OperationsManifestServiceError("You do not have access to this manifest's branch.", 403);
  }
  return archive;
}
