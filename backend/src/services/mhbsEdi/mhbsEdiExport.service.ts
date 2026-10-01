import type { IOperationsManifest } from "../../models/operationsManifest.model.js";
import { buildManifestDocumentModel, parseCurrentManifestSnapshot } from "../manifestDocument.service.js";
import { OperationsManifestServiceError } from "../operationsManifest.service.js";
import { buildMhbsEdiWorkbookBuffer } from "./mhbsEdiWorkbook.service.js";
import { collectMhbsEdiWarnings } from "./mhbsEdiColumns.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import { withCsbVExportHawb } from "../edi/csbVExportHawb.js";

/** Builds the MHBS filing workbook from the immutable sealed manifest snapshot. */
export async function buildOperationsManifestMhbsEdi(manifest: IOperationsManifest) {
  const snapshot = parseCurrentManifestSnapshot(manifest.sealedSnapshot, manifest.header);
  if (!snapshot) throw new OperationsManifestServiceError("The sealed manifest snapshot is unavailable.", 409);
  const model = buildManifestDocumentModel(snapshot);
  if (!model.parcelRows.length) throw new OperationsManifestServiceError("This manifest has no parcels to export.", 409);

  const drafts = await ShipmentDraft.find({ _id: { $in: model.consignments.map((item) => item.shipmentDraftId) } })
    .select("csbType").lean().exec();
  const rows = withCsbVExportHawb(model.parcelRows, drafts);
  const warnings = collectMhbsEdiWarnings(rows);
  try {
    return buildMhbsEdiWorkbookBuffer(rows, warnings);
  } catch (error) {
    console.error("Unable to build the MHBS EDI workbook.", error);
    throw new OperationsManifestServiceError("The MHBS EDI template could not be loaded or populated.", 500);
  }
}
