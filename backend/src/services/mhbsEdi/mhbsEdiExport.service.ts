import type { IOperationsManifest } from "../../models/operationsManifest.model.js";
import { buildManifestDocumentModel, parseSealedSnapshot } from "../manifestDocument.service.js";
import { OperationsManifestServiceError } from "../operationsManifest.service.js";
import { buildMhbsEdiWorkbookBuffer } from "./mhbsEdiWorkbook.service.js";
import { collectMhbsEdiWarnings } from "./mhbsEdiColumns.js";

/** Builds the MHBS filing workbook from the immutable sealed manifest snapshot. */
export async function buildOperationsManifestMhbsEdi(manifest: IOperationsManifest) {
  const snapshot = parseSealedSnapshot(manifest.sealedSnapshot);
  if (!snapshot) throw new OperationsManifestServiceError("The sealed manifest snapshot is unavailable.", 409);
  const model = buildManifestDocumentModel(snapshot);
  if (!model.parcelRows.length) throw new OperationsManifestServiceError("This manifest has no parcels to export.", 409);

  const warnings = collectMhbsEdiWarnings(model.parcelRows);
  try {
    return buildMhbsEdiWorkbookBuffer(model.parcelRows, warnings);
  } catch (error) {
    console.error("Unable to build the MHBS EDI workbook.", error);
    throw new OperationsManifestServiceError("The MHBS EDI template could not be loaded or populated.", 500);
  }
}
