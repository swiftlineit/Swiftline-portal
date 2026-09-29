import crypto from "crypto";
import path from "path";

/**
 * Every storage key in the portal is built here.
 *
 * S3 has no directories: a key is one string, and the slashes only look like
 * folders in the console. Nothing is pre-created, so the layout below comes into
 * existence as objects are written. Keeping all of it in one file is what makes
 * the structure a decision rather than an accident.
 *
 * The shape is always:
 *
 *   {module}/{owner-id}/{document-type}/{uuid}.{ext}
 *
 * Grouping by owner rather than by date is deliberate. Documents are always
 * reached through a database record that holds the key, never by browsing, so a
 * date hierarchy would buy nothing- while an owner prefix lets retention,
 * legal hold, and account deletion operate on a prefix instead of a file list.
 */

/**
 * Extensions we are willing to put in a key, lowercased and without the dot.
 *
 * The extension is cosmetic- it decides nothing about how an object is served,
 * because the content type comes from the database record. It exists so that a
 * key is recognisable in the S3 console and so a downloaded object opens in the
 * right application. Anything outside this set becomes `.bin`.
 */
const allowedExtensions = new Set([
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  // Shipping labels in printer control code, and customs invoice workbooks.
  "zpl",
  "xlsx",
  "xls"
]);

/**
 * Derives a safe extension from a client-supplied filename.
 *
 * The original name never reaches the key- it is kept as database metadata
 * only. Taking nothing but a whitelisted extension from it closes path
 * traversal, double-extension tricks, null bytes, and unicode homoglyphs in one
 * step, because there is no path for those characters to travel down.
 */
export function safeExtension(originalName: string, fallback = "bin") {
  const extension = path.extname(originalName).toLowerCase().replace(/^\./, "");
  return allowedExtensions.has(extension) ? extension : fallback;
}

/**
 * Joins key segments with forward slashes regardless of host platform.
 *
 * `path.join` would produce backslashes on Windows, which S3 treats as ordinary
 * characters in an object name rather than as separators- the resulting object
 * would be stored under a literal backslash name and never found again.
 */
function joinKey(...segments: string[]) {
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .join("/");
}

/** Server-generated filename. A client-supplied name is never used as one. */
function generatedFilename(originalName: string) {
  return `${crypto.randomUUID()}.${safeExtension(originalName)}`;
}

/**
 * Every module that stores documents, with the prefix it owns. Adding a module
 * means adding it here, so the bucket layout stays reviewable in one place.
 */
export const storageModules = {
  businessAccountKyc: "business-accounts",
  branchKyc: "branches",
  shipment: "shipments",
  creditAgreement: "credit-agreements",
  pod: "pod",
  pickup: "pickups",
  staff: "staff",
  profileImage: "profile-images",
  shipmentImport: "shipment-imports",
  claim: "claims",
  dashboardBanner: "dashboard-banners",
  flightLinehaul: "flight-linehauls",
  operationsManifestArchive: "operations-manifest-archives"
} as const;

export const claimDocumentTypeValues = ["evidence", "payment-proof", "beneficiary"] as const;
export type ClaimDocumentStorageType = (typeof claimDocumentTypeValues)[number];

/**
 * Claim documents.
 *
 * Everything belonging to one claim shares the `claims/{claimId}/` prefix so
 * that legal hold and the eight-year retention rule can be applied to a prefix
 * rather than to an enumerated list of files that could drift out of date.
 */
export function claimDocumentKey(input: {
  claimId: string;
  documentType: ClaimDocumentStorageType;
  originalName: string;
}) {
  return joinKey(
    storageModules.claim,
    input.claimId,
    input.documentType,
    generatedFilename(input.originalName)
  );
}

/** All documents for one claim. Used by retention, legal hold, and deletion. */
export function claimPrefix(claimId: string) {
  return joinKey(storageModules.claim, claimId);
}

export function businessAccountKycKey(businessAccountId: string, originalName: string) {
  return joinKey(storageModules.businessAccountKyc, businessAccountId, "kyc", generatedFilename(originalName));
}

export function branchKycKey(branchId: string, originalName: string) {
  return joinKey(storageModules.branchKyc, branchId, "kyc", generatedFilename(originalName));
}

export function shipmentKycKey(shipmentDraftId: string, originalName: string) {
  return joinKey(storageModules.shipment, shipmentDraftId, "kyc", generatedFilename(originalName));
}

/** Documents supplied after booking, kept apart from the KYC pack. */
export function shipmentSupportingDocumentKey(shipmentDraftId: string, originalName: string) {
  return joinKey(storageModules.shipment, shipmentDraftId, "supporting", generatedFilename(originalName));
}

export function shipmentLabelKey(shipmentDraftId: string, originalName = "label.pdf") {
  return joinKey(storageModules.shipment, shipmentDraftId, "labels", generatedFilename(originalName));
}

export function shipmentImportKey(batchId: string, originalName: string) {
  return joinKey(storageModules.shipmentImport, batchId, generatedFilename(originalName));
}

export function creditAgreementKey(agreementId: string, originalName = "agreement.pdf") {
  return joinKey(storageModules.creditAgreement, agreementId, generatedFilename(originalName));
}

export function podEvidenceKey(assignmentId: string, originalName: string) {
  return joinKey(storageModules.pod, assignmentId, "evidence", generatedFilename(originalName));
}

export function pickupProofKey(pickupRequestId: string, originalName: string) {
  return joinKey(storageModules.pickup, pickupRequestId, "proof", generatedFilename(originalName));
}

export function staffDocumentKey(userId: string, originalName: string) {
  return joinKey(storageModules.staff, userId, "documents", generatedFilename(originalName));
}

export function profileImageKey(userId: string, originalName: string) {
  return joinKey(storageModules.profileImage, userId, generatedFilename(originalName));
}

export function operationsManifestArchiveKey(manifestId: string, originalName: string) {
  return joinKey(storageModules.operationsManifestArchive, manifestId, "exports", generatedFilename(originalName));
}

export function dashboardBannerKey(originalName: string) {
  return joinKey(storageModules.dashboardBanner, generatedFilename(originalName));
}

export function flightLinehaulDocumentKey(flightId: string, originalName: string) {
  return joinKey(storageModules.flightLinehaul, flightId, "documents", generatedFilename(originalName));
}

/**
 * Rejects anything that is not a key this module could have produced.
 *
 * Keys arrive from the database rather than from a request, so this guards
 * against a corrupted or hand-edited row rather than against a hostile caller-
 * but a key containing `..` would escape the storage root under the local
 * driver, so it is checked before every read regardless of origin.
 */
export function assertValidStorageKey(key: string): asserts key is string {
  const invalid =
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("//") ||
    key.split("/").some((segment) => segment === "." || segment === "..");

  if (invalid) throw new Error("Storage key is invalid.");
}
