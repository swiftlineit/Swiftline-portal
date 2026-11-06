import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import {
  encryptShipmentDraftAadhaar,
  isEncryptedShipmentDraftAadhaar,
} from "../services/shipmentDraftAadhaar.service.js";

type RawDraftAadhaar = {
  _id: mongoose.Types.ObjectId;
  consignorAddress?: { aadhaarNumber?: unknown };
  parcelList?: Array<{ aadhaarNumber?: unknown }>;
};

async function migrateShipmentDraftAadhaarEncryption() {
  const apply = process.argv.includes("--apply");
  await connectDatabase();
  try {
    const cursor = ShipmentDraft.collection.find<RawDraftAadhaar>(
      {
        $or: [
          { "consignorAddress.aadhaarNumber": { $type: "string", $ne: "" } },
          { "parcelList.aadhaarNumber": { $type: "string", $ne: "" } },
        ],
      },
      { projection: { _id: 1, "consignorAddress.aadhaarNumber": 1, "parcelList.aadhaarNumber": 1 } },
    ).batchSize(200);

    type BulkOperation = Parameters<typeof ShipmentDraft.collection.bulkWrite>[0][number];
    let scanned = 0;
    let migrated = 0;
    let pending: BulkOperation[] = [];

    for await (const draft of cursor) {
      const set: Record<string, string> = {};
      const expected: Record<string, string> = {};
      const shared = draft.consignorAddress?.aadhaarNumber;
      if (typeof shared === "string" && shared.trim() && !isEncryptedShipmentDraftAadhaar(shared)) {
        set["consignorAddress.aadhaarNumber"] = encryptShipmentDraftAadhaar(shared);
        expected["consignorAddress.aadhaarNumber"] = shared;
      }
      draft.parcelList?.forEach((parcel, index) => {
        const value = parcel.aadhaarNumber;
        if (typeof value === "string" && value.trim() && !isEncryptedShipmentDraftAadhaar(value)) {
          set[`parcelList.${index}.aadhaarNumber`] = encryptShipmentDraftAadhaar(value);
          expected[`parcelList.${index}.aadhaarNumber`] = value;
        }
      });
      if (!Object.keys(set).length) continue;

      scanned += 1;
      if (!apply) continue;
      pending.push({
        updateOne: {
          filter: { _id: draft._id, ...expected },
          update: { $set: set },
        },
      });
      if (pending.length >= 200) {
        const result = await ShipmentDraft.collection.bulkWrite(pending, { ordered: false });
        migrated += result.modifiedCount;
        pending = [];
      }
    }
    if (pending.length) {
      const result = await ShipmentDraft.collection.bulkWrite(pending, { ordered: false });
      migrated += result.modifiedCount;
    }

    if (apply) {
      console.log(`Encrypted Aadhaar values in ${migrated} shipment draft(s).`);
    } else {
      console.log(`${scanned} shipment draft(s) contain legacy plaintext Aadhaar values.`);
      console.log("Review the target database, then run migrate:shipment-draft-aadhaar-encryption to apply.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

migrateShipmentDraftAadhaarEncryption().catch((error) => {
  console.error("Shipment draft Aadhaar encryption migration failed.", error);
  process.exitCode = 1;
});
