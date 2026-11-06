import { decryptSecret, encryptSecret } from "./credentialEncryption.service.js";

const aadhaarEncryptionPrefix = "swiftline-aadhaar:v1:";

/** Encrypt draft Aadhaar values before MongoDB writes them. */
export function encryptShipmentDraftAadhaar(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  if (value.startsWith(aadhaarEncryptionPrefix)) return value;
  return `${aadhaarEncryptionPrefix}${encryptSecret(value.trim(), "taxId")}`;
}

/** Keep existing form and document readers compatible with encrypted and legacy rows. */
export function decryptShipmentDraftAadhaar(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (!value.startsWith(aadhaarEncryptionPrefix)) return value;
  return decryptSecret<string>(value.slice(aadhaarEncryptionPrefix.length), "taxId");
}

export function isEncryptedShipmentDraftAadhaar(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(aadhaarEncryptionPrefix);
}
