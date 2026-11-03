import mongoose from "mongoose";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import type { IDpdShipment } from "../models/dpdShipment.model.js";
import type { IEmailAttachmentRef } from "../models/emailOutbox.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import type { IShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { Tenant } from "../models/tenant.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { User } from "../models/user.model.js";
import { notifyPortalUsers } from "./portalNotification.service.js";
import { getTenantContext } from "./tenantScope.service.js";

type OperatorBookingNoticeInput = {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipment: IDpdShipment;
  shipmentInvoice: IShipmentInvoice;
  bookedBy: mongoose.Types.ObjectId;
};

/** Booking is already committed. Notices may fail without making a retry book a second shipment. */
export async function notifyOperatorShipmentBooked(input: OperatorBookingNoticeInput) {
  try {
    const context = getTenantContext();
    if (!context || context.kind !== "OPERATOR") throw new Error("An operator tenant is required for booking notices.");

    const [tenant, draft, accountMembers, staffMemberships, clientMemberships, labels, booker] = await Promise.all([
      Tenant.findById(context.tenantId).select("slug companyName").lean().exec(),
      ShipmentDraft.findById(input.shipmentDraftId).exec(),
      BusinessAccountMember.find({
        businessAccount: input.shipmentInvoice.businessAccountId,
        status: "active",
        role: { $in: ["account_owner", "account_admin", "operations", "finance", "booking_user"] }
      }).select("user role").lean().exec(),
      TenantMembership.find({ tenantId: context.tenantId, status: "ACTIVE", role: { $in: ["OPERATOR_ADMIN", "OPERATIONS"] } })
        .select("userId").lean().exec(),
      TenantMembership.find({ tenantId: context.tenantId, status: "ACTIVE", role: "CLIENT" })
        .select("userId").lean().exec(),
      LabelDocument.find({ dpdShipmentId: input.dpdShipment._id, labelType: "INTERNAL", voidedAt: null })
        .select("_id parcelNumber format storageKey").sort({ parcelNumber: 1 }).lean().exec(),
      User.findById(input.bookedBy).select("name firstName lastName").lean().exec()
    ]);
    if (!tenant?.slug || !draft || String(draft.businessAccountId) !== String(input.shipmentInvoice.businessAccountId)) {
      throw new Error("The operator booking notice could not resolve its shipment and tenant.");
    }

    const candidateIds = [...new Map([
      ...accountMembers.map((member) => member.user),
      ...staffMemberships.map((membership) => membership.userId)
    ].map((id) => [String(id), id])).values()];
    const activeUsers = await User.find({ _id: { $in: candidateIds }, userStatus: "active" })
      .select("_id").lean().exec();
    const activeIds = new Set(activeUsers.map((user) => String(user._id)));
    const clientIds = new Set(clientMemberships.map((membership) => String(membership.userId)));
    const clients = accountMembers
      .filter((member) => member.role !== "booking_user" || String(member.user) === String(input.bookedBy))
      .map((member) => member.user)
      .filter((id) => clientIds.has(String(id)) && activeIds.has(String(id)));
    const staff = staffMemberships.map((membership) => membership.userId)
      .filter((id) => activeIds.has(String(id)));

    const [businessAccount, branch] = await Promise.all([
      BusinessAccount.findById(draft.businessAccountId).select("company.companyName contact.firstName contact.lastName").lean().exec(),
      Branch.findById(draft.branchId).select("name").lean().exec()
    ]);
    const consignee = draft.consigneeValidatedAddress ?? draft.consigneeSelectedAddress ?? draft.consigneeEnteredAddress;
    const trackingNumber = input.dpdShipment.swiftlineTrackingNumber || String(input.shipmentDraftId);
    const href = `/portal/${encodeURIComponent(tenant.slug)}/shipments/${String(input.shipmentDraftId)}`;
    const payload = {
      trackingNumber,
      businessAccountName: businessAccount?.company?.companyName
        || [businessAccount?.contact?.firstName, businessAccount?.contact?.lastName].filter(Boolean).join(" ")
        || "Business account",
      operatorName: tenant.companyName,
      branchName: branch?.name || "",
      bookedByName: booker?.name || [booker?.firstName, booker?.lastName].filter(Boolean).join(" "),
      consigneeName: consignee?.companyName || consignee?.contactName || "",
      destination: [consignee?.townOrCity, consignee?.countryName || consignee?.countryCode].filter(Boolean).join(", "),
      parcelCount: draft.parcelList.length,
      totalWeightKg: draft.parcelList.reduce((total, parcel) => total + (parcel.weightKg || 0), 0),
      invoiceNumber: input.shipmentInvoice.invoiceNumber,
      invoiceTotalMinor: input.shipmentInvoice.totalAmountMinor,
      currency: input.shipmentInvoice.currency,
      bookedAt: input.dpdShipment.createdAt,
      href
    };
    const uniqueLabels = labels.filter((label, index) => labels.findIndex((other) => other.storageKey === label.storageKey) === index);
    const attachments: IEmailAttachmentRef[] = [
      {
        kind: "SHIPMENT_INVOICE_PDF",
        refId: input.shipmentInvoice._id as mongoose.Types.ObjectId,
        revision: input.shipmentInvoice.revision,
        filename: `${input.shipmentInvoice.invoiceNumber.replaceAll("/", "-")}-Invoice.pdf`
      },
      ...uniqueLabels.map((label) => ({
        kind: "LABEL_DOCUMENT" as const,
        refId: label._id,
        revision: null,
        filename: `Internal-Label-${label.parcelNumber}.${label.format.toLowerCase()}`
      }))
    ];
    const idempotencyKey = `OPERATOR_SHIPMENT_BOOKED:${String(input.dpdShipment._id)}`;
    const metadata = { shipmentDraftId: input.shipmentDraftId, dpdShipmentId: input.dpdShipment._id, trackingNumber };
    const results = await Promise.allSettled([
      notifyPortalUsers(clients, {
        type: "SHIPMENT_BOOKED",
        title: "Shipment booked",
        message: `${trackingNumber} is booked. Your invoice and internal labels are ready.`,
        href,
        idempotencyKey: `${idempotencyKey}:CLIENT`,
        businessAccountId: draft.businessAccountId,
        metadata,
        email: { templateKey: "OPERATOR_SHIPMENT_BOOKED_CLIENT", payload, attachmentRefs: attachments }
      }),
      notifyPortalUsers(staff, {
        type: "SHIPMENT_BOOKED",
        title: "New shipment booked",
        message: `${payload.businessAccountName} booked ${trackingNumber} at ${payload.branchName || "the portal"}.`,
        href,
        idempotencyKey: `${idempotencyKey}:STAFF`,
        businessAccountId: draft.businessAccountId,
        metadata,
        email: { templateKey: "OPERATOR_SHIPMENT_BOOKED_STAFF", payload }
      })
    ]);
    if (results.some((result) => result.status === "rejected")) {
      console.error("Operator booking notices failed for one or more audiences.", {
        shipmentDraftId: String(input.shipmentDraftId),
        failedAudiences: results.flatMap((result, index) => result.status === "rejected" ? [index === 0 ? "client" : "staff"] : [])
      });
    }
  } catch (error) {
    console.error("Operator booking notice failed.", {
      shipmentDraftId: String(input.shipmentDraftId),
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
