import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { resolveAttachments } from "../services/email/attachments.js";
import { deleteObject, putObject } from "../services/storage/storage.service.js";

test("pickup email resolves only a document belonging to the referenced pickup", async () => {
  const pickupId = new mongoose.Types.ObjectId();
  const documentId = new mongoose.Types.ObjectId();
  const otherDocumentId = new mongoose.Types.ObjectId();
  const key = `pickups/email-test/${new mongoose.Types.ObjectId()}.pdf`;
  const content = Buffer.from("%PDF-1.4\nPickup document test\n");
  const originalFindById = PickupRequest.findById;
  await putObject({ key, body: content, contentType: "application/pdf", originalName: "collection-note.pdf" });
  try {
    PickupRequest.findById = (() => ({
      select: () => ({ lean: () => ({ exec: async () => ({ documents: [
        { _id: documentId, originalName: "collection-note.pdf", storageKey: key, mimeType: "application/pdf" }
      ] }) }) })
    })) as unknown as typeof PickupRequest.findById;
    const result = await resolveAttachments([
      { kind: "PICKUP_DOCUMENT", refId: pickupId, documentId },
      { kind: "PICKUP_DOCUMENT", refId: pickupId, documentId: otherDocumentId }
    ]);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0]?.filename, "collection-note.pdf");
    assert.equal(result.attachments[0]?.contentType, "application/pdf");
    assert.deepEqual(result.attachments[0]?.content, content);
    assert.equal(result.dropped, true);
    const raw = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer({
        from: "test@swiftline.example", to: "staff@example.test", subject: "Pickup requested",
        text: "A pickup was requested.", attachments: result.attachments
      }).compile().build((error, message) => error ? reject(error) : resolve(message));
    });
    assert.match(raw.toString(), /filename=collection-note\.pdf/i);
    assert.match(raw.toString(), /Content-Disposition: attachment/i);
    assert.match(raw.toString(), new RegExp(content.toString("base64")));
  } finally {
    PickupRequest.findById = originalFindById;
    await deleteObject(key);
  }
});
