import type { ManifestDocumentParcelRow } from "../../types/manifestDocument.js";

/** The physical parcel barcode stays unique; only the filing HAWB is shared for CSB-V. */
export function withCsbVExportHawb(
  rows: ManifestDocumentParcelRow[],
  drafts: Array<{ _id: unknown; csbType?: string; csbVIecCode?: string; csbVAccountNumber?: string; csbVInvoiceNumber?: string }>,
): ManifestDocumentParcelRow[] {
  const csbVById = new Map(drafts.filter((draft) => draft.csbType === "CSB_V").map((draft) => [String(draft._id), draft]));
  return rows.map((row) => {
    const draft = csbVById.get(row.shipmentDraftId);
    return draft ? {
      ...row,
      exportHawbNumber: row.consignmentNumber,
      exportIecCode: draft.csbVIecCode?.trim(),
      exportAccountNumber: draft.csbVAccountNumber?.trim(),
      exportInvoiceNumber: draft.csbVInvoiceNumber?.trim(),
    } : row;
  });
}
