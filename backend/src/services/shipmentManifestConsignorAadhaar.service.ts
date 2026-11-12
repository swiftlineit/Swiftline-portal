import mongoose from "mongoose";
import type { IShipmentManifest, ShipmentManifestLineSnapshot } from "../models/shipmentManifest.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { formatAadhaarNumber, normalizeAadhaarNumber } from "./aadhaarValidation.service.js";
import { decryptShipmentDraftAadhaar } from "./shipmentDraftAadhaar.service.js";
import { swiftlineParcelNumberSequence } from "./swiftlineTracking.service.js";

type DraftAadhaarProjection = {
  _id: unknown;
  consignorAddress?: { aadhaarNumber?: unknown };
  kycUseForAllParcels?: boolean;
  parcelList?: Array<{ sequence?: unknown; aadhaarNumber?: unknown }>;
};

type ShipmentConsignorAadhaar = {
  useForAllParcels: boolean;
  sharedNumber: string;
  parcelNumbersBySequence: ReadonlyMap<number, string>;
  commonParcelNumber: string;
};

export type ShipmentManifestConsignorAadhaarByDraft = ReadonlyMap<string, ShipmentConsignorAadhaar>;

function fullAadhaarNumber(value: unknown) {
  const digits = normalizeAadhaarNumber(decryptShipmentDraftAadhaar(value));
  return /^\d{12}$/.test(digits) ? formatAadhaarNumber(digits) : "";
}

export function buildShipmentManifestConsignorAadhaarByDraft(
  drafts: readonly DraftAadhaarProjection[]
): ShipmentManifestConsignorAadhaarByDraft {
  return new Map(drafts.map((draft) => {
    const parcelNumbersBySequence = new Map<number, string>();
    (draft.parcelList ?? []).forEach((parcel, index) => {
      const sequenceValue = Number(parcel.sequence);
      const sequence = Number.isInteger(sequenceValue) && sequenceValue > 0 ? sequenceValue : index + 1;
      const number = fullAadhaarNumber(parcel.aadhaarNumber);
      if (number) parcelNumbersBySequence.set(sequence, number);
    });

    const uniqueParcelNumbers = [...new Set(parcelNumbersBySequence.values())];
    return [String(draft._id), {
      useForAllParcels: draft.kycUseForAllParcels !== false,
      sharedNumber: fullAadhaarNumber(draft.consignorAddress?.aadhaarNumber),
      parcelNumbersBySequence,
      commonParcelNumber: uniqueParcelNumbers.length === 1 ? uniqueParcelNumbers[0]! : ""
    }];
  }));
}

/** Loads only the drafts already referenced by this authorized manifest. */
export async function loadShipmentManifestConsignorAadhaar(manifest: IShipmentManifest) {
  const draftIds = [...new Set(manifest.lineSnapshots
    .map((line) => String(line.shipmentDraftId))
    .filter((value) => mongoose.Types.ObjectId.isValid(value)))]
    .map((value) => new mongoose.Types.ObjectId(value));
  if (!draftIds.length) return new Map<string, ShipmentConsignorAadhaar>();

  const drafts = await ShipmentDraft.find({ _id: { $in: draftIds } })
    .select("_id consignorAddress.aadhaarNumber kycUseForAllParcels parcelList.sequence parcelList.aadhaarNumber")
    .lean()
    .exec();
  return buildShipmentManifestConsignorAadhaarByDraft(drafts as DraftAadhaarProjection[]);
}

export function shipmentManifestConsignorAadhaarForRow(
  line: ShipmentManifestLineSnapshot,
  aadhaarByDraft: ShipmentManifestConsignorAadhaarByDraft,
  parcelNumber?: string
) {
  const shipment = aadhaarByDraft.get(String(line.shipmentDraftId));
  if (!shipment) return "";
  if (shipment.useForAllParcels) return shipment.sharedNumber || shipment.commonParcelNumber;

  const sequence = parcelNumber
    ? swiftlineParcelNumberSequence(parcelNumber, line.consignmentNumber)
    : null;
  return (sequence ? shipment.parcelNumbersBySequence.get(sequence) : "")
    || shipment.commonParcelNumber;
}
