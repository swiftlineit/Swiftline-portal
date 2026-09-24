import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import type { IOperationsManifest } from "../../models/operationsManifest.model.js";
import type { ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import { buildManifestDocumentModel, parseSealedSnapshot } from "../manifestDocument.service.js";
import { OperationsManifestServiceError } from "../operationsManifest.service.js";
import { buildOpsEdiWorkbookBuffer } from "./opsEdiWorkbook.service.js";
import { collectOpsEdiWarnings, type OpsEdiContext } from "./opsEdiColumns.js";

function parcelSequenceFromBarcode(parcelNumber: string): number | null {
  const match = /-(\d{1,3})$/.exec(parcelNumber.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Builds the separate OPS EDI workbook from the sealed manifest snapshot. The
 * snapshot remains the source for operational data; only the full Aadhaar is
 * read live because sealed snapshots intentionally redact it.
 */
export async function buildOperationsManifestOpsEdi(manifest: IOperationsManifest) {
  const snapshot = parseSealedSnapshot(manifest.sealedSnapshot);
  if (!snapshot) throw new OperationsManifestServiceError("The sealed manifest snapshot is unavailable.", 409);
  const model = buildManifestDocumentModel(snapshot);
  if (!model.parcelRows.length) throw new OperationsManifestServiceError("This manifest has no parcels to export.", 409);

  const draftIds = [...new Set(model.consignments.map((consignment) => consignment.shipmentDraftId))];
  const drafts = await ShipmentDraft.find({ _id: { $in: draftIds } })
    .select("consignorAddress kycUseForAllParcels parcelList")
    .lean()
    .exec();
  const draftById = new Map(drafts.map((draft) => [String(draft._id), draft]));

  const aadhaarFor = (row: ManifestDocumentParcelRow): string => {
    const draft = draftById.get(row.shipmentDraftId);
    if (!draft) return "";
    const shared = draft.consignorAddress?.aadhaarNumber ?? "";
    if (draft.kycUseForAllParcels !== false) return shared;

    const sequence = parcelSequenceFromBarcode(row.parcelNumber) ?? row.parcelIndexInConsignment + 1;
    const parcel = draft.parcelList?.find((item) => item.sequence === sequence) ?? draft.parcelList?.[sequence - 1];
    return parcel?.aadhaarNumber || shared;
  };

  const context: OpsEdiContext = {
    departureDate: String(model.header.departureDate ?? ""),
    aadhaarFor
  };
  const warnings = collectOpsEdiWarnings(model.parcelRows, context);
  try {
    return buildOpsEdiWorkbookBuffer(model.parcelRows, context, warnings);
  } catch (error) {
    console.error("Unable to build the OPS EDI workbook.", error);
    throw new OperationsManifestServiceError("The OPS EDI template could not be loaded or populated.", 500);
  }
}
