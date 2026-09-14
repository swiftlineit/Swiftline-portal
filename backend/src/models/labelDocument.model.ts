import mongoose from "mongoose";

export const labelFormatValues = ["PDF", "ZPL", "HTML"] as const;
export const labelSizeValues = ["A4", "A6", "SQUARE"] as const;

export type LabelFormat = (typeof labelFormatValues)[number];
export type LabelSize = (typeof labelSizeValues)[number];
// Every parcel gets a SWIFTLINE label. A DPD label is added only for United
// Kingdom destinations, where ALS books the shipment into the DPD network - see
// services/als. Queries that mean "the label on the box" must say so explicitly
// rather than taking the first row for a parcel.
export const labelTypeValues = ["SWIFTLINE", "DPD"] as const;
export type LabelType = (typeof labelTypeValues)[number];

export interface ILabelDocument extends mongoose.Document {
  dpdShipmentId: mongoose.Types.ObjectId;
  parcelNumber: string;
  labelType: LabelType;
  format: LabelFormat;
  labelSize: LabelSize;
  /** Storage service key, resolved through storage.service.ts. Never a path. */
  storageKey: string;
  fileChecksum: string;
  generatedAt: Date;
  downloadCount: number;
  lastDownloadedAt?: Date | null;
  voidedAt?: Date | null;
  voidTransactionId?: string;
  restoredAt?: Date | null;
  printCount: number;
  lastPrintedAt?: Date | null;
  labelVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const labelDocumentSchema = new mongoose.Schema<ILabelDocument>(
  {
    dpdShipmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DpdShipment",
      required: true,
      index: true
    },
    parcelNumber: { type: String, required: true, trim: true, maxlength: 80, index: true },
    labelType: { type: String, enum: labelTypeValues, default: "SWIFTLINE", required: true, index: true },
    format: { type: String, enum: labelFormatValues, required: true },
    labelSize: { type: String, enum: labelSizeValues, required: true },
    storageKey: { type: String, required: true, trim: true, maxlength: 1024 },
    fileChecksum: { type: String, required: true, trim: true, maxlength: 128 },
    generatedAt: { type: Date, default: Date.now, index: true },
    downloadCount: { type: Number, default: 0, min: 0 },
    lastDownloadedAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    voidTransactionId: { type: String, trim: true, maxlength: 120, default: "" },
    restoredAt: { type: Date, default: null },
    printCount: { type: Number, default: 0, min: 0 },
    lastPrintedAt: { type: Date, default: null },
    labelVersion: { type: Number, default: 1, min: 1 }
  },
  { timestamps: true }
);

labelDocumentSchema.index({ dpdShipmentId: 1, labelType: 1, parcelNumber: 1 }, { unique: true });

export const LabelDocument = mongoose.model<ILabelDocument>(
  "LabelDocument",
  labelDocumentSchema
);
