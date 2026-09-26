import type { IBranch } from "../models/branch.model.js";
import type { IBusinessAccount } from "../models/businessAccount.model.js";
import type { IShipmentDraft } from "../models/shipmentDraft.model.js";
import type { ShipmentPricingEstimate } from "./shipmentPricing.service.js";
import type { ShipmentLabelData } from "./shipmentLabelPdf.service.js";
import { maskAadhaarNumber } from "./aadhaarValidation.service.js";
import { getParcelItemAmount, normalizeParcelItems } from "./parcelItems.service.js";
import { normalizeCsbType, type CsbType } from "./csbType.service.js";
import { formatSwiftlineParcelNumber } from "./swiftlineTracking.service.js";
import { publicShipmentSourceIdentity } from "./shipmentSourceIdentity.service.js";

export type ShipmentBookingSnapshot = {
  version: 1;
  bookedAt: string;
  /** Optional for compatibility with snapshots created before CSB selection was stored. */
  csbType?: CsbType;
  source: {
    invoiceNumber: string;
    shipmentReference: string;
  };
  account: Record<string, unknown>;
  /** The Swiftline branch the shipment is lodged at. */
  sender: Record<string, unknown>;
  /**
   * The Indian sender captured during review. Absent on shipments booked before
   * consignor capture existed, so every reader must tolerate `undefined`.
   */
  consignor?: IShipmentDraft["consignorAddress"];
  consignee: IShipmentDraft["consigneeEnteredAddress"];
  service: {
    type: string;
    code: string;
  };
  tracking: {
    swiftlineTrackingNumber: string;
    carrierShipmentId: string;
    carrierTransactionId: string;
  };
  parcels: Array<Record<string, unknown> & {
    sequence: number;
    actualWeightKg: number;
    carrierParcelNumber: string;
    swiftlineParcelNumber: string;
    items?: Array<{ description: string; hsnCode: string; unitType: string; quantity: number; unitRate: number }>;
    declaredGoodsValueMinor?: number | null;
  }>;
  pricing: ShipmentPricingEstimate;
  payment: {
    currency: "INR";
    totalAmountMinor: number;
    advanceAmountMinor: number;
    creditAmountMinor: number;
  };
};

export function readShipmentBookingSnapshot(value: unknown): ShipmentBookingSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ShipmentBookingSnapshot>;
  if (
    candidate.version !== 1
    || !candidate.source
    || !candidate.tracking
    || !candidate.payment
    || !candidate.pricing
    || !Array.isArray(candidate.parcels)
  ) {
    return null;
  }
  return candidate as ShipmentBookingSnapshot;
}

export function serializeShipmentBookingConfirmation(value: unknown) {
  const snapshot = readShipmentBookingSnapshot(value);
  if (!snapshot) return null;

  const customerReference = snapshot.parcels.find((parcel) => (
    typeof parcel.reference === "string" && Boolean(parcel.reference.trim())
  ))?.reference;

  return {
    swiftlineTrackingNumber: snapshot.tracking.swiftlineTrackingNumber,
    carrierShipmentId: snapshot.tracking.carrierShipmentId,
    shipmentReference: snapshot.source.shipmentReference,
    customerReference: typeof customerReference === "string" ? customerReference : "",
    serviceType: snapshot.service.type,
    serviceCode: snapshot.service.code,
    parcelCount: snapshot.parcels.length,
    totalActualWeightKg: snapshot.parcels.reduce((total, parcel) => total + parcel.actualWeightKg, 0),
    baseAmountMinor: Math.round(snapshot.pricing.baseAmount * 100),
    gstAmountMinor: Math.round(snapshot.pricing.gstAmount * 100),
    totalAmountMinor: snapshot.payment.totalAmountMinor,
    advanceAmountMinor: snapshot.payment.advanceAmountMinor,
    creditAmountMinor: snapshot.payment.creditAmountMinor
  };
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Goods value for one parcel, stored in minor currency units in the booking snapshot. */
export function parcelDeclaredGoodsValueMinor(parcel: {
  items?: Array<{ quantity?: unknown; unitRate?: unknown }> | null;
  contentsDescription?: unknown;
}) {
  const amount = normalizeParcelItems(parcel).reduce(
    (total, item) => total + getParcelItemAmount(item),
    0
  );
  return Math.round(amount * 100);
}

export function snapshotDeclaredGoodsValueMinor(snapshot: Pick<ShipmentBookingSnapshot, "parcels">) {
  return snapshot.parcels.reduce(
    (total, parcel) => total + (typeof parcel.declaredGoodsValueMinor === "number" && parcel.declaredGoodsValueMinor > 0
      ? parcel.declaredGoodsValueMinor
      : parcelDeclaredGoodsValueMinor(parcel)),
    0
  );
}

/**
 * Booking snapshots feed labels, invoices, and manifests. The full Aadhaar number
 * stays on the draft only; the snapshot keeps the masked form for reconciliation.
 */
function redactConsignorAadhaar(consignor: IShipmentDraft["consignorAddress"] | undefined) {
  if (!consignor) return undefined;

  return {
    ...(typeof (consignor as { toObject?: () => unknown }).toObject === "function"
      ? (consignor as unknown as { toObject: () => IShipmentDraft["consignorAddress"] }).toObject()
      : consignor),
    aadhaarNumber: maskAadhaarNumber(consignor.aadhaarNumber)
  };
}

/**
 * The buyer recorded on the booking snapshot, which is what the shipment invoice
 * bills- it reads this block first and only falls back to the live account.
 *
 * A walk-in is billed as themselves. Their draft points `businessAccountId` at
 * the system sentinel so the shipment chain has an account to reference, but the
 * sentinel is bookkeeping and must never appear on a customer's invoice, so the
 * block is rebuilt from the identity captured at the counter. The account `id` is
 * still the sentinel's: manifests group by it, and they are internal documents.
 *
 * Derived from the draft rather than passed in by callers, so a new booking path
 * cannot forget it and silently bill a customer as "Individual Customers". the bug would be invinsible if the draft's nbuisiness id was the sentiniel, but the snapshot would be wrong and the invoice would be raised to the sentinekl 
 */
function buildAccountBlock(draft: IShipmentDraft, account: IBusinessAccount) {
  if (draft.customerType !== "INDIVIDUAL") {
    return {
      id: account._id,
      accountId: account.accountId,
      contact: account.contact,
      company: account.company
    };
  }

  const consignor = draft.consignorAddress;
  return {
    id: account._id,
    accountId: "INDIVIDUAL",
    contact: {
      // The invoice joins first and last name, so the whole name goes in first.
      firstName: consignor.contactName ?? "",
      lastName: "",
      email: consignor.email ?? "",
      countryCode: consignor.mobileCountryCode ?? "",
      mobileNumber: consignor.mobileNumber ?? ""
    },
    company: {
      // Individuals trade under their own name and hold no GSTIN, so the invoice
      // is raised without one and GST is charged accordingly.
      companyName: consignor.contactName ?? "",
      gstin: "",
      registeredAddress: consignor.addressLine1 ?? "",
      city: consignor.townOrCity ?? "",
      stateOrProvince: consignor.county ?? "",
      postalCode: consignor.postcode ?? "",
      addressCountry: consignor.countryName ?? "",
      useCompanyAddressAsBillingAddress: true,
      billingAddress: null
    }
  };
}

export function buildShipmentBookingSnapshot(input: {
  draft: IShipmentDraft;
  account: IBusinessAccount;
  branch: IBranch;
  pricing: ShipmentPricingEstimate;
  serviceCode: string;
  bookedAt: Date;
  swiftlineTrackingNumber: string;
  carrierShipmentId: string;
  carrierTransactionId: string;
  carrierParcelNumbers: string[];
  advanceAmountMinor?: number;
  creditAmountMinor?: number;
}): ShipmentBookingSnapshot {
  const consignee = input.draft.consigneeValidatedAddress ?? input.draft.consigneeEnteredAddress;
  const sourceIdentity = publicShipmentSourceIdentity(input.draft);
  return plain({
    version: 1,
    bookedAt: input.bookedAt.toISOString(),
    csbType: normalizeCsbType(input.draft.csbType),
    source: {
      invoiceNumber: sourceIdentity.invoiceNumber,
      shipmentReference: sourceIdentity.shipmentReference
    },
    account: buildAccountBlock(input.draft, input.account),
    sender: {
      branchId: input.branch._id,
      name: input.branch.name,
      code: input.branch.code,
      gstin: input.branch.gstin ?? "",
      invoiceSacCode: input.branch.invoiceSacCode ?? "",
      baseCurrency: input.branch.baseCurrency ?? "INR",
      address: input.branch.address,
      contact: input.branch.contact
    },
    consignor: redactConsignorAadhaar(input.draft.consignorAddress),
    consignee,
    service: {
      type: input.draft.serviceType,
      code: input.serviceCode
    },
    tracking: {
      swiftlineTrackingNumber: input.swiftlineTrackingNumber,
      carrierShipmentId: input.carrierShipmentId,
      carrierTransactionId: input.carrierTransactionId
    },
    parcels: input.draft.parcelList.map((parcel, index) => {
      const items = normalizeParcelItems(parcel);
      return {
        sequence: index + 1,
        actualWeightKg: parcel.weightKg,
        lengthCm: parcel.lengthCm ?? null,
        widthCm: parcel.widthCm ?? null,
        heightCm: parcel.heightCm ?? null,
        shipmentContentType: parcel.shipmentContentType,
        items,
        declaredGoodsValueMinor: parcelDeclaredGoodsValueMinor(parcel),
        contentsDescription: parcel.contentsDescription,
        reference: parcel.shipmentReference1 ?? "",
        carrierParcelNumber: input.carrierParcelNumbers[index] ?? "",
        swiftlineParcelNumber: formatSwiftlineParcelNumber(input.swiftlineTrackingNumber, index)
      };
    }),
    pricing: input.pricing,
    payment: {
      currency: "INR",
      totalAmountMinor: Math.round(input.pricing.totalAmount * 100),
      advanceAmountMinor: input.advanceAmountMinor ?? 0,
      creditAmountMinor: input.creditAmountMinor ?? Math.round(input.pricing.totalAmount * 100)
    }
  });
}

export function buildRevisedShipmentSnapshot(input: {
  previousSnapshot: ShipmentBookingSnapshot;
  draft: IShipmentDraft;
  pricing: ShipmentPricingEstimate;
  advanceAmountMinor: number;
  creditAmountMinor: number;
}): ShipmentBookingSnapshot {
  if (input.draft.parcelList.length !== input.previousSnapshot.parcels.length) {
    throw new Error("AMENDED_PARCEL_COUNT_MISMATCH");
  }

  const consignee = input.draft.consigneeValidatedAddress ?? input.draft.consigneeEnteredAddress;
  return plain({
    ...input.previousSnapshot,
    csbType: normalizeCsbType(input.draft.csbType ?? input.previousSnapshot.csbType),
    consignee,
    service: {
      ...input.previousSnapshot.service,
      type: input.draft.serviceType
    },
    parcels: input.draft.parcelList.map((parcel, index) => ({
      sequence: index + 1,
      actualWeightKg: parcel.weightKg,
      lengthCm: parcel.lengthCm ?? null,
      widthCm: parcel.widthCm ?? null,
      heightCm: parcel.heightCm ?? null,
      shipmentContentType: parcel.shipmentContentType,
      items: normalizeParcelItems(parcel),
      declaredGoodsValueMinor: parcelDeclaredGoodsValueMinor(parcel),
      contentsDescription: parcel.contentsDescription,
      reference: parcel.shipmentReference1 ?? "",
      carrierParcelNumber: input.previousSnapshot.parcels[index]?.carrierParcelNumber ?? "",
      swiftlineParcelNumber: formatSwiftlineParcelNumber(
        input.previousSnapshot.tracking.swiftlineTrackingNumber,
        index
      )
    })),
    pricing: input.pricing,
    payment: {
      currency: "INR",
      totalAmountMinor: Math.round(input.pricing.totalAmount * 100),
      advanceAmountMinor: input.advanceAmountMinor,
      creditAmountMinor: input.creditAmountMinor
    }
  });
}

function compactAddressLines(values: unknown[]) {
  return values.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

export function bookingSnapshotToLabelData(
  snapshot: ShipmentBookingSnapshot,
  parcelIndex: number
): ShipmentLabelData {
  const parcel = snapshot.parcels[parcelIndex];
  const sender = snapshot.sender as {
    name?: string;
    code?: string;
    address?: Record<string, unknown>;
    contact?: Record<string, unknown>;
  };
  const consignee = snapshot.consignee;
  const senderAddress = sender.address ?? {};
  const parcelNumber = parcel?.swiftlineParcelNumber ?? "";

  return {
    // Keep the unique suffixed value for the barcode and all internal scans.
    parcelNumber,
    // CSB-V labels show the shipment HAWB as the human-readable number on each
    // piece. CSB-IV and legacy snapshots retain the existing parcel display.
    displayParcelNumber: snapshot.csbType === "CSB_V"
      ? snapshot.tracking.swiftlineTrackingNumber
      : parcelNumber,
    parcelIndex,
    parcelCount: snapshot.parcels.length,
    weightKg: parcel?.actualWeightKg ?? 0,
    generatedAt: new Date(snapshot.bookedAt),
    origin: {
      // The AWB carries the three-letter station it was allocated against, which
      // is the routing code a handler reads. The branch city is the fallback for
      // bookings made before station codes were recorded on the tracking number.
      stationCode: snapshot.tracking.swiftlineTrackingNumber.slice(3, 6),
      city: String(senderAddress.city || sender.code || "")
    },
    destination: {
      city: String(consignee.townOrCity || ""),
      countryCode: String(consignee.countryCode || ""),
      countryName: String(consignee.countryName || consignee.countryCode || "")
    },
    consignee: {
      name: String(consignee.companyName || consignee.contactName || "Consignee"),
      contactName: String(consignee.contactName || ""),
      addressLines: compactAddressLines([
        consignee.addressLine1,
        consignee.addressLine2,
        consignee.townOrCity,
        consignee.county
      ]),
      postcode: String(consignee.postcode || ""),
      countryCode: String(consignee.countryCode || ""),
      countryName: String(consignee.countryName || consignee.countryCode || ""),
      email: String(consignee.email || "")
    }
  };
}
