import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { ShipmentInvoiceRevisedDocument } from "../models/shipmentInvoiceRevisedDocument.model.js";

/**
 * Production does not auto-create indexes. This additive, idempotent migration
 * creates the lookup index used by the revised-copy list without altering any
 * invoice, revised document, or unrelated collection.
 */
async function migrateShipmentInvoiceRevisedDocumentIndexes() {
  await connectDatabase();
  try {
    await ShipmentInvoiceRevisedDocument.createIndexes();
    console.log("Shipment invoice revised-document indexes are ready.");
  } finally {
    await mongoose.disconnect();
  }
}

migrateShipmentInvoiceRevisedDocumentIndexes().catch((error) => {
  console.error("Shipment invoice revised-document index migration failed.", error);
  process.exitCode = 1;
});
