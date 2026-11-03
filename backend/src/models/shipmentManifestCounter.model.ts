import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface IShipmentManifestCounter extends mongoose.Document<string>, TenantOwnedFields {
  _id: string;
  sequence: number;
}

const shipmentManifestCounterSchema = new mongoose.Schema<IShipmentManifestCounter>({
  _id: { type: String, required: true },
  sequence: { type: Number, required: true, min: 0, default: 0 }
}, { versionKey: false });

addTenantOwnership(shipmentManifestCounterSchema);

export const ShipmentManifestCounter = mongoose.model<IShipmentManifestCounter>(
  "ShipmentManifestCounter",
  shipmentManifestCounterSchema
);
