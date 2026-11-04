import mongoose from "mongoose";
import { ClaimDocument } from "../../models/claimDocument.model.js";
import { ClaimEvent } from "../../models/claimEvent.model.js";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import { LabelDocument } from "../../models/labelDocument.model.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import { ShipmentImportEntry } from "../../models/shipmentImportEntry.model.js";
import type { IClaim } from "../../models/claim.model.js";
import { checksumOf, claimDocumentKey, getObjectBuffer, putObject } from "../storage/storage.service.js";
import { formatSwiftlineParcelNumberForDisplay } from "../swiftlineTracking.service.js";

/**
 * Attaches documents Swiftline already holds for the shipment.
 *
 * Asking a client to upload the commercial invoice they gave us at booking is
 * the kind of thing that makes a claims process feel adversarial, and it is the
 * commonest reason a checklist sits incomplete.
 *
 * The bytes are *copied* into the claim's own storage prefix rather than
 * referenced where they sit. A claim is a legal record kept for eight years, and
 * it must not depend on another module's retention decisions- a deleted draft
 * or a superseded invoice must not take a claim's evidence with it.
 */

interface PortalSource {
  category: "VALUE_PROOF" | "OTHER";
  label: string;
  filename: string;
  mimeType: string;
  /** Key in the source module's own prefix. Read once, then copied. */
  storageKey: string;
}

async function collectSources(shipmentDraftId: mongoose.Types.ObjectId) {
  const sources: PortalSource[] = [];

  const shipment = await ShipmentDraft.findById(shipmentDraftId)
    .select("shipmentImportEntryId")
    .lean()
    .exec();

  if (shipment?.shipmentImportEntryId) {
    const importedWorkbook = await ShipmentImportEntry.findById(shipment.shipmentImportEntryId)
      .select("originalFilename storageKey")
      .lean()
      .exec();

    if (importedWorkbook?.storageKey) {
      sources.push({
        category: "VALUE_PROOF",
        label: "shipment workbook from booking",
        filename: importedWorkbook.originalFilename || "shipment-import.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        storageKey: importedWorkbook.storageKey
      });
    }
  }

  // Labels hang off the booking rather than the draft, so this is a second hop.
  const booking = await DpdShipment.findOne({ shipmentDraftId }).select("_id").lean().exec();
  if (booking) {
    const label = await LabelDocument.findOne({ dpdShipmentId: booking._id, voidedAt: null })
      .sort({ createdAt: -1 })
      .select("storageKey format parcelNumber labelType")
      .lean()
      .exec();

    // ZPL is printer control code, not a document a reviewer can read.
    if (label?.storageKey && label.format === "PDF") {
      sources.push({
        category: "OTHER",
        label: "shipping label",
        filename: `label-${label.labelType === "SWIFTLINE" ? formatSwiftlineParcelNumberForDisplay(label.parcelNumber) : label.parcelNumber || "parcel"}.pdf`,
        mimeType: "application/pdf",
        storageKey: label.storageKey
      });
    }
  }

  return sources;
}

/**
 * Links whatever is available. Never throws.
 *
 * Called during submission, where a missing or unreadable source file must not
 * cost a client their filing date. Anything that cannot be copied is simply not
 * attached, and the client is asked for it as normal.
 */
export async function attachPortalDocuments(claim: IClaim, actorUserId: mongoose.Types.ObjectId) {
  const attached: string[] = [];

  for (const source of await collectSources(claim.shipmentDraftId)) {
    try {
      // Never displace something the client uploaded themselves.
      const existing = await ClaimDocument.exists({
        claimId: claim._id,
        category: source.category,
        deletedAt: null
      });
      if (existing) continue;

      const contents = await getObjectBuffer(source.storageKey);
      if (contents.length === 0) continue;

      const storageKey = claimDocumentKey({
        claimId: String(claim._id),
        documentType: "evidence",
        originalName: source.filename
      });

      await putObject({
        key: storageKey,
        body: contents,
        contentType: source.mimeType,
        originalName: source.filename
      });

      await ClaimDocument.create({
        claimId: claim._id,
        category: source.category,
        storageKey,
        originalName: source.filename,
        mimeType: source.mimeType,
        size: contents.length,
        // Hashed from the copy actually stored, not carried over from the source.
        sha256: checksumOf(contents),
        uploadedBy: actorUserId,
        uploadedByKind: "STAFF",
        // Shows on the checklist as "On file" rather than "Uploaded", so a
        // reviewer can tell our evidence from the client's at a glance.
        sourcedFromPortal: true,
        // Already vetted once when it entered the portal.
        reviewState: "ACCEPTED",
        visibility: "PUBLIC"
      });

      attached.push(source.label);
    } catch (error) {
      console.error("A portal document could not be attached to the claim.", {
        claimId: String(claim._id),
        category: source.category,
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  if (attached.length > 0) {
    await ClaimEvent.create({
      claimId: claim._id,
      type: "DOCUMENT_UPLOADED",
      actorUserId,
      actorKind: "SYSTEM",
      visibility: "PUBLIC",
      reason: `Attached from your Swiftline records: ${attached.join(", ")}.`,
      metadata: { sourcedFromPortal: true, attached }
    });
  }

  return attached;
}
