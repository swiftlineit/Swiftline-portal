import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { ShipmentManifestCounter } from "../models/shipmentManifestCounter.model.js";
import type { IShipmentManifest, ShipmentManifestLineSnapshot } from "../models/shipmentManifest.model.js";
import {
  readShipmentBookingSnapshot,
  type ShipmentBookingSnapshot
} from "./shipmentBookingSnapshot.service.js";

export class ShipmentManifestServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export type ManifestHeaderInput = {
  destinationAgent: string;
  flightNumber: string;
  departureDate: string;
  mawbNumber: string;
  originIataCode: string;
  destinationIataCode: string;
  valueType: string;
};

export type ManifestLineInput = {
  shipmentDraftId: mongoose.Types.ObjectId;
  dpdShipmentId: mongoose.Types.ObjectId;
  snapshot: ShipmentBookingSnapshot;
  declaredValueMinor: number;
  bagNumber: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function compact(values: unknown[]) {
  return values.map(text).filter(Boolean);
}

function uniqueLines(values: unknown[]) {
  const seen = new Set<string>();
  return values.map(text).filter((value) => {
    if (!value) return false;
    const key = value.replace(/\s+/g, " ").toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function manifestCountryCode(nameValue: unknown, codeValue?: unknown) {
  const code = text(codeValue).toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  const name = text(nameValue).toUpperCase();
  if (["UNITED KINGDOM", "UK", "GREAT BRITAIN"].includes(name)) return "GB";
  if (name === "INDIA") return "IN";
  return name;
}

function formatPersonAddress(value: unknown, includePhone = false) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const lines = uniqueLines([
    source.companyName,
    source.contactName,
    source.addressLine1,
    source.addressLine2,
    source.townOrCity,
    source.county,
    source.postcode,
    manifestCountryCode(source.countryName, source.countryCode)
  ]);
  const phone = `${text(source.mobileCountryCode)}${text(source.mobileNumber)}`;
  if (includePhone && phone) lines.push(`TEL-${phone}`);
  return lines.join("\n");
}

function formatConsignor(snapshot: ShipmentBookingSnapshot) {
  // Shipments booked after consignor capture carry the actual Indian sender.
  // Older shipments fall back to the business account behind the shipment.
  const consignor = snapshot.consignor;
  if (consignor && text(consignor.contactName)) {
    const phone = `${text(consignor.mobileCountryCode)}${text(consignor.mobileNumber)}`;
    return uniqueLines([
      consignor.companyName,
      consignor.contactName,
      consignor.addressLine1,
      consignor.addressLine2,
      consignor.townOrCity,
      consignor.county,
      consignor.postcode,
      manifestCountryCode(consignor.countryName, consignor.countryCode),
      phone ? `TEL-${phone}` : ""
    ]).join("\n");
  }

  const account = snapshot.account as { company?: Record<string, unknown>; contact?: Record<string, unknown> };
  const company = account.company ?? {};
  const contact = account.contact ?? {};
  const contactName = compact([contact.title, contact.firstName, contact.lastName]).join(" ");
  return uniqueLines([
    company.companyName,
    contactName,
    company.registeredAddress,
    company.city,
    company.postalCode,
    manifestCountryCode(company.addressCountry),
    `${text(contact.countryCode)}${text(contact.mobileNumber)}`
      ? `TEL-${text(contact.countryCode)}${text(contact.mobileNumber)}`
      : ""
  ]).join("\n");
}

/**
 * Structured consignor/consignee fields for downstream exports (e.g. the EDI file)
 * that need discrete columns rather than the manifest's newline-joined `formatted`
 * block. Built beside `formatted` from the same booking snapshot, so it adds no DB
 * reads and never loses fields to address de-duplication. Aadhaar is deliberately
 * absent- it stays redacted in snapshots and is read live when actually needed.
 */
export type ManifestPartySnapshot = {
  companyName: string;
  contactName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postcode: string;
  countryCode: string; // ISO-2 where resolvable, else the raw value
  countryName: string;
  phone: string; // digits only, no "TEL-" prefix
};

function partyPhone(countryCode: unknown, number: unknown) {
  return `${text(countryCode)}${text(number)}`;
}

function consigneePartySnapshot(value: unknown): ManifestPartySnapshot {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    companyName: text(source.companyName),
    contactName: text(source.contactName),
    addressLine1: text(source.addressLine1),
    addressLine2: text(source.addressLine2),
    city: text(source.townOrCity),
    state: text(source.county),
    postcode: text(source.postcode),
    countryCode: manifestCountryCode(source.countryName, source.countryCode),
    countryName: text(source.countryName),
    phone: partyPhone(source.mobileCountryCode, source.mobileNumber)
  };
}

// Mirrors formatConsignor's source selection: the captured Indian sender when
// present, otherwise the business account behind the shipment.
function consignorPartySnapshot(snapshot: ShipmentBookingSnapshot): ManifestPartySnapshot {
  const consignor = snapshot.consignor;
  if (consignor && text(consignor.contactName)) {
    return {
      companyName: text(consignor.companyName),
      contactName: text(consignor.contactName),
      addressLine1: text(consignor.addressLine1),
      addressLine2: text(consignor.addressLine2),
      city: text(consignor.townOrCity),
      state: text(consignor.county),
      postcode: text(consignor.postcode),
      countryCode: manifestCountryCode(consignor.countryName, consignor.countryCode),
      countryName: text(consignor.countryName),
      phone: partyPhone(consignor.mobileCountryCode, consignor.mobileNumber)
    };
  }
  const account = snapshot.account as { company?: Record<string, unknown>; contact?: Record<string, unknown> };
  const company = account.company ?? {};
  const contact = account.contact ?? {};
  return {
    companyName: text(company.companyName),
    contactName: compact([contact.title, contact.firstName, contact.lastName]).join(" "),
    addressLine1: text(company.registeredAddress),
    addressLine2: "",
    city: text(company.city),
    state: text(company.stateOrProvince),
    postcode: text(company.postalCode),
    countryCode: manifestCountryCode(company.addressCountry),
    countryName: text(company.addressCountry),
    phone: partyPhone(contact.countryCode, contact.mobileNumber)
  };
}

/** The structured consignor + consignee parties for a booking snapshot. Reused by
 * the backfill that adds parties to manifests sealed before they were captured. */
export function buildManifestParties(snapshot: ShipmentBookingSnapshot): {
  consignor: ManifestPartySnapshot;
  consignee: ManifestPartySnapshot;
} {
  return {
    consignor: consignorPartySnapshot(snapshot),
    consignee: consigneePartySnapshot(snapshot.consignee)
  };
}

export function formatManifestOrigin(senderValue: unknown) {
  const sender = senderValue && typeof senderValue === "object"
    ? senderValue as Record<string, unknown>
    : {};
  const address = sender.address && typeof sender.address === "object"
    ? sender.address as Record<string, unknown>
    : {};
  return uniqueLines([
    sender.name,
    address.address,
    address.city,
    address.stateOrProvince || address.state,
    address.postalCode,
    manifestCountryCode(address.countryName, address.countryCode)
  ]).map((line) => line.toUpperCase()).join("\n");
}

export function formatManifestConsignmentNumber(value: string) {
  return text(value).toUpperCase().replace(/0{2}(?=\d{4}$)/, "");
}

// The customer's business account name for the manifest header, taken from the
// immutable booking snapshot so it matches the rest of the manifest's data.
export function manifestBusinessAccountName(snapshot: ShipmentBookingSnapshot | null | undefined) {
  const account = snapshot?.account && typeof snapshot.account === "object"
    ? snapshot.account as Record<string, unknown>
    : {};
  const company = account.company && typeof account.company === "object"
    ? account.company as Record<string, unknown>
    : {};
  return text(company.companyName);
}

/**
 * The shipment's chargeable weight from its immutable pricing snapshot,
 * matched to parcels by sequence (falling back to position). Snapshots sealed
 * before pricing carried per-parcel chargeable weights fall back to the actual
 * weight so legacy manifests still render a sensible value.
 */
export function manifestChargeableWeightKg(snapshot: ShipmentBookingSnapshot, fallbackKg: number): number {
  const priced = Array.isArray(snapshot.pricing?.parcels) ? snapshot.pricing.parcels : [];
  if (!priced.length) return fallbackKg;
  const bySequence = new Map<number, number>();
  priced.forEach((parcel) => {
    const sequence = Number(parcel.sequence);
    const chargeable = Number(parcel.chargeableWeightKg);
    if (Number.isInteger(sequence) && Number.isFinite(chargeable) && chargeable >= 0) {
      bySequence.set(sequence, chargeable);
    }
  });
  let total = 0;
  let matched = 0;
  snapshot.parcels.forEach((parcel, index) => {
    const raw = bySequence.get(Number(parcel.sequence)) ?? priced[index]?.chargeableWeightKg;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) {
      total += value;
      matched += 1;
    }
  });
  return matched ? Number(total.toFixed(3)) : fallbackKg;
}

/** One parcel's own chargeable weight, falling back to its actual weight. */
export function manifestParcelChargeableWeightKg(
  snapshot: ShipmentBookingSnapshot,
  sequence: unknown,
  index: number,
  fallbackKg: number
): number {
  const priced = Array.isArray(snapshot.pricing?.parcels) ? snapshot.pricing.parcels : [];
  const raw = priced.find((parcel) => Number(parcel.sequence) === Number(sequence))?.chargeableWeightKg
    ?? priced[index]?.chargeableWeightKg;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(3)) : fallbackKg;
}

export type ShipmentManifestChargeableSource = {
  _id?: unknown;
  shipmentDraftId?: unknown;
  currentShipmentSnapshot?: unknown;
  bookingSnapshot?: unknown;
};

function hasChargeableWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Supplies parcel chargeable weights for manifests sealed before those values
 * were copied into the manifest snapshot. The returned lines are new objects;
 * this never mutates or persists the historical manifest.
 */
export function hydrateMissingManifestParcelChargeableWeights(
  lines: ShipmentManifestLineSnapshot[],
  sources: ShipmentManifestChargeableSource[]
) {
  const sourceById = new Map<string, ShipmentManifestChargeableSource>();
  const sourceByDraftId = new Map<string, ShipmentManifestChargeableSource>();
  sources.forEach((source) => {
    if (source._id) sourceById.set(String(source._id), source);
    if (source.shipmentDraftId) sourceByDraftId.set(String(source.shipmentDraftId), source);
  });

  return lines.map((line) => {
    const parcels = Array.isArray(line.parcels) ? line.parcels : [];
    if (!parcels.length || parcels.every((parcel) => hasChargeableWeight(parcel.chargeableWeightKg))) {
      return line;
    }

    const source = sourceById.get(String(line.dpdShipmentId))
      ?? sourceByDraftId.get(String(line.shipmentDraftId));
    const snapshot = source
      ? readShipmentBookingSnapshot(source.currentShipmentSnapshot)
        ?? readShipmentBookingSnapshot(source.bookingSnapshot)
      : null;
    if (!snapshot) return line;

    const indexByAwb = new Map(
      snapshot.parcels.map((parcel, index) => [String(parcel.swiftlineParcelNumber), index])
    );
    const hydratedParcels = parcels.map((parcel, index) => {
      if (hasChargeableWeight(parcel.chargeableWeightKg)) return parcel;

      const matchedIndex = indexByAwb.get(String(parcel.awbNumber)) ?? index;
      const matched = snapshot.parcels[matchedIndex];
      return {
        ...parcel,
        chargeableWeightKg: manifestParcelChargeableWeightKg(
          snapshot,
          matched?.sequence,
          matchedIndex,
          parcel.weightKg
        )
      };
    });

    return { ...line, parcels: hydratedParcels };
  });
}

export function buildManifestLine(input: ManifestLineInput): ShipmentManifestLineSnapshot {
  const descriptions = [...new Set(input.snapshot.parcels
    .map((parcel) => text(parcel.contentsDescription))
    .filter(Boolean))];
  const weightKg = Number(input.snapshot.parcels.reduce((total, parcel) => total + parcel.actualWeightKg, 0).toFixed(3));

  return {
    shipmentDraftId: input.shipmentDraftId,
    dpdShipmentId: input.dpdShipmentId,
    consignmentNumber: input.snapshot.tracking.swiftlineTrackingNumber,
    pieces: input.snapshot.parcels.length,
    weightKg,
    chargeableWeightKg: manifestChargeableWeightKg(input.snapshot, weightKg),
    consignor: { formatted: formatConsignor(input.snapshot), party: consignorPartySnapshot(input.snapshot) },
    consignee: { formatted: formatPersonAddress(input.snapshot.consignee, true), party: consigneePartySnapshot(input.snapshot.consignee) },
    description: descriptions.join(", ") || "Shipment contents",
    declaredValueMinor: input.declaredValueMinor,
    currency: "INR",
    bagNumber: input.bagNumber,
    serviceInfo: input.snapshot.service.type === "CARGO" ? "CARGO" : "EXP"
  };
}

/** The person named on the shipment, falling back to their company when unnamed. */
function partyPersonName(party: ManifestPartySnapshot) {
  return party.contactName || party.companyName;
}

/**
 * A manifest line for the client handover document: the same core fields as
 * `buildManifestLine` plus the discrete columns that document needs. Shipper and
 * receiver are the two contact names captured on the shipment, and every physical
 * parcel keeps its own barcode, forwarding number, weight and product so the
 * document can give each parcel its own row.
 */
export function buildHandoverManifestLine(input: ManifestLineInput & { remark?: string }): ShipmentManifestLineSnapshot {
  const line = buildManifestLine(input);
  const parties = buildManifestParties(input.snapshot);
  const parcels = input.snapshot.parcels.map((parcel, index) => ({
    awbNumber: text(parcel.swiftlineParcelNumber),
    forwardingNumber: text(parcel.carrierParcelNumber),
    weightKg: parcel.actualWeightKg,
    chargeableWeightKg: manifestParcelChargeableWeightKg(input.snapshot, parcel.sequence, index, parcel.actualWeightKg),
    product: text(parcel.shipmentContentType)
  }));

  return {
    ...line,
    awbNumbers: parcels.map((parcel) => parcel.awbNumber).filter(Boolean),
    forwardingNumbers: parcels.map((parcel) => parcel.forwardingNumber).filter(Boolean),
    destination: parties.consignee.countryName || parties.consignee.countryCode,
    shipperName: partyPersonName(parties.consignor),
    receiverName: partyPersonName(parties.consignee),
    product: [...new Set(parcels.map((parcel) => parcel.product).filter(Boolean))].join(", "),
    remark: text(input.remark),
    service: text(input.snapshot.service.type).toUpperCase(),
    parcels
  };
}

export async function allocateShipmentManifestNumber(session?: mongoose.ClientSession) {
  const counter = await ShipmentManifestCounter.findOneAndUpdate(
    { _id: "shipment-manifest" },
    { $inc: { sequence: 1 } },
    { upsert: true, returnDocument: "after", session }
  ).exec();
  if (!counter) throw new ShipmentManifestServiceError("Manifest number could not be allocated.", 500);
  return `SLC-${String(counter.sequence).padStart(3, "0")}`;
}

export function serializeShipmentManifest(manifest: IShipmentManifest) {
  const header = manifest.headerSnapshot as Record<string, unknown>;
  return {
    id: String(manifest._id),
    manifestNumber: manifest.manifestNumber,
    businessAccountId: String(manifest.businessAccountId),
    branchId: String(manifest.branchId),
    shipmentDraftIds: manifest.shipmentDraftIds.map(String),
    destinationAgent: text(header.destinationAgent),
    flightNumber: text(header.flightNumber),
    departureDate: text(header.departureDate),
    mawbNumber: text(header.mawbNumber),
    originIataCode: text(header.originIataCode),
    destinationIataCode: text(header.destinationIataCode),
    businessAccountName: text(header.businessAccountName),
    origin: text(header.origin),
    destination: text(header.destination),
    coloader: text(header.coloader),
    paymentType: text(header.paymentType),
    totalPieces: manifest.totalPieces,
    totalWeightKg: manifest.totalWeightKg,
    totalBags: manifest.totalBags,
    shipmentCount: manifest.lineSnapshots.length,
    actorRole: manifest.actorRole,
    generatedAt: manifest.generatedAt
  };
}

const manifestColours = {
  border: "FF222222",
  text: "FF111111",
  labelFill: "FFF2F2F2",
  white: "FFFFFFFF"
};

const manifestBorder: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: manifestColours.border } },
  left: { style: "thin", color: { argb: manifestColours.border } },
  bottom: { style: "thin", color: { argb: manifestColours.border } },
  right: { style: "thin", color: { argb: manifestColours.border } }
};

// ExcelJS enables wrapping but does not calculate the row height that Excel
// needs to display the wrapped value. Keep these widths in sync with the
// worksheet columns so long first-row descriptions get enough vertical space.
const manifestColumnWidths = [7, 25, 9, 13, 13, 44, 44, 32, 14, 11, 14, 14];

function wrappedManifestLineCount(value: unknown, width: number) {
  return String(value ?? "").split(/\r?\n/).reduce<number>((total, line) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return total + 1;

    let lines = 1;
    let currentLength = 0;
    for (const word of words) {
      if (word.length > width) {
        lines += Math.ceil(word.length / width) - (currentLength ? 0 : 1);
        currentLength = word.length % width;
        continue;
      }
      if (currentLength && currentLength + word.length + 1 > width) {
        lines += 1;
        currentLength = word.length;
      } else {
        currentLength += (currentLength ? 1 : 0) + word.length;
      }
    }
    return total + lines;
  }, 0);
}

function manifestBodyRowHeight(values: unknown[], minimum: number, columnWidths = manifestColumnWidths) {
  const wrappedLines = values.reduce<number>(
    (tallest, value, index) => Math.max(
      tallest,
      wrappedManifestLineCount(value, columnWidths[index] ?? 10),
    ),
    1,
  );
  // 18 points matches the existing address-row rhythm, with a small amount of
  // breathing room so the last wrapped line is not clipped by Excel.
  return Math.max(minimum, wrappedLines * 18 + 4);
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function formatManifestDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

function styleRange(
  worksheet: ExcelJS.Worksheet,
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
  style: {
    font?: Partial<ExcelJS.Font>;
    fill?: ExcelJS.Fill;
    alignment?: Partial<ExcelJS.Alignment>;
    border?: Partial<ExcelJS.Borders>;
    numberFormat?: string;
  }
) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      const cell = worksheet.getCell(row, column);
      if (style.font) cell.font = style.font;
      if (style.fill) cell.fill = style.fill;
      if (style.alignment) cell.alignment = style.alignment;
      if (style.border) cell.border = style.border;
      if (style.numberFormat) cell.numFmt = style.numberFormat;
    }
  }
}

function splitManifestLines(value: unknown, maximum = 8) {
  return text(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, maximum);
}

function spreadManifestAddress(value: unknown) {
  const lines = splitManifestLines(value, 10);
  const phone = lines.find((line) => line.toUpperCase().startsWith("TEL-"));
  const address = lines.filter((line) => line !== phone);
  const spread = [...address.slice(0, 3), "", ...address.slice(3)];
  if (phone) spread.push("", phone);
  // Pad to the fixed ten-row block so legacy (party-less) lines align with the rest.
  while (spread.length < 10) spread.push("");
  return spread.slice(0, 10);
}

/**
 * The fixed ten-row consignor/consignee block: contact name first (no company),
 * then address, then a blank, the phone (consignee only), and a trailing blank
 * tenth row. Absent fields still take their row so every block lines up.
 */
export function fixedPartyAddressRows(party: ManifestPartySnapshot, includePhone: boolean): string[] {
  const phone = includePhone && party.phone ? `TEL-${party.phone}` : "";
  return [
    party.contactName,
    party.addressLine1,
    party.addressLine2,
    party.city,
    party.state,
    party.postcode,
    party.countryCode,
    "",
    phone,
    ""
  ];
}

function manifestPartyOf(value: unknown): ManifestPartySnapshot | null {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return source.party && typeof source.party === "object" ? source.party as ManifestPartySnapshot : null;
}

/**
 * The courier-manifest workbook. Shipment manifests themselves download as the
 * handover PDF (see `shipmentManifestPdf.service`); this builder remains because
 * the operations manifest reuses it for its own Excel export.
 */
export async function buildShipmentManifestWorkbook(
  manifest: IShipmentManifest,
  options: { includeChargeableWeight?: boolean } = {}
): Promise<Buffer> {
  const includeChargeableWeight = options.includeChargeableWeight ?? true;
  const columnWidths = includeChargeableWeight
    ? manifestColumnWidths
    : [7, 25, 9, 13, 44, 44, 32, 14, 11, 14, 14];
  const totalColumns = includeChargeableWeight ? 12 : 11;
  const fromColumn = includeChargeableWeight ? 6 : 5;
  const toColumn = fromColumn + 1;
  const detailsLabelColumn = toColumn + 1;
  const detailsValueColumn = detailsLabelColumn + 1;
  const lastColumnLetter = includeChargeableWeight ? "L" : "K";
  const header = manifest.headerSnapshot as Record<string, unknown>;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Swiftline Portal";
  workbook.company = "Swiftline Cargo and Express Logistics";
  workbook.subject = `Courier manifest ${manifest.manifestNumber}`;
  workbook.created = manifest.generatedAt;

  const worksheet = workbook.addWorksheet("Manifest", {
    views: [{ state: "normal", showGridLines: false, zoomScale: 85 }],
    pageSetup: {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 }
    },
    properties: { defaultRowHeight: 20 }
  });

  worksheet.columns = [
    { key: "serial", width: 7 },
    { key: "consignment", width: 25 },
    { key: "pieces", width: 9 },
    { key: "weight", width: 13 },
    ...(includeChargeableWeight ? [{ key: "chargeable", width: 13 }] : []),
    // Wide enough that a long address line stays on its own row instead of wrapping.
    { key: "consignor", width: 44 },
    { key: "consignee", width: 44 },
    { key: "description", width: 32 },
    { key: "value", width: 14 },
    { key: "currency", width: 11 },
    { key: "bag", width: 14 },
    { key: "service", width: 14 }
  ];

  worksheet.mergeCells(`A2:${lastColumnLetter}2`);
  worksheet.getCell("A2").value = "Courier Manifest";
  worksheet.getRow(1).height = 10;
  worksheet.getRow(2).height = 24;
  styleRange(worksheet, 2, 1, 2, totalColumns, {
    font: { bold: true, size: 14, color: { argb: manifestColours.text } },
    fill: solidFill(manifestColours.white),
    alignment: { horizontal: "center", vertical: "middle" },
    border: manifestBorder
  });

  styleRange(worksheet, 3, 1, 12, totalColumns, {
    font: { size: 10, color: { argb: manifestColours.text } },
    fill: solidFill(manifestColours.white),
    alignment: { vertical: "middle", horizontal: "left", wrapText: true },
    border: manifestBorder
  });
  for (let row = 3; row <= 12; row += 1) worksheet.getRow(row).height = 19;

  worksheet.getCell(3, fromColumn).value = "FROM *";
  worksheet.getCell(3, toColumn).value = "TO *";
  const originLines = splitManifestLines(header.originAddress || header.originBranch).map((line) => line.toUpperCase());
  const destinationLines = splitManifestLines(header.destinationAgent);
  originLines.forEach((line, index) => { worksheet.getCell(4 + index, fromColumn).value = line; });
  destinationLines.forEach((line, index) => { worksheet.getCell(4 + index, toColumn).value = line; });

  const manifestDetails: Array<[string, string | number]> = [
    ["Manifest Number", manifest.manifestNumber],
    ["FLIGHT NUMBER", text(header.flightNumber)],
    ["FLIGHT DEPARTURE DATE", formatManifestDate(text(header.departureDate))],
    ["MAWB NO. *", text(header.mawbNumber)],
    ["MAWB ORIGIN (IATA Code) *", text(header.originIataCode)],
    ["MAWB DESTINATION (IATA Code) *", text(header.destinationIataCode)],
    ["TOTAL BAGS *", manifest.totalBags],
    ["TOTAL WEIGHT (kg) *", manifest.totalWeightKg],
    ["VALUE TYPE (HV, LV, TS, Docs)", text(header.valueType)]
  ];
  manifestDetails.forEach(([label, value], index) => {
    const row = 3 + index;
    const labelCell = worksheet.getCell(row, detailsLabelColumn);
    const valueCell = worksheet.getCell(row, detailsValueColumn);
    labelCell.value = label;
    valueCell.value = value;
    labelCell.font = { bold: true, size: 10, color: { argb: manifestColours.text } };
    labelCell.fill = solidFill(manifestColours.labelFill);
    valueCell.font = { bold: true, size: 10, color: { argb: manifestColours.text } };
  });
  for (let row = 3; row <= 12; row += 1) {
    const wrappedLineCount = Math.max(
      1,
      Math.ceil(text(worksheet.getCell(row, fromColumn).value).length / 30),
      Math.ceil(text(worksheet.getCell(row, toColumn).value).length / 34),
      Math.ceil(text(worksheet.getCell(row, detailsLabelColumn).value).length / 30),
      Math.ceil(text(worksheet.getCell(row, detailsValueColumn).value).length / 16)
    );
    worksheet.getRow(row).height = Math.max(20, Math.min(48, wrappedLineCount * 15));
  }
  worksheet.getCell(3, fromColumn).font = { bold: true, size: 10, color: { argb: manifestColours.text } };
  worksheet.getCell(3, toColumn).font = { bold: true, size: 10, color: { argb: manifestColours.text } };
  if (originLines.length) worksheet.getCell(4, fromColumn).font = { bold: true, size: 10, color: { argb: manifestColours.text } };
  if (destinationLines.length) worksheet.getCell(4, toColumn).font = { bold: true, size: 10, color: { argb: manifestColours.text } };
  worksheet.getCell(10, detailsValueColumn).numFmt = "0.000";

  worksheet.getRow(13).height = 10;

  const headings = [
    "S.No *", "Consignment No. *", "Pieces *", "Weight (kg)",
    ...(includeChargeableWeight ? ["Chargeable Weight (kg)"] : []),
    "Consignor *", "Consignee *", "Description *", "Value *", "Currency *", "Bag No *", "Service Info"
  ];
  const headingRow = worksheet.getRow(14);
  headingRow.values = headings;
  headingRow.height = 32;
  styleRange(worksheet, 14, 1, 14, totalColumns, {
    font: { bold: true, size: 10, color: { argb: manifestColours.text } },
    fill: solidFill(manifestColours.white),
    alignment: { horizontal: "center", vertical: "middle", wrapText: true },
    border: manifestBorder
  });

  manifest.lineSnapshots.forEach((line, index) => {
    // Prefer the structured party: a fixed ten-row block (no company name, and the
    // phone on the consignee only). Legacy party-less lines fall back to the text block.
    const consignorParty = manifestPartyOf(line.consignor);
    const consigneeParty = manifestPartyOf(line.consignee);
    const consignorLines = consignorParty ? fixedPartyAddressRows(consignorParty, false) : spreadManifestAddress(line.consignor.formatted);
    const consigneeLines = consigneeParty ? fixedPartyAddressRows(consigneeParty, true) : spreadManifestAddress(line.consignee.formatted);
    // Ten rows, the last one blank, so every consignor/consignee block is identical.
    const blockSize = Math.max(consignorLines.length, consigneeLines.length);
    const firstRowNumber = worksheet.rowCount + 1;
    // A parcel row carries its own value only when it opens a consignment.
    const declaredValue = typeof line.declaredValueMinor === "number" ? line.declaredValueMinor / 100 : "";

    for (let offset = 0; offset < blockSize; offset += 1) {
      const row = worksheet.addRow([]);
      if (offset === 0) {
        const values: Array<string | number> = [
          index + 1,
          formatManifestConsignmentNumber(line.consignmentNumber),
          line.pieces,
          line.weightKg,
          ...(includeChargeableWeight
            ? [typeof line.chargeableWeightKg === "number" ? line.chargeableWeightKg : line.weightKg]
            : []),
          consignorLines[0] ?? "",
          consigneeLines[0] ?? "",
          line.description,
          declaredValue,
          line.currency,
          line.bagNumber,
          line.serviceInfo
        ];
        row.values = values;
        row.height = manifestBodyRowHeight(values, 26, columnWidths);
      } else {
        row.getCell(fromColumn).value = consignorLines[offset] ?? "";
        row.getCell(toColumn).value = consigneeLines[offset] ?? "";
        row.height = 18;
      }

      for (let column = 1; column <= totalColumns; column += 1) {
        const cell = row.getCell(column);
        cell.font = { size: 10, color: { argb: manifestColours.text } };
        cell.fill = solidFill(manifestColours.white);
        cell.border = {
          top: { style: offset === 0 ? "medium" : "thin", color: { argb: manifestColours.border } },
          left: { style: "thin", color: { argb: manifestColours.border } },
          bottom: { style: offset === blockSize - 1 ? "medium" : "thin", color: { argb: manifestColours.border } },
          right: { style: "thin", color: { argb: manifestColours.border } }
        };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      }
    }

    worksheet.getCell(firstRowNumber, 2).font = { bold: true, size: 10, color: { argb: manifestColours.text } };
    worksheet.getCell(firstRowNumber, 4).numFmt = "0.000";
    if (includeChargeableWeight) worksheet.getCell(firstRowNumber, 5).numFmt = "0.000";
    if (typeof declaredValue === "number") worksheet.getCell(firstRowNumber, includeChargeableWeight ? 9 : 8).numFmt = "#,##0.00";
  });

  const lastRow = Math.max(14, worksheet.rowCount);
  worksheet.pageSetup.printArea = `A1:${lastColumnLetter}${lastRow}`;
  worksheet.headerFooter.oddFooter = "Swiftline Portal | Computer Generated Manifest | Page &P of &N";

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
