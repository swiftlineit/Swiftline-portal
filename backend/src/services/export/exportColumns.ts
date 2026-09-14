/**
 * Every exportable table's columns, in one registry.
 *
 * Modelled on `edi/ediColumns.ts`: header, order and source live here and
 * nowhere else, so an export can never disagree with itself across formats and
 * a new column is one entry rather than an edit in four files.
 *
 * These are deliberately wider than the on-screen table. A screen has to fit a
 * viewport and drops columns to do it; a spreadsheet has no such limit, and the
 * reason someone exports is usually the column the table left out.
 */
import type { ExportColumn } from "./tableExport.service.js";

/** A row of the booked-shipments list, as its serializer emits one. */
type ShipmentRow = {
  swiftlineTrackingNumber: string;
  awbNumbers: string[];
  forwardingNumbers: string[];
  shipmentReference: string;
  businessAccountName: string;
  branch: { name: string; code: string; city: string };
  consignor: string;
  consignee: string;
  destination: string;
  destinationCountry: string;
  product: string;
  serviceInfo: string;
  route: string;
  pieces: number;
  weightKg: number;
  statusLabel: string;
  bookingStatusLabel: string;
  lastScan: { statusLabel: string; location: string; at: string | Date } | null;
  shipmentInvoice: { invoiceNumber: string; currency: string; chargeableAmountMinor: number } | null;
  createdAt: string | Date | null;
  parcelManifests?: Array<{
    parcelNumber: string;
    scanState: "SCANNED" | "AWAITING_SCAN";
    manifestNumber: string | null;
  }>;
};

/** Minor units are stored as integers; a spreadsheet wants the real amount. */
function fromMinor(amountMinor: number | null | undefined) {
  return typeof amountMinor === "number" ? amountMinor / 100 : null;
}

function asDate(value: string | Date | null | undefined) {
  return value ? new Date(value) : null;
}

export const shipmentExportColumns: Array<ExportColumn<ShipmentRow>> = [
  { header: "AWB", value: (row) => row.swiftlineTrackingNumber || "", width: 20 },
  { header: "Parcel numbers", value: (row) => row.awbNumbers.join(", "), width: 26 },
  // Mirrors the staff Parcels column: per-parcel manifest run or awaiting state.
  {
    header: "Parcel manifest status",
    value: (row) => (row.parcelManifests ?? [])
      .map((parcel) => parcel.scanState === "SCANNED" && parcel.manifestNumber
        ? `${parcel.parcelNumber} (${parcel.manifestNumber})`
        : `${parcel.parcelNumber} (Awaiting manifest scan)`)
      .join("; "),
    width: 34
  },
  { header: "Carrier numbers", value: (row) => row.forwardingNumbers.join(", "), width: 26 },
  { header: "Customer reference", value: (row) => row.shipmentReference, width: 20 },
  { header: "Account", value: (row) => row.businessAccountName, width: 26 },
  { header: "Branch", value: (row) => (row.branch.code ? `${row.branch.name} (${row.branch.code})` : row.branch.name), width: 24 },
  { header: "Consignor", value: (row) => row.consignor, width: 24 },
  { header: "Consignee", value: (row) => row.consignee, width: 24 },
  { header: "Destination", value: (row) => row.destination, width: 28 },
  { header: "Country", value: (row) => row.destinationCountry, width: 16 },
  { header: "Route", value: (row) => row.route, width: 26 },
  { header: "Service", value: (row) => row.serviceInfo, width: 12 },
  { header: "Contents", value: (row) => row.product, width: 22 },
  { header: "Pieces", value: (row) => row.pieces, width: 8 },
  { header: "Weight (kg)", value: (row) => row.weightKg, width: 12 },
  { header: "Status", value: (row) => row.statusLabel, width: 18 },
  { header: "Booking status", value: (row) => row.bookingStatusLabel, width: 18 },
  { header: "Last scan", value: (row) => row.lastScan?.statusLabel ?? "", width: 18 },
  { header: "Last scan location", value: (row) => row.lastScan?.location ?? "", width: 20 },
  { header: "Last scan at", value: (row) => asDate(row.lastScan?.at ?? null), width: 20 },
  { header: "Invoice", value: (row) => row.shipmentInvoice?.invoiceNumber ?? "", width: 18 },
  { header: "Invoice amount", value: (row) => fromMinor(row.shipmentInvoice?.chargeableAmountMinor), width: 16 },
  { header: "Booked", value: (row) => asDate(row.createdAt), width: 20 }
];

/** A row of the support ticket list, as `serializeSupportTicket` emits one. */
type TicketRow = {
  ticketNumber: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  account: { companyName: string; accountId: string } | null;
  branch: { name: string; code: string } | null;
  creator: { name: string; email: string } | null;
  assignee: { name: string } | null;
  relatedShipment: { awb: string } | null;
  sla: { firstResponseDueAt: string | Date; firstRespondedAt: string | Date | null; breached: boolean } | null;
  lastMessageAt: string | Date;
  resolvedAt: string | Date | null;
  closedAt: string | Date | null;
  createdAt: string | Date;
};

/** Stored enum values read as SCREAMING_SNAKE; a reader wants words. */
function words(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export const ticketExportColumns: Array<ExportColumn<TicketRow>> = [
  { header: "Ticket", value: (row) => row.ticketNumber, width: 20 },
  { header: "Subject", value: (row) => row.subject, width: 34 },
  { header: "Category", value: (row) => words(row.category), width: 20 },
  { header: "Priority", value: (row) => words(row.priority), width: 12 },
  { header: "Status", value: (row) => words(row.status), width: 20 },
  { header: "Account", value: (row) => row.account ? `${row.account.companyName} (${row.account.accountId})` : "", width: 28 },
  { header: "Branch", value: (row) => row.branch ? `${row.branch.name} (${row.branch.code})` : "", width: 22 },
  { header: "Raised by", value: (row) => row.creator?.name ?? "", width: 22 },
  { header: "Raised by email", value: (row) => row.creator?.email ?? "", width: 26 },
  { header: "Assigned to", value: (row) => row.assignee?.name ?? "Unassigned", width: 22 },
  { header: "AWB", value: (row) => row.relatedShipment?.awb ?? "", width: 20 },
  { header: "First response due", value: (row) => asDate(row.sla?.firstResponseDueAt ?? null), width: 20 },
  { header: "First responded", value: (row) => asDate(row.sla?.firstRespondedAt ?? null), width: 20 },
  // Plain words rather than TRUE/FALSE: this column is read, not computed on.
  { header: "SLA", value: (row) => row.sla ? (row.sla.breached ? "Exceeded" : "Met") : "", width: 12 },
  { header: "Raised", value: (row) => asDate(row.createdAt), width: 20 },
  { header: "Last message", value: (row) => asDate(row.lastMessageAt), width: 20 },
  { header: "Resolved", value: (row) => asDate(row.resolvedAt), width: 20 },
  { header: "Closed", value: (row) => asDate(row.closedAt), width: 20 }
];

/** A row of the claims list, as `serializeClaim` emits one. */
type ClaimRow = {
  claimNumber: string | null;
  status: string;
  category: string;
  submissionStage: string;
  decisionOutcome: string | null;
  acceptanceState: string;
  appealState: string;
  incidentDate: string | Date | null;
  shipmentSnapshot: {
    trackingNumber: string;
    consigneeName: string;
    destinationCountryCode: string;
    serviceName: string;
    bookedAt: string | Date;
    deliveredAt: string | Date | null;
  } | null;
  deadlines: { filingDeadlineAt: string | Date; filedLate: boolean } | null;
  currency?: string;
  requestedAmountMinor?: number;
  approvedAmountMinor?: number | null;
  paidAmountMinor?: number | null;
  submittedAt: string | Date | null;
  decidedAt: string | Date | null;
  settledAt: string | Date | null;
  createdAt: string | Date;
};

/**
 * Claim columns, minus money.
 *
 * The amounts are role-gated: `serializeClaim` omits them entirely for a member
 * without financial visibility. A spreadsheet is the easiest thing in the world
 * to forward, so the money columns are a separate list added only when the
 * caller was allowed to see them- rather than one list that quietly writes
 * blanks and leaves the headings standing.
 */
export const claimExportColumns: Array<ExportColumn<ClaimRow>> = [
  { header: "Claim", value: (row) => row.claimNumber ?? "Draft", width: 20 },
  { header: "Status", value: (row) => words(row.status), width: 22 },
  { header: "Category", value: (row) => words(row.category), width: 24 },
  { header: "Stage", value: (row) => words(row.submissionStage), width: 18 },
  { header: "Decision", value: (row) => row.decisionOutcome ? words(row.decisionOutcome) : "", width: 20 },
  { header: "Acceptance", value: (row) => words(row.acceptanceState), width: 16 },
  { header: "Appeal", value: (row) => words(row.appealState), width: 16 },
  { header: "AWB", value: (row) => row.shipmentSnapshot?.trackingNumber ?? "", width: 20 },
  { header: "Consignee", value: (row) => row.shipmentSnapshot?.consigneeName ?? "", width: 24 },
  { header: "Destination", value: (row) => row.shipmentSnapshot?.destinationCountryCode ?? "", width: 12 },
  { header: "Service", value: (row) => row.shipmentSnapshot?.serviceName ?? "", width: 14 },
  { header: "Shipment booked", value: (row) => asDate(row.shipmentSnapshot?.bookedAt ?? null), width: 20 },
  { header: "Delivered", value: (row) => asDate(row.shipmentSnapshot?.deliveredAt ?? null), width: 20 },
  { header: "Incident date", value: (row) => asDate(row.incidentDate), width: 20 },
  { header: "Filing deadline", value: (row) => asDate(row.deadlines?.filingDeadlineAt ?? null), width: 20 },
  { header: "Filed late", value: (row) => row.deadlines?.filedLate ? "Yes" : "No", width: 12 },
  { header: "Raised", value: (row) => asDate(row.createdAt), width: 20 },
  { header: "Submitted", value: (row) => asDate(row.submittedAt), width: 20 },
  { header: "Decided", value: (row) => asDate(row.decidedAt), width: 20 },
  { header: "Settled", value: (row) => asDate(row.settledAt), width: 20 }
];

/**
 * Who the claim belongs to and who is working it.
 *
 * Staff only, and not because a customer is forbidden the columns- their own
 * account and branch are the same on every row, so the columns would carry no
 * information and only make the file wider.
 */
export const staffClaimExportColumns: Array<ExportColumn<ClaimRow & {
  businessAccountName: string;
  businessAccountCode: string;
  branchName: string;
  branchCode: string;
  assignedToName: string;
}>> = [
  { header: "Account", value: (row) => row.businessAccountCode ? `${row.businessAccountName} (${row.businessAccountCode})` : row.businessAccountName, width: 28 },
  { header: "Branch", value: (row) => row.branchCode ? `${row.branchName} (${row.branchCode})` : row.branchName, width: 22 },
  { header: "Handler", value: (row) => row.assignedToName || "Unassigned", width: 22 }
];

/** A row of the pickup list, as `listPickupRequests` serializes one. */
type PickupRow = {
  requestNumber: string;
  status: string;
  statusLabel?: string;
  businessAccountName?: string;
  branchName?: string;
  pickupContact?: { name: string; phone: string } | null;
  pickupAddress?: Record<string, unknown> | null;
  requestedWindow: { startAt: string | Date; endAt: string | Date } | null;
  confirmedWindow?: { startAt: string | Date; endAt: string | Date } | null;
  shipmentCount: number;
  parcelCount: number;
  totalWeightKg: number;
  createdAt: string | Date;
};

/** The address is stored loosely, so it is joined defensively for the file. */
function addressLine(address?: Record<string, unknown> | null) {
  if (!address) return "";
  return ["addressLine1", "addressLine2", "townOrCity", "postcode", "countryCode"]
    .map((key) => String(address[key] ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

export const pickupExportColumns: Array<ExportColumn<PickupRow>> = [
  { header: "Pickup reference", value: (row) => row.requestNumber, width: 22 },
  { header: "Status", value: (row) => row.statusLabel ?? words(row.status), width: 20 },
  { header: "Account", value: (row) => row.businessAccountName ?? "", width: 26 },
  { header: "Branch", value: (row) => row.branchName ?? "", width: 22 },
  { header: "Contact", value: (row) => row.pickupContact?.name ?? "", width: 22 },
  { header: "Phone", value: (row) => row.pickupContact?.phone ?? "", width: 18 },
  { header: "Pickup address", value: (row) => addressLine(row.pickupAddress), width: 40 },
  { header: "Requested from", value: (row) => asDate(row.requestedWindow?.startAt ?? null), width: 20 },
  { header: "Requested to", value: (row) => asDate(row.requestedWindow?.endAt ?? null), width: 20 },
  { header: "Confirmed from", value: (row) => asDate(row.confirmedWindow?.startAt ?? null), width: 20 },
  { header: "Confirmed to", value: (row) => asDate(row.confirmedWindow?.endAt ?? null), width: 20 },
  { header: "Shipments", value: (row) => row.shipmentCount, width: 12 },
  { header: "Parcels", value: (row) => row.parcelCount, width: 10 },
  { header: "Weight (kg)", value: (row) => row.totalWeightKg, width: 12 },
  { header: "Raised", value: (row) => asDate(row.createdAt), width: 20 }
];

/** A row of the POD Centre, as `listClientPods` returns one. */
type PodRow = {
  awb: string;
  carrierReference: string;
  consignee: string;
  destination: string;
  parcelNumbers: string[];
  recipientName: string;
  recipientRelationship: string;
  deliveredAt: Date | null;
  evidenceCount: number;
};

export const podExportColumns: Array<ExportColumn<PodRow>> = [
  { header: "AWB", value: (row) => row.awb, width: 20 },
  { header: "Carrier reference", value: (row) => row.carrierReference, width: 22 },
  { header: "Consignee", value: (row) => row.consignee, width: 26 },
  { header: "Destination", value: (row) => row.destination, width: 26 },
  { header: "Parcels", value: (row) => row.parcelNumbers.join(", "), width: 26 },
  { header: "Received by", value: (row) => row.recipientName, width: 22 },
  { header: "Relationship", value: (row) => row.recipientRelationship, width: 18 },
  { header: "Delivered at", value: (row) => row.deliveredAt, width: 20 },
  { header: "Evidence files", value: (row) => row.evidenceCount, width: 14 }
];

/** Appended only for a caller with financial visibility. */
export const claimFinancialExportColumns: Array<ExportColumn<ClaimRow>> = [
  { header: "Currency", value: (row) => row.currency ?? "", width: 10 },
  { header: "Requested", value: (row) => fromMinor(row.requestedAmountMinor), width: 14 },
  { header: "Approved", value: (row) => fromMinor(row.approvedAmountMinor), width: 14 },
  { header: "Paid", value: (row) => fromMinor(row.paidAmountMinor), width: 14 }
];
