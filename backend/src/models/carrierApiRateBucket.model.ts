import mongoose from "mongoose";

export interface ICarrierApiRateBucket extends mongoose.Document {
  key: string;
  count: number;
  expiresAt: Date;
}

const schema = new mongoose.Schema<ICarrierApiRateBucket>({
  key: { type: String, required: true, unique: true, trim: true, maxlength: 180 },
  count: { type: Number, required: true, min: 0, default: 0 },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CarrierApiRateBucket = mongoose.model<ICarrierApiRateBucket>("CarrierApiRateBucket", schema);
