import mongoose from "mongoose";

/**
 * A document-only edited copy of a shipment tax invoice.
 *
 * This lives in its own collection and never alters the legal invoice in
 * `ShipmentInvoice`: creating, updating or deleting one of these rows leaves
 * the real invoice, its number, its revisions and every money record exactly
 * as they were. It exists so a corrected-looking paper can be stored
 * permanently and revisited later, from any device.
 */
export interface IShipmentInvoiceRevisedDocument extends mongoose.Document {
  shipmentDraftId: mongoose.Types.ObjectId;
  /** The statutory number of the real invoice, kept for reference. */
  invoiceNumber: string;
  /** The real backend revision this copy was cloned from. */
  basedOnRevision: number;
  /** The full edited invoice document, as served to viewers and the PDF. */
  document: Record<string, unknown>;
  /** Why the current document copy differs from the real invoice. */
  changeReason: string;
  /** Snapshots replaced by later edits; never exposed to client viewers. */
  history: Array<{
    document: Record<string, unknown>;
    changeReason: string;
    updatedBy: mongoose.Types.ObjectId;
    updatedAt: Date;
  }>;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId | null;
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const shipmentInvoiceRevisedDocumentSchema = new mongoose.Schema<IShipmentInvoiceRevisedDocument>(
  {
    shipmentDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ShipmentDraft", required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true, maxlength: 32 },
    basedOnRevision: { type: Number, required: true, min: 1 },
    document: { type: mongoose.Schema.Types.Mixed, required: true },
    changeReason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
    history: {
      type: [{
        document: { type: mongoose.Schema.Types.Mixed, required: true },
        changeReason: { type: String, required: true, trim: true, maxlength: 500 },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        updatedAt: { type: Date, required: true }
      }],
      default: []
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

shipmentInvoiceRevisedDocumentSchema.index({ shipmentDraftId: 1, deletedAt: 1, updatedAt: -1 });

export const ShipmentInvoiceRevisedDocument = mongoose.model<IShipmentInvoiceRevisedDocument>(
  "ShipmentInvoiceRevisedDocument",
  shipmentInvoiceRevisedDocumentSchema
);
