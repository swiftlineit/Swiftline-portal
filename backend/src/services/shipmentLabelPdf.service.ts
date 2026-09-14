import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import bwipjs from "bwip-js";

const POINTS_PER_MM = 72 / 25.4;
const points = (millimetres: number) => millimetres * POINTS_PER_MM;

// A compact square label with enough room for the existing routing content.
// The single-label page adds a 5 mm printer-safe inset around it; an A4 sheet
// uses a larger inset and a gutter between labels.
const LABEL_EDGE = points(90);
const SINGLE_PAGE_EDGE = points(100);
const SINGLE_PAGE_INSET = points(5);
const A4_WIDTH = points(210);
const A4_HEIGHT = points(297);
const SHEET_GUTTER = points(16);
const LABELS_PER_SHEET = 2;

const CONTENT_LEFT = 0.75;
const CONTENT_RIGHT = LABEL_EDGE - 0.75;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const CELL_PADDING = 6;
const TEXT_LEFT = CONTENT_LEFT + CELL_PADDING;
const TEXT_WIDTH = CONTENT_WIDTH - CELL_PADDING * 2;

// Each section finishes exactly where the next begins, so the square has no
// unused band while the barcode remains the dominant element.
const ROW_HEADER = CONTENT_LEFT;
const ROW_BARCODE = 34;
const ROW_GRID = 116;
const ROW_GRID_MID = 148;
const ROW_CONSIGNEE = 180;
const LABEL_BOTTOM = CONTENT_RIGHT;

const GRID_COL_MID = CONTENT_LEFT + CONTENT_WIDTH * 0.50;
const DETAILS_COL = GRID_COL_MID;
const INK = "#000000";
const DIVIDER_INK = "#6B7280";

/** Printed on every label regardless of the booked service. */
const SERVICE_NAME = "EXPRESS WORLDWIDE";
const COMPANY_NAME = "SWIFTLINE CARGO";

export interface ShipmentLabelData {
  parcelNumber: string;
  parcelIndex: number;
  parcelCount: number;
  weightKg: number;
  generatedAt: Date;
  /** The lodging station the shipment starts from. */
  origin: {
    stationCode: string;
    city: string;
  };
  /** Where the shipment is going, as the route line prints it. */
  destination: {
    city: string;
    countryCode: string;
    countryName: string;
  };
  consignee: {
    name: string;
    contactName?: string;
    addressLines: string[];
    postcode: string;
    countryCode: string;
    countryName: string;
    email?: string;
  };
}

function collectPdf(
  render: (document: PDFKit.PDFDocument) => void,
  size: [number, number]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size,
      margin: 0,
      info: { Creator: "Swiftline Portal", Producer: "Swiftline Portal" }
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    render(document);
    document.end();
  });
}

/** Pixel dimensions from a PNG's IHDR, so a fitted image's drawn height is known. */
function pngSize(buffer: Buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function barcode(value: string) {
  return bwipjs.toBuffer({
    bcid: "code128",
    text: value,
    // `scale` is raster resolution, not printed size. The PDF downsamples this
    // image so the bars remain sharp on office and thermal printers.
    scale: 8,
    height: 14,
    includetext: false,
    backgroundcolor: "FFFFFF",
    barcolor: "000000",
    paddingwidth: 0,
    paddingheight: 0
  });
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** The pre-cropped SLC mark used by the existing label. */
const logoPath = path.resolve(process.cwd(), "assets", "swiftline-label-logo.png");

/** Largest size at or below `start` that fits `value` on one line. */
function fitOneLine(
  document: PDFKit.PDFDocument,
  value: string,
  width: number,
  start: number,
  minimum: number
) {
  let size = start;
  while (size > minimum && document.fontSize(size).widthOfString(value) > width) {
    size -= 0.5;
  }
  return size;
}

function caption(document: PDFKit.PDFDocument, value: string, x: number, y: number, width: number) {
  document
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(5.5)
    .text(value, x, y, { width, characterSpacing: 0.7, lineBreak: false });
}

function rule(document: PDFKit.PDFDocument, y: number, lineWidth = 0.7, right = CONTENT_RIGHT) {
  document.moveTo(CONTENT_LEFT, y).lineTo(right, y).lineWidth(lineWidth).stroke(DIVIDER_INK);
}

function fitBlock(
  document: PDFKit.PDFDocument,
  value: string,
  width: number,
  maxHeight: number,
  start: number,
  minimum: number
) {
  let size = start;
  while (size > minimum && document.fontSize(size).heightOfString(value, { width }) > maxHeight) {
    size -= 0.5;
  }
  return size;
}

const CELL_VALUE_HEIGHT = 17;

function cell(
  document: PDFKit.PDFDocument,
  input: { label: string; value: string; left: number; width: number; top: number; wrap?: boolean }
) {
  caption(document, input.label, input.left, input.top, input.width);
  document.fillColor(INK).font("Helvetica-Bold");
  const size = input.wrap
    ? fitBlock(document, input.value, input.width, CELL_VALUE_HEIGHT, 12, 6)
    : fitOneLine(document, input.value, input.width, 12, 7);
  document
    .fontSize(size)
    .text(input.value, input.left, input.top + 10, {
      width: input.width,
      lineBreak: Boolean(input.wrap),
      ...(input.wrap ? { height: CELL_VALUE_HEIGHT, ellipsis: true } : {})
    });
}

/** Draws one complete square label at the supplied page position. */
function drawSwiftlineLabel(
  document: PDFKit.PDFDocument,
  data: ShipmentLabelData,
  barcodeImage: Buffer,
  left: number,
  top: number
) {
  document.save().translate(left, top);

  document
    .rect(CONTENT_LEFT, CONTENT_LEFT, CONTENT_WIDTH, LABEL_BOTTOM - CONTENT_LEFT)
    .lineWidth(1.2)
    .stroke(INK);

  if (fs.existsSync(logoPath)) {
    document.image(logoPath, TEXT_LEFT, ROW_HEADER + 7, { fit: [48, 19] });
  }
  const companyLeft = TEXT_LEFT + 55;
  const companyWidth = CONTENT_RIGHT - CELL_PADDING - companyLeft;
  document
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(fitOneLine(document, COMPANY_NAME, companyWidth, 12, 7))
    .text(COMPANY_NAME, companyLeft, ROW_HEADER + 12, {
      width: companyWidth,
      align: "right",
      lineBreak: false
    });
  rule(document, ROW_BARCODE, 0.9);

  const barcodeTop = ROW_BARCODE + 7;
  const barcodeBox = ROW_GRID - barcodeTop - 24;
  const source = pngSize(barcodeImage);
  // Keep the bars broad while preserving a real quiet zone between Code 128
  // and the label's outer border so handheld scanners do not read the border.
  const barcodeLeft = CONTENT_LEFT + 9;
  const barcodeWidth = CONTENT_WIDTH - 18;
  const barcodeHeight = Math.min(barcodeBox, (barcodeWidth * source.height) / source.width);
  document.image(barcodeImage, barcodeLeft, barcodeTop, {
    fit: [barcodeWidth, barcodeBox],
    align: "center"
  });
  document
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(fitOneLine(document, data.parcelNumber, TEXT_WIDTH, 14, 7))
    .text(data.parcelNumber, TEXT_LEFT, barcodeTop + barcodeHeight + 9, {
      width: TEXT_WIDTH,
      align: "center",
      lineBreak: false
    });
  rule(document, ROW_GRID, 0.9);

  rule(document, ROW_GRID_MID);
  document
    .moveTo(GRID_COL_MID, ROW_GRID)
    .lineTo(GRID_COL_MID, ROW_CONSIGNEE)
    .lineWidth(0.7)
    .stroke(DIVIDER_INK);

  const col1Width = GRID_COL_MID - CONTENT_LEFT - CELL_PADDING * 2;
  const col2Left = GRID_COL_MID + CELL_PADDING;
  const col2Width = CONTENT_RIGHT - GRID_COL_MID - CELL_PADDING * 2;
  const destination = [
    text(data.destination.city) || text(data.destination.countryName),
    text(data.destination.countryCode)
  ].filter(Boolean).join(", ").toUpperCase();
  const origin = (text(data.origin.stationCode) || text(data.origin.city) || "-").toUpperCase();

  cell(document, { label: "ORIGIN", value: origin, left: TEXT_LEFT, width: col1Width, top: ROW_GRID + 5 });
  cell(document, {
    label: "DESTINATION",
    value: destination || "-",
    left: col2Left,
    width: col2Width,
    top: ROW_GRID + 5,
    wrap: true
  });
  cell(document, {
    label: "PIECE",
    value: `${data.parcelIndex + 1} OF ${data.parcelCount}`,
    left: TEXT_LEFT,
    width: col1Width,
    top: ROW_GRID_MID + 5
  });
  cell(document, {
    label: "WEIGHT",
    value: `${data.weightKg.toFixed(2)} KG`,
    left: col2Left,
    width: col2Width,
    top: ROW_GRID_MID + 5
  });

  rule(document, ROW_CONSIGNEE, 0.9);

  document
    .moveTo(DETAILS_COL, ROW_CONSIGNEE)
    .lineTo(DETAILS_COL, LABEL_BOTTOM)
    .lineWidth(0.7)
    .stroke(DIVIDER_INK);
  const consigneeWidth = DETAILS_COL - CONTENT_LEFT - CELL_PADDING * 2;
  caption(document, "CONSIGNEE", TEXT_LEFT, ROW_CONSIGNEE + 6, consigneeWidth);
  const name = text(data.consignee.name) || text(data.consignee.contactName);
  document
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(fitOneLine(document, name, consigneeWidth, 9.5, 7))
    .text(name, TEXT_LEFT, ROW_CONSIGNEE + 15, {
      width: consigneeWidth,
      height: 18,
      ellipsis: true
    });

  const addressLines = [...new Set(data.consignee.addressLines.map(text).filter(Boolean))];
  document
    .font("Helvetica")
    .fontSize(7.5)
    .text(addressLines.join("\n"), TEXT_LEFT, ROW_CONSIGNEE + 29, {
      width: consigneeWidth,
      height: 30,
      ellipsis: true,
      lineGap: 0
    });

  const postcode = [text(data.consignee.postcode), text(data.consignee.countryCode)]
    .filter(Boolean)
    .join("  ");
  document
    .font("Helvetica-Bold")
    .fontSize(fitOneLine(document, postcode, consigneeWidth, 12, 8))
    .text(postcode, TEXT_LEFT, LABEL_BOTTOM - 20, { width: consigneeWidth, lineBreak: false });

  const serviceLeft = DETAILS_COL + CELL_PADDING;
  const serviceWidth = CONTENT_RIGHT - CELL_PADDING - serviceLeft;
  const serviceWords = SERVICE_NAME.split(" ");
  const serviceSize = Math.min(
    ...serviceWords.map((word) => fitOneLine(document.font("Helvetica-Bold"), word, serviceWidth, 11, 6))
  );
  const serviceTop = (ROW_CONSIGNEE + LABEL_BOTTOM) / 2
    - (8 + serviceWords.length * (serviceSize + 1)) / 2;
  caption(document, "SERVICE", serviceLeft, serviceTop, serviceWidth);
  serviceWords.forEach((word, index) => {
    document
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(serviceSize)
      .text(word, serviceLeft, serviceTop + 10 + index * (serviceSize + 1), {
        width: serviceWidth,
        lineBreak: false
      });
  });

  document.restore();
}

/** One square label on a printer-safe square page. */
export async function renderSwiftlineLabelPdf(data: ShipmentLabelData) {
  const barcodeImage = await barcode(data.parcelNumber);
  return collectPdf((document) => {
    drawSwiftlineLabel(document, data, barcodeImage, SINGLE_PAGE_INSET, SINGLE_PAGE_INSET);
  }, [SINGLE_PAGE_EDGE, SINGLE_PAGE_EDGE]);
}

/**
 * One printable shipment document, laid out two centred square labels per A4
 * page. Every label remains complete and inside the page's safe print area.
 */
export async function renderSwiftlineLabelSetPdf(data: readonly ShipmentLabelData[]) {
  if (!data.length) throw new Error("At least one Swiftline label is required.");
  if (data.length === 1) return renderSwiftlineLabelPdf(data[0] as ShipmentLabelData);

  const barcodeImages = await Promise.all(data.map((label) => barcode(label.parcelNumber)));
  return collectPdf((document) => {
    data.forEach((label, index) => {
      const pageIndex = Math.floor(index / LABELS_PER_SHEET);
      const slotIndex = index % LABELS_PER_SHEET;
      if (pageIndex > 0 && slotIndex === 0) {
        document.addPage({ size: [A4_WIDTH, A4_HEIGHT], margin: 0 });
      }
      const pageStart = pageIndex * LABELS_PER_SHEET;
      const labelsOnPage = Math.min(LABELS_PER_SHEET, data.length - pageStart);
      const gridHeight = labelsOnPage * LABEL_EDGE + Math.max(0, labelsOnPage - 1) * SHEET_GUTTER;
      drawSwiftlineLabel(
        document,
        label,
        barcodeImages[index] as Buffer,
        (A4_WIDTH - LABEL_EDGE) / 2,
        (A4_HEIGHT - gridHeight) / 2 + slotIndex * (LABEL_EDGE + SHEET_GUTTER)
      );
    });
  }, [A4_WIDTH, A4_HEIGHT]);
}
