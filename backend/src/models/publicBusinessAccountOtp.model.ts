import mongoose from "mongoose";

export interface IPublicBusinessAccountOtp extends mongoose.Document {
  email: string;
  otpHash: string;
  otpExpiresAt: Date | null;
  otpAttempts: number;
  otpSentAt: Date | null;
  verifiedAt: Date | null;
  verificationToken: string | null;
  verificationExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const publicBusinessAccountOtpSchema = new mongoose.Schema<IPublicBusinessAccountOtp>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    otpHash: { type: String, default: "", select: false },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0, min: 0 },
    otpSentAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    verificationToken: { type: String, default: null, index: true, sparse: true } as any,
    verificationExpiresAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// TTL: auto-remove expired verification records after 1h beyond verification expiry
// Keep OTP rows for audit for 1 hour after expiry
publicBusinessAccountOtpSchema.index({ verificationExpiresAt: 1 }, { expireAfterSeconds: 3600, partialFilterExpression: { verificationExpiresAt: { $type: "date" } } } as any);
publicBusinessAccountOtpSchema.index({ otpExpiresAt: 1 }, { expireAfterSeconds: 3600, partialFilterExpression: { otpExpiresAt: { $type: "date" } } } as any);
publicBusinessAccountOtpSchema.index({ email: 1 }, { unique: true });

export const PublicBusinessAccountOtp = mongoose.model<IPublicBusinessAccountOtp>(
  "PublicBusinessAccountOtp",
  publicBusinessAccountOtpSchema
);
