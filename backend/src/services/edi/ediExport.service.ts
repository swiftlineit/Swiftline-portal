import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import type { IOperationsManifest } from "../../models/operationsManifest.model.js";
import type { ManifestDocumentParcelRow } from "../../types/manifestDocument.js";
import { buildManifestDocumentModel, parseCurrentManifestSnapshot } from "../manifestDocument.service.js";
import { OperationsManifestServiceError } from "../operationsManifest.service.js";
import type { EdiContext } from "./ediColumns.js";
import { buildEdiWorkbookBuffer } from "./ediWorkbook.service.js";
import { withCsbVExportHawb } from "./csbVExportHawb.js";

// A Swiftline parcel barcode ends in "-NN", the 1-based sequence of the parcel on its
// shipment draft. That links a manifest row back to its parcel's own KYC.
function parcelSequenceFromBarcode(parcelNumber: string): number | null {
  const match = /-(\d{1,3})$/.exec(parcelNumber.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Builds the customs EDI (.xls) for a sealed manifest. Every field comes from the
 * frozen sealed snapshot except the consignor Aadhaar (GSTINNumber), which snapshots
 * keep redacted and is therefore read live from the shipment draft here.
 */
export async function buildOperationsManifestEdi(manifest: IOperationsManifest): Promise<Buffer> {
  const snapshot = parseCurrentManifestSnapshot(manifest.sealedSnapshot, manifest.header);
  if (!snapshot) throw new OperationsManifestServiceError("The sealed manifest snapshot is unavailable.", 409);
  const model = buildManifestDocumentModel(snapshot);

  if (!model.parcelRows.length) {
    throw new OperationsManifestServiceError("This manifest has no parcels to export.", 409);
  }
  // The EDI needs the structured consignor/consignee fields captured from v2 seals.
  const missingParty = model.parcelRows.some((row) => !row.consignor.party || !row.consignee.party);
  if (missingParty) {
    throw new OperationsManifestServiceError(
      "This manifest was sealed before EDI support and has no structured address data. Re-seal it, or run the party backfill, before exporting the EDI.",
      409
    );
  }

  const draftIds = [...new Set(model.consignments.map((consignment) => consignment.shipmentDraftId))];
  const drafts = await ShipmentDraft.find({ _id: { $in: draftIds } })
    .select("csbType csbVInvoiceNumber consignorAddress kycUseForAllParcels parcelList")
    .lean()
    .exec();
  const draftById = new Map(drafts.map((draft) => [String(draft._id), draft]));

  const aadhaarFor = (row: ManifestDocumentParcelRow): string => {
    const draft = draftById.get(row.shipmentDraftId);
    if (!draft) return "";
    const shared = draft.consignorAddress?.aadhaarNumber ?? "";
    // Per-parcel KYC: resolve the specific parcel by its barcode sequence.
    if (draft.kycUseForAllParcels === false) {
      const sequence = parcelSequenceFromBarcode(row.parcelNumber);
      if (sequence != null) {
        const parcel = draft.parcelList?.find((item) => item.sequence === sequence) ?? draft.parcelList?.[sequence - 1];
        if (parcel?.aadhaarNumber) return parcel.aadhaarNumber;
      }
    }
    return shared;
  };

  const context: EdiContext = {
    mawbNumber: String(model.header.mawbNumber ?? ""),
    departureDate: String(model.header.departureDate ?? ""),
    aadhaarFor
  };

  return buildEdiWorkbookBuffer(withCsbVExportHawb(model.parcelRows, drafts), context);
}
