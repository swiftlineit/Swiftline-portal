import mongoose from "mongoose";
import { addTenantOwnership, type TenantOwnedFields } from "./plugins/tenantOwnedSchema.plugin.js";

export interface IShipmentInvoiceCounter extends mongoose.Document, TenantOwnedFields {
  financialYear: string;
  sequence: number;
}

const shipmentInvoiceCounterSchema = new mongoose.Schema<IShipmentInvoiceCounter>(
  {
    financialYear: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, default: 0, min: 0 }
  },
  { timestamps: true }
);

shipmentInvoiceCounterSchema.index(
  { tenantId: 1, financialYear: 1 },
  { unique: true, name: "tenant_invoice_counter_year_unique" }
);

addTenantOwnership(shipmentInvoiceCounterSchema);

export const ShipmentInvoiceCounter = mongoose.model<IShipmentInvoiceCounter>(
  "ShipmentInvoiceCounter",
  shipmentInvoiceCounterSchema
);
