import PDFDocument from "pdfkit";
import type { IShipmentManifest, ShipmentManifestLineSnapshot } from "../models/shipmentManifest.model.js";
import { formatManifestConsignmentNumber, type ManifestPartySnapshot } from "./shipmentManifest.service.js";
import {
  shipmentManifestConsignorAadhaarForRow,
  type ShipmentManifestConsignorAadhaarByDraft
} from "./shipmentManifestConsignorAadhaar.service.js";
import { formatSwiftlineParcelNumberForDisplay } from "./swiftlineTracking.service.js";

const border = "#222222";
const ink = "#111111";
const muted = "#f2f2f2";

/** Sr, AWB/Parcel, consignor, consignee, pieces, description, weights and remark. */
const columnWidths = [22, 70, 58, 96, 42, 60, 58, 96, 42, 24, 86, 38, 42, 59];
export const shipmentManifestTableHeadings = [
  "Sr.\nNo.",
  "AWB No. /\nParcel No",
  "Consignor Name",
  "Consignor Full\nAddress",
  "Consignor Contact\nNumber",
  "Consignor Aadhaar\nNumber",
  "Consignee Name",
  "Consignee Full\nAddress",
  "Consignee Contact\nNumber",
  "Pcs",
  "Description",
  "Weight",
  "Chg Wt",
  "Remark"
];

export type ShipmentManifestSection = {
  key: string;
  label: string;
  lines: ShipmentManifestLineSnapshot[];
};

const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0);

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function partyOf(value: unknown): ManifestPartySnapshot | null {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return source.party && typeof source.party === "object" ? source.party as ManifestPartySnapshot : null;
}

function partyName(value: unknown) {
  const party = partyOf(value);
  if (party) return party.companyName || party.contactName;
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return text(source.formatted).split(/\r?\n/)[0] ?? "";
}

function uniqueValues(values: unknown[]) {
  const seen = new Set<string>();
  return values.map(text).filter((value) => {
    if (!value) return false;
    const key = value.replace(/\s+/g, " ").toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function partyDocumentFields(value: unknown, fallbackName: unknown) {
  const party = partyOf(value);
  if (party) {
    const name = uniqueValues([party.companyName, party.contactName, fallbackName]);
    const address = uniqueValues([
      party.addressLine1,
      party.addressLine2,
      party.city,
      party.state,
      party.postcode,
      party.countryName || party.countryCode
    ]);
    if (name.length || address.length || text(party.phone)) {
      return { name: name.join("\n"), address: address.join("\n"), phone: text(party.phone) };
    }
  }

  // Older snapshots only have the same newline-joined block used by the old
  // manifest documents. Strip its explicit TEL marker and use any separately
  // captured shipper/receiver name to split the fields without live lookups.
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const formattedLines = text(source.formatted).split(/\r?\n/).map(text).filter(Boolean);
  const phoneLine = formattedLines.find((line) => /^TEL-/i.test(line)) ?? "";
  const remainingLines = formattedLines.filter((line) => !/^TEL-/i.test(line));
  const name = uniqueValues([fallbackName, remainingLines[0]]);
  const nameValues = new Set(name.map((item) => item.replace(/\s+/g, " ").toUpperCase()));
  const address = remainingLines.filter((line) => !nameValues.has(line.replace(/\s+/g, " ").toUpperCase()));
  return { name: name.join("\n"), address: address.join("\n"), phone: phoneLine.replace(/^TEL-/i, "") };
}

/** Limits only the PDF display; the shared rows and Excel keep the full text. */
export function clampManifestPdfDescription(value: string, wordLimit = 10) {
  const words = text(value).split(/\s+/).filter(Boolean);
  if (words.length <= wordLimit) return words.join(" ");
  return `${words.slice(0, wordLimit).join(" ")}…`;
}

function manifestDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  }).format(value);
}

/**
 * One row per physical parcel, each carrying its own barcode, weight and
 * description. Lines sealed before per-parcel data existed keep a
 * single summary row so historical manifests still render every column.
 * Chargeable weight falls back to the actual weight on legacy lines. A line
 * sealed before per-parcel chargeable weights were captured states its shipment
 * total only on its first parcel row (like goods value elsewhere), never
 * repeated as if every parcel weighed that much.
 */
export function manifestRows(
  lines: ShipmentManifestLineSnapshot[],
  startIndex = 0,
  aadhaarByDraft: ShipmentManifestConsignorAadhaarByDraft = new Map()
) {
  return lines.flatMap((line) => {
    const consignor = partyDocumentFields(line.consignor, line.shipperName);
    const consignee = partyDocumentFields(line.consignee, line.receiverName);
    const shared = {
      consignorName: consignor.name || partyName(line.consignor),
      consignorAddress: consignor.address,
      consignorPhone: consignor.phone,
      consigneeName: consignee.name || partyName(line.consignee),
      consigneeAddress: consignee.address,
      consigneePhone: consignee.phone,
      remark: line.remark || "DONE"
    };
    const lineChargeableKg = typeof line.chargeableWeightKg === "number" ? line.chargeableWeightKg : line.weightKg;
    const hasParcelDescriptions = Boolean(line.parcels?.some((parcel) => text(parcel.description)));

    if (line.parcels?.length) {
      return line.parcels.map((parcel, parcelIndex) => [
        formatSwiftlineParcelNumberForDisplay(parcel.awbNumber || formatManifestConsignmentNumber(line.consignmentNumber), line.consignmentNumber),
        shared.consignorName,
        shared.consignorAddress,
        shared.consignorPhone,
        shipmentManifestConsignorAadhaarForRow(line, aadhaarByDraft, parcel.awbNumber),
        shared.consigneeName,
        shared.consigneeAddress,
        shared.consigneePhone,
        "1",
        text(parcel.description) || (!hasParcelDescriptions && parcelIndex === 0 ? line.description : ""),
        parcel.weightKg.toFixed(2),
        typeof parcel.chargeableWeightKg === "number"
          ? parcel.chargeableWeightKg.toFixed(2)
          : (parcelIndex === 0 ? lineChargeableKg.toFixed(2) : ""),
        shared.remark
      ]);
    }

    return [[
      line.awbNumbers?.map((value) => formatSwiftlineParcelNumberForDisplay(value, line.consignmentNumber)).join(", ") || formatManifestConsignmentNumber(line.consignmentNumber),
      shared.consignorName,
      shared.consignorAddress,
      shared.consignorPhone,
      shipmentManifestConsignorAadhaarForRow(line, aadhaarByDraft),
      shared.consigneeName,
      shared.consigneeAddress,
      shared.consigneePhone,
      String(line.pieces),
      line.description,
      line.weightKg.toFixed(2),
      lineChargeableKg.toFixed(2),
      shared.remark
    ]];
  }).map((values, index) => [String(startIndex + index + 1), ...values]);
}

export function shipmentManifestSections(manifest: IShipmentManifest): ShipmentManifestSection[] {
  if (manifest.manifestType !== "COMBINED") return [];
  const sectionByKey = new Map<string, ShipmentManifestSection>();
  for (const line of manifest.lineSnapshots) {
    const key = line.sectionKey || `shipment:${String(line.shipmentDraftId)}`;
    const section = sectionByKey.get(key);
    if (section) {
      section.lines.push(line);
    } else {
      sectionByKey.set(key, {
        key,
        label: line.sectionLabel || "Business Account",
        lines: [line]
      });
    }
  }
  return [...sectionByKey.values()];
}

export function shipmentManifestDeclaration(manifest: IShipmentManifest) {
  const header = manifest.headerSnapshot as Record<string, unknown>;
  const accountName = manifest.manifestType === "COMBINED"
    ? "Swiftline Cargo and Express Logistics"
    : text(header.businessAccountName) || "the carrier";
  const awbCount = manifest.lineSnapshots.length;
  return `We hereby declare that we are tendering ${manifest.totalPieces} parcels and ${awbCount} `
    + `${awbCount === 1 ? "airwaybill" : "airwaybills"} to ${text(header.destination).toUpperCase() || "the receiving agent"} `
    + "for delivery to the final consignees. We confirm that the parcels have been picked up from known shippers "
    + "whose integrity we do not doubt. All parcels have been checked by us and they do not contain any substances "
    + "banned or controlled by any Government agencies, or endanger the safety and security of the aircraft or its "
    + "passengers. We hereby indemnify and keep indemnified "
    + `${accountName} and all its employees against any untoward incidents, `
    + "fines or penalties or legal action that may arise as a result of any mis-declaration or our action.";
}

export function buildShipmentManifestPdf(
  manifest: IShipmentManifest,
  aadhaarByDraft: ShipmentManifestConsignorAadhaarByDraft = new Map()
): Promise<Buffer> {
  const header = manifest.headerSnapshot as Record<string, unknown>;

  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 24, bufferPages: true });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    const left = document.page.margins.left;
    const bottomLimit = document.page.height - document.page.margins.bottom;
    // Content stops short of the margin to leave the per-page stamp its own strip.
    const contentLimit = bottomLimit - 16;

    function columnX(column: number) {
      return left + columnWidths.slice(0, column).reduce((sum, width) => sum + width, 0);
    }

    function drawCell(
      column: number,
      y: number,
      height: number,
      value: string,
      options?: { bold?: boolean; size?: number; align?: "left" | "center"; fill?: string }
    ) {
      const x = columnX(column);
      const width = columnWidths[column] ?? 0;
      if (options?.fill) document.rect(x, y, width, height).fill(options.fill);
      document.rect(x, y, width, height).lineWidth(0.5).stroke(border);
      document.font(options?.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(options?.size ?? 6.5)
        .fillColor(ink)
        .text(value, x + 2, y + 3, {
          width: width - 4,
          height: height - 4,
          align: options?.align ?? "center",
          lineGap: 0.5,
          ellipsis: true
        });
    }

    /** The wrapped height a row needs so no column is clipped. */
    function rowHeight(values: string[], size: number) {
      const tallest = values.reduce((height, value, column) => {
        document.font("Helvetica").fontSize(size);
        const measured = document.heightOfString(value || " ", {
          width: (columnWidths[column] ?? 0) - 4,
          lineGap: 0.5
        });
        return Math.max(height, measured);
      }, 0);
      return Math.max(18, tallest + 6);
    }

    function drawTableHeadings(y: number) {
      shipmentManifestTableHeadings.forEach((heading, column) => drawCell(column, y, 32, heading, {
        bold: true,
        size: 5.8,
        fill: muted
      }));
      return y + 32;
    }

    function drawSectionHeading(label: string, y: number) {
      document.rect(left, y, tableWidth, 20).fill(muted);
      document.rect(left, y, tableWidth, 20).lineWidth(0.5).stroke(border);
      document.font("Helvetica-Bold").fontSize(8).fillColor(ink)
        .text(label, left + 5, y + 5, { width: tableWidth - 10, lineBreak: false, ellipsis: true });
      return y + 20;
    }

    // Title
    let y = document.page.margins.top;
    document.rect(left, y, tableWidth, 30).lineWidth(0.5).stroke(border);
    document.font("Helvetica-Bold").fontSize(18).fillColor(ink)
      .text("MANIFEST", left, y + 7, { width: tableWidth, align: "center" });
    y += 30;

    // Header block: three columns inside one bordered box.
    const headerHeight = 104;
    const thirdWidth = tableWidth / 3;
    document.rect(left, y, tableWidth, headerHeight).lineWidth(0.5).stroke(border);

    function headerLine(column: number, row: number, label: string, value = "") {
      document.font("Helvetica-Bold").fontSize(8).fillColor(ink).text(
        value ? `${label} ${value}` : label,
        left + column * thirdWidth + 8,
        y + 8 + row * 13,
        { width: thirdWidth - 16, lineBreak: false, ellipsis: true }
      );
    }

    headerLine(0, 0, "FROM,");
    headerLine(0, 1, text(header.origin).toUpperCase() || "-");
    headerLine(1, 0, "TO,");
    headerLine(1, 1, text(header.destination).toUpperCase() || "-");
    headerLine(2, 0, "DATE:", manifestDate(manifest.generatedAt));
    headerLine(2, 1, "TOTAL PCS :", String(manifest.totalPieces));
    headerLine(2, 2, "TOTAL WEIGHT:", manifest.totalWeightKg.toFixed(2));
    headerLine(2, 4, "MANIFEST #:", manifest.manifestNumber);
    headerLine(2, 5, "COLOADER:", text(header.coloader));
    headerLine(2, 6, "PAYMENT TYPE:", text(header.paymentType));
    y += headerHeight;

    // Table
    y = drawTableHeadings(y);
    const sections = shipmentManifestSections(manifest);
    const rowsBySection = sections.length
      ? sections
      : [{ key: "manifest", label: "", lines: manifest.lineSnapshots }];
    let rowIndex = 0;
    rowsBySection.forEach((section, sectionIndex) => {
      const rows = manifestRows(section.lines, rowIndex, aadhaarByDraft).map((row) => row.map((value, column) =>
        column === 10 ? clampManifestPdfDescription(value) : value
      ));
      rowIndex += rows.length;
      const firstRowHeight = rows.length ? rowHeight(rows[0]!, 5.8) : 0;
      const sectionGap = sections.length && sectionIndex > 0 ? 18 : 0;
      const headingHeight = sections.length ? 20 : 0;
      if (sections.length && y + sectionGap + headingHeight + firstRowHeight > contentLimit) {
        document.addPage();
        y = drawTableHeadings(document.page.margins.top);
      } else {
        y += sectionGap;
      }
      if (sections.length) y = drawSectionHeading(section.label, y);
      rows.forEach((values) => {
        const height = rowHeight(values, 5.8);
        if (y + height > contentLimit) {
          document.addPage();
          y = drawTableHeadings(document.page.margins.top);
        }
        values.forEach((value, column) => drawCell(column, y, height, value, {
          size: 5.8,
          align: [2, 3, 4, 6, 7, 8, 10, 13].includes(column) ? "left" : "center"
        }));
        y += height;
      });
    });

    // Footer declaration and signatures, kept whole on one page.
    const footerHeight = 92;
    if (y + 14 + footerHeight > contentLimit) {
      document.addPage();
      y = document.page.margins.top;
    }
    y += 14;
    const declaration = shipmentManifestDeclaration(manifest);

    document.rect(left, y, tableWidth, footerHeight).lineWidth(0.5).stroke(border);
    document.font("Helvetica").fontSize(6.5).fillColor(ink)
      .text(declaration, left + 10, y + 9, { width: tableWidth - 20, align: "justify", lineGap: 1 });

    const signatureY = y + footerHeight - 24;
    const signatureWidth = tableWidth / 2 - 40;
    document.moveTo(left + 20, signatureY).lineTo(left + 20 + signatureWidth, signatureY).lineWidth(0.5).stroke(border);
    document.moveTo(left + tableWidth - 20 - signatureWidth, signatureY)
      .lineTo(left + tableWidth - 20, signatureY).lineWidth(0.5).stroke(border);
    document.font("Helvetica-Bold").fontSize(7).fillColor(ink)
      .text(`FOR ${text(header.origin).toUpperCase() || "ORIGIN"} (SIGN AND STAMP)`, left + 20, signatureY + 6, {
        width: signatureWidth,
        align: "center"
      })
      .text("(NAME)", left + tableWidth - 20 - signatureWidth, signatureY + 6, {
        width: signatureWidth,
        align: "center"
      });

    // The stamp must sit inside the bottom margin: text placed past it makes
    // pdfkit break to a new page, which would append a blank page per stamp.
    const range = document.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      document.switchToPage(index);
      document.font("Helvetica").fontSize(6).fillColor("#64748b").text(
        `Swiftline Portal | Manifest ${manifest.manifestNumber} | Page ${index + 1} of ${range.count}`,
        left,
        bottomLimit - 8,
        { width: tableWidth, align: "center", lineBreak: false }
      );
    }

    document.end();
  });
}
