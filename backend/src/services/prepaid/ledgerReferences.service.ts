import mongoose from "mongoose";
import { ShipmentFunding } from "../../models/shipmentFunding.model.js";
import { ShipmentAmendment } from "../../models/shipmentAmendment.model.js";
import { ShipmentCancellation } from "../../models/shipmentCancellation.model.js";
import { ShipmentCharge } from "../../models/shipmentCharge.model.js";
import { BalanceReservation } from "../../models/balanceReservation.model.js";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";

type ReferenceRow = { referenceType?: string; referenceId?: unknown; shipmentDraftId?: unknown };

/** Resolve only records already scoped to the authorized business and current tenant. */
export async function attachLedgerShipments<T extends ReferenceRow>(rows: T[], businessAccountId: mongoose.Types.ObjectId) {
  const models = {
    SHIPMENT_FUNDING: ShipmentFunding,
    SHIPMENT_AMENDMENT: ShipmentAmendment,
    SHIPMENT_CANCELLATION: ShipmentCancellation,
    SHIPMENT_CHARGE: ShipmentCharge,
    BALANCE_RESERVATION: BalanceReservation,
    DPD_SHIPMENT: DpdShipment
  } as const;
  const resolved = new Map<string, string>();
  await Promise.all(Object.entries(models).map(async ([type, model]) => {
    const ids = rows.filter((row) => row.referenceType === type && mongoose.isValidObjectId(row.referenceId)).map((row) => new mongoose.Types.ObjectId(String(row.referenceId)));
    if (!ids.length) return;
    const queryModel = model as unknown as typeof ShipmentFunding;
    const records = await queryModel.find({ _id: { $in: ids }, ...(type === "DPD_SHIPMENT" ? {} : { businessAccountId }) }).select("shipmentDraftId").lean().exec();
    for (const record of records) resolved.set(`${type}:${String(record._id)}`, String(record.shipmentDraftId));
  }));
  const draftIds = rows.map((row) => row.shipmentDraftId ? String(row.shipmentDraftId) : resolved.get(`${row.referenceType}:${String(row.referenceId)}`)).filter((id): id is string => Boolean(id && mongoose.isValidObjectId(id)));
  const authorizedDrafts = draftIds.length ? await ShipmentDraft.find({ businessAccountId, _id: { $in: draftIds } }).select("_id").lean().exec() : [];
  const shipments = authorizedDrafts.length ? await DpdShipment.find({ shipmentDraftId: { $in: authorizedDrafts.map((draft) => draft._id) } }).select("shipmentDraftId swiftlineTrackingNumber").lean().exec() : [];
  const numbers = new Map(shipments.map((shipment) => [String(shipment.shipmentDraftId), shipment.swiftlineTrackingNumber]));
  return rows.map((row) => {
    const draftId = row.shipmentDraftId ? String(row.shipmentDraftId) : resolved.get(`${row.referenceType}:${String(row.referenceId)}`);
    // Link only to a shipment confirmed to belong to this account.
    return { ...row, shipmentDraftId: draftId && numbers.has(draftId) ? draftId : null, shipmentNumber: draftId ? numbers.get(draftId) ?? null : null };
  });
}
