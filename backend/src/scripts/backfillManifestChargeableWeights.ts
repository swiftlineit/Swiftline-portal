// Backfill: adds `chargeableWeightKg` to shipment manifest lines sealed before the
// chargeable-weight column existed, so their PDF/Excel exports show each parcel's
// own chargeable weight instead of repeating the shipment total.
// Values are re-derived from each shipment's still-present booking snapshot; nothing
// else on the line is touched. Safe to re-run: lines already carrying chargeable
// weights are skipped.
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { readShipmentBookingSnapshot } from "../services/shipmentBookingSnapshot.service.js";
import {
  manifestChargeableWeightKg,
  manifestParcelChargeableWeightKg
} from "../services/shipmentManifest.service.js";

async function backfillManifestChargeableWeights() {
  await connectDatabase();
  const summary = { manifests: 0, updated: 0, lines: 0, filled: 0, skippedNoSnapshot: 0 };
  try {
    const manifests = await ShipmentManifest.find().exec();
    for (const manifest of manifests) {
      summary.manifests += 1;
      if (!Array.isArray(manifest.lineSnapshots) || !manifest.lineSnapshots.length) continue;

      let changed = false;
      for (const line of manifest.lineSnapshots) {
        summary.lines += 1;
        const parcels = Array.isArray(line.parcels) ? line.parcels : [];
        const lineHasChargeable = typeof line.chargeableWeightKg === "number";
        const parcelsHaveChargeable = parcels.length > 0
          && parcels.every((parcel) => typeof parcel.chargeableWeightKg === "number");
        if (lineHasChargeable && (parcels.length === 0 || parcelsHaveChargeable)) continue;

        const shipment = line.dpdShipmentId
          ? await DpdShipment.findById(line.dpdShipmentId).lean().exec()
          : null;
        const fallbackShipment = !shipment && line.shipmentDraftId
          ? await DpdShipment.findOne({ shipmentDraftId: line.shipmentDraftId }).lean().exec()
          : null;
        const booking = shipment ?? fallbackShipment;
        const snapshot = booking
          ? readShipmentBookingSnapshot(booking.currentShipmentSnapshot)
            ?? readShipmentBookingSnapshot(booking.bookingSnapshot)
          : null;
        if (!snapshot) { summary.skippedNoSnapshot += 1; continue; }

        if (!lineHasChargeable) {
          line.chargeableWeightKg = manifestChargeableWeightKg(snapshot, line.weightKg);
        }
        // Match by parcel barcode where possible; fall back to position.
        const indexByAwb = new Map(
          snapshot.parcels.map((parcel, index) => [String(parcel.swiftlineParcelNumber), index])
        );
        parcels.forEach((parcel, index) => {
          if (typeof parcel.chargeableWeightKg !== "number") {
            const matchedIndex = indexByAwb.get(String(parcel.awbNumber)) ?? index;
            const matched = snapshot.parcels[matchedIndex];
            parcel.chargeableWeightKg = manifestParcelChargeableWeightKg(
              snapshot,
              matched?.sequence,
              matchedIndex,
              parcel.weightKg
            );
          }
        });
        summary.filled += 1;
        changed = true;
      }

      if (changed) {
        manifest.markModified("lineSnapshots");
        await manifest.save();
        summary.updated += 1;
      }
    }
    console.log("Manifest chargeable-weight backfill complete.", summary);
  } finally {
    await mongoose.disconnect();
  }
}

backfillManifestChargeableWeights().catch((error) => {
  console.error("Manifest chargeable-weight backfill failed.", error);
  process.exitCode = 1;
});
