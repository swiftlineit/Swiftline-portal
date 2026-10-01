import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import type { IOperationsManifest } from "../../models/operationsManifest.model.js";
import { buildManifestDocumentModel, parseCurrentManifestSnapshot } from "../manifestDocument.service.js";
import { OperationsManifestServiceError } from "../operationsManifest.service.js";
import { buildCsbVEdiRows, type CsbVEdiDraftContext } from "./csbVEdiColumns.js";
import { buildCsbVEdiWorkbookBuffer } from "./csbVEdiWorkbook.service.js";

export const CSB_V_ONLY_MANIFEST_MESSAGE = "Only CSB-V shipments should be in this manifest. Remove CSB-IV shipments before downloading CSB-V EDI.";

export function assertCsbVOnlyDrafts(
  draftIds: string[],
  drafts: Array<{ _id: unknown; csbType?: string }>,
) {
  const foundIds = new Set(drafts.map((draft) => String(draft._id)));
  const hasMissing = draftIds.some((id) => !foundIds.has(id));
  const hasNonCsbV = drafts.some((draft) => draft.csbType !== "CSB_V");
  if (hasMissing || hasNonCsbV || !draftIds.length) {
    throw new OperationsManifestServiceError(CSB_V_ONLY_MANIFEST_MESSAGE, 409);
  }
}

export function assertCsbVCustomsFields(drafts: CsbVEdiDraftContext[]) {
  for (const draft of drafts) {
    if (!draft.csbVAccountNumber?.trim() || !draft.csbVIecCode?.trim() || !draft.csbVInvoiceNumber?.trim()) {
      throw new OperationsManifestServiceError("A CSB-V shipment is missing its bank account number, IEC code, or commercial invoice number. Complete the booking details before downloading EDI.", 409);
    }
  }
}

export async function buildOperationsManifestCsbVEdi(manifest: IOperationsManifest) {
  const snapshot = parseCurrentManifestSnapshot(manifest.sealedSnapshot, manifest.header);
  if (!snapshot) throw new OperationsManifestServiceError("The sealed manifest snapshot is unavailable.", 409);
  const model = buildManifestDocumentModel(snapshot);
  if (!model.parcelRows.length) throw new OperationsManifestServiceError("This manifest has no parcels to export.", 409);

  const draftIds = [...new Set(model.consignments.map((consignment) => consignment.shipmentDraftId))];
  const drafts = await ShipmentDraft.find({ _id: { $in: draftIds } })
    .select("csbType csbVGstin csbVAccountNumber csbVIecCode csbVInvoiceNumber consigneeEnteredAddress.stateCode")
    .lean()
    .exec();
  assertCsbVOnlyDrafts(draftIds, drafts);
  assertCsbVCustomsFields(drafts);

  const draftById = new Map<string, CsbVEdiDraftContext>(drafts.map((draft) => [String(draft._id), draft]));
  const rows = buildCsbVEdiRows(model.consignments, draftById, String(model.header.departureDate ?? ""));
  return buildCsbVEdiWorkbookBuffer(rows);
}
