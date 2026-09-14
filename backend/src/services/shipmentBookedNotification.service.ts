import mongoose from "mongoose";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { User } from "../models/user.model.js";
import type { IEmailAttachmentRef } from "../models/emailOutbox.model.js";
import type { IDpdShipment } from "../models/dpdShipment.model.js";
import type { IShipmentDraft } from "../models/shipmentDraft.model.js";
import type { IShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { notifyBranchOperationsStaff, notifyBusinessShipmentMembers, notifyOperationsStaff } from "./portalNotification.service.js";

type ShipmentBookedInput = {
  draft: IShipmentDraft;
  dpdShipment: IDpdShipment;
  shipmentInvoice: IShipmentInvoice;
  bookedBy: mongoose.Types.ObjectId;
};

function resolveConsigneeAddress(draft: IShipmentDraft) {
  return draft.consigneeValidatedAddress ?? draft.consigneeSelectedAddress ?? draft.consigneeEnteredAddress;
}

function buildPayload(input: ShipmentBookedInput, context: {
  businessAccountName: string;
  branchName: string;
  bookedByName: string;
}) {
  const { draft, dpdShipment, shipmentInvoice } = input;
  const consignee = resolveConsigneeAddress(draft);
  const totalWeightKg = draft.parcelList.reduce((total, parcel) => total + (parcel.weightKg || 0), 0);
  const destination = [consignee?.townOrCity, consignee?.countryName || consignee?.countryCode]
    .filter(Boolean)
    .join(", ");
  const customerReference = shipmentInvoice.shipment?.customerReference;

  return {
    trackingNumber: dpdShipment.swiftlineTrackingNumber || "",
    customerReference: typeof customerReference === "string" ? customerReference : "",
    serviceType: draft.serviceType === "CARGO" ? "Cargo" : "Courier",
    destination,
    consigneeName: consignee?.companyName || consignee?.contactName || "",
    parcelCount: draft.parcelList.length,
    totalWeightKg,
    bookedAt: dpdShipment.createdAt,
    invoiceNumber: shipmentInvoice.invoiceNumber,
    currency: shipmentInvoice.currency,
    taxableValueMinor: shipmentInvoice.taxableValueMinor,
    totalTaxAmountMinor: shipmentInvoice.totalTaxAmountMinor,
    taxTreatment: shipmentInvoice.taxTreatment,
    invoiceTotalMinor: shipmentInvoice.totalAmountMinor,
    businessAccountName: context.businessAccountName,
    branchName: context.branchName,
    bookedByName: context.bookedByName,
    href: `/client/shipments/${String(draft._id)}`,
    staffHref: `/dashboard/dpd-labels/${String(draft._id)}`
  };
}

/**
 * Notifies the client and the operations desk that a shipment is booked, with
 * the tax invoice and labels attached.
 *
 * Delivery is best effort. The shipment, its labels and its invoice are already
 * persisted by the time this runs, so a notification failure must never
 * propagate- re-booking is precisely what must not happen here.
 */
export async function notifyShipmentBooked(input: ShipmentBookedInput) {
  const { draft, dpdShipment, shipmentInvoice } = input;

  try {
    const [businessAccount, branch, bookedByUser, labels] = await Promise.all([
      BusinessAccount.findById(draft.businessAccountId).select("company.companyName").lean().exec(),
      Branch.findById(draft.branchId).select("name").lean().exec(),
      User.findById(input.bookedBy).select("name firstName lastName").lean().exec(),
      LabelDocument.find({
        dpdShipmentId: dpdShipment._id,
        voidedAt: null,
        ...(draft.creationSource === "PUBLIC_ONLINE" ? { labelType: "SWIFTLINE" } : {}),
      })
        .select("_id labelType parcelNumber format storageKey")
        // labelType descending puts SWIFTLINE after DPD, which is the order the
        // attachments are wanted in - see the size-budget note below.
        .sort({ labelType: -1, parcelNumber: 1 })
        .lean()
        .exec()
    ]);

    const payload = buildPayload(input, {
      businessAccountName: businessAccount?.company?.companyName ?? "",
      branchName: branch?.name ?? "",
      bookedByName: bookedByUser?.name
        || `${bookedByUser?.firstName ?? ""} ${bookedByUser?.lastName ?? ""}`.trim()
    });

    const invoiceAttachment: IEmailAttachmentRef = {
      kind: "SHIPMENT_INVOICE_PDF",
      refId: shipmentInvoice._id as mongoose.Types.ObjectId,
      revision: shipmentInvoice.revision,
      filename: `${shipmentInvoice.invoiceNumber.replaceAll("/", "-")}-Invoice.pdf`
    };

    const labelAttachment = (label: {
      _id: mongoose.Types.ObjectId;
      labelType?: string;
      parcelNumber: string;
      format: string;
    }): IEmailAttachmentRef => ({
      kind: "LABEL_DOCUMENT",
      refId: label._id,
      revision: null,
      filename: label.labelType === "DPD"
        ? `DPD-Label-${label.parcelNumber}.${label.format.toLowerCase()}`
        : `Swiftline-Labels-${dpdShipment.swiftlineTrackingNumber}.${label.format.toLowerCase()}`
    });

    // Client and staff receive the same documents: the label is what the parcel
    // travels on, so withholding it from the client leaves them unable to hand
    // over. The invoice leads the list so that if the size budget runs out it is
    // labels that get dropped, never the document needed for accounts.
    const printableLabels = labels.filter((label, index) => (
      labels.findIndex((candidate) => candidate.storageKey === label.storageKey) === index
    ));
    const attachments = [invoiceAttachment, ...printableLabels.map(labelAttachment)];
    // Drives the wording in the booked email: a UK shipment travels on the DPD
    // label, so the message must not tell the customer to affix only ours.
    const hasDpdLabel = labels.some((label) => label.labelType === "DPD");

    const trackingNumber = payload.trackingNumber || String(draft._id);
    const idempotencyKey = `SHIPMENT_BOOKED:${String(dpdShipment._id)}`;
    const parcelLabel = `${payload.parcelCount} parcel${payload.parcelCount === 1 ? "" : "s"}`;

    const clientNotification = notifyBusinessShipmentMembers(draft.businessAccountId, {
      type: "SHIPMENT_BOOKED",
      title: "Shipment booked",
      message: `${trackingNumber} is booked (${parcelLabel}). Invoice ${payload.invoiceNumber} is ready.`,
      href: payload.href,
      idempotencyKey,
      businessAccountId: draft.businessAccountId,
      metadata: {
        shipmentDraftId: draft._id,
        dpdShipmentId: dpdShipment._id,
        shipmentInvoiceId: shipmentInvoice._id,
        trackingNumber: payload.trackingNumber
      },
      email: {
        templateKey: "SHIPMENT_BOOKED_CLIENT",
        payload: { ...payload, hasDpdLabel },
        attachmentRefs: attachments
      }
    });

    const notifyStaff = draft.creationSource === "PUBLIC_ONLINE"
      ? notifyBranchOperationsStaff.bind(null, draft.branchId)
      : notifyOperationsStaff;
    const staffNotification = notifyStaff({
      type: "SHIPMENT_BOOKED",
      title: "New shipment booked",
      message: `${payload.businessAccountName || "A client"} booked ${trackingNumber} (${parcelLabel}) at ${payload.branchName || "the portal"}.`,
      href: payload.staffHref,
      // Distinct key: staff and client rows are separate notifications for the
      // same event and must not collide on the unique index.
      idempotencyKey: `${idempotencyKey}:STAFF`,
      businessAccountId: draft.businessAccountId,
      metadata: {
        shipmentDraftId: draft._id,
        dpdShipmentId: dpdShipment._id,
        trackingNumber: payload.trackingNumber
      },
      email: {
        templateKey: "SHIPMENT_BOOKED_STAFF",
        payload: { ...payload, hasDpdLabel },
        attachmentRefs: attachments
      }
    });

    // These audiences are independent. Queue both together, but wait for both
    // to settle so no database work continues after booking returns and one
    // audience failing cannot prevent the other from receiving its notice.
    const notificationResults = await Promise.allSettled([
      clientNotification,
      staffNotification
    ]);
    const failedAudiences = notificationResults.flatMap((result, index) => (
      result.status === "rejected" ? [index === 0 ? "client" : "operations"] : []
    ));
    if (failedAudiences.length) {
      console.error("Shipment booked notification failed for one or more audiences.", {
        shipmentDraftId: String(draft._id),
        dpdShipmentId: String(dpdShipment._id),
        failedAudiences
      });
    }
  } catch (error) {
    console.error("Shipment booked notification failed.", {
      shipmentDraftId: String(draft._id),
      dpdShipmentId: String(dpdShipment._id),
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
