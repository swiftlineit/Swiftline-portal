import type { IOperationsManifest } from "../../models/operationsManifest.model.js";
import { loadCsbVManifestData } from "./csbVEdiExport.service.js";
import { buildCsbVEdi2Rows } from "./csbVEdi2Columns.js";
import { buildCsbVEdi2WorkbookBuffer } from "./csbVEdi2Workbook.service.js";

export async function buildOperationsManifestCsbVEdi2(manifest: IOperationsManifest) {
  const { model, draftById, warnings } = await loadCsbVManifestData(manifest);
  const itemWarnings = model.consignments.flatMap((consignment) => (
    consignment.parcels.some((parcel) => !parcel.items?.length || parcel.items.some((item) => (
      !item.hsnCode || typeof item.quantity !== "number" || typeof item.unitRate !== "number"
    )))
      ? [`${consignment.consignmentNumber}: historical item details are incomplete; unavailable EDI2 cells are blank.`]
      : []
  ));
  return { buffer: buildCsbVEdi2WorkbookBuffer(buildCsbVEdi2Rows(model, draftById)), warnings: [...warnings, ...itemWarnings] };
}
