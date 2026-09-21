import mongoose from "mongoose";

export const shipmentOperationsParcelScanActionValues = ["RECEIVE", "PROCESS"] as const;
export type ShipmentOperationsParcelScanAction = (typeof shipmentOperationsParcelScanActionValues)[number];

export interface IShipmentOperationsParcelScan extends mongoose.Document {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  action: ShipmentOperationsParcelScanAction;
  parcelNumber: string;
  location: string;
  deviceId: string;
  scanRequestId: string;
  scannedBy: mongoose.Types.ObjectId;
  scannedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new mongoose.Schema<IShipmentOperationsParcelScan>(
  {
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
    dpdShipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "DpdShipment", required: true, index: true },
    action: { type: String, enum: shipmentOperationsParcelScanActionValues, required: true, index: true },
    parcelNumber: { type: String, trim: true, uppercase: true, maxlength: 80, required: true },
    location: { type: String, trim: true, maxlength: 120, default: "" },
    deviceId: { type: String, trim: true, maxlength: 120, default: "" },
    scanRequestId: { type: String, trim: true, maxlength: 80, required: true },
    scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    scannedAt: { type: Date, required: true, default: Date.now, index: true }
  },
  { timestamps: true }
);

// One physical parcel advances a particular origin milestone once. The request
// ID separately makes a browser retry safe even when the response was lost.
schema.index(
  { shipmentDraftId: 1, action: 1, parcelNumber: 1 },
  { unique: true, name: "uniq_shipment_origin_action_parcel" }
);
schema.index({ scanRequestId: 1 }, { unique: true, name: "uniq_shipment_origin_scan_request" });
schema.index({ shipmentDraftId: 1, action: 1, scannedAt: 1 });

export const ShipmentOperationsParcelScan = mongoose.model<IShipmentOperationsParcelScan>(
  "ShipmentOperationsParcelScan",
  schema
);
