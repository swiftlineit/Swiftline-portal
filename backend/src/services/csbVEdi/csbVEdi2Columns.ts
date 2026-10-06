import type { ManifestDocumentItem, ManifestDocumentModel } from "../../types/manifestDocument.js";
import { ediText } from "../edi/ediTransforms.js";
import { getParcelItemAmount } from "../parcelItems.service.js";
import type { CsbVEdiDraftContext } from "./csbVEdiColumns.js";

export const CSB_V_EDI2_HEADERS = [
  "Mawb No", "AWBNO", "INV_NO", "Unit Price", "QTY", "Total Item Value", "Invoice Value",
  "CTSH", "Des_of_Goods", "Unit", "Total_Taxable_Value", "Total_Taxable_Value_Currency",
  "IGST_Paid", "Total_Cess", "Bound_UT"
] as const;

export type CsbVEdi2Cell = string | number;

function itemAmount(item: ManifestDocumentItem): number | "" {
  return typeof item.quantity === "number" && Number.isFinite(item.quantity)
    && typeof item.unitRate === "number" && Number.isFinite(item.unitRate)
    ? getParcelItemAmount(item)
    : "";
}

/** One row per goods item. Old snapshots without item details retain a descriptive parcel row. */
export function buildCsbVEdi2Rows(model: ManifestDocumentModel, drafts: Map<string, CsbVEdiDraftContext>): CsbVEdi2Cell[][] {
  return model.consignments.flatMap((consignment) => {
    const draft = drafts.get(consignment.shipmentDraftId) ?? {};
    return consignment.parcels.flatMap((parcel) => {
      const items = parcel.items?.length ? parcel.items : [{ description: parcel.description }];
      return items.map((item) => {
        const amount = itemAmount(item);
        return [
          ediText(model.header.mawbNumber),
          ediText(consignment.consignmentNumber),
          ediText(draft.csbVInvoiceNumber),
          typeof item.unitRate === "number" ? item.unitRate : "",
          typeof item.quantity === "number" ? item.quantity : "",
          amount,
          amount,
          ediText(item.hsnCode),
          ediText(item.description),
          ediText(item.unitType),
          amount,
          "INR",
          0,
          0,
          "N"
        ];
      });
    });
  });
}
