import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { ICashReceipt } from "../models/cashReceipt.model.js";
import { amountMinorToWords } from "./taxInvoice.service.js";

const SWIFTLINE_LEGAL_NAME = "Swiftline Cargo and Express Logistics Pvt Ltd.";
const SWIFTLINE_GSTIN = "07ABPCS3159R1ZC";
const SWIFTLINE_PHONE = "+917027606600";

const NAVY = "#102a75";
const INK = "#0b1220";
const MUTED = "#374151";
const LIGHT_BLUE = "#dbe7ff";
const BORDER = "#9aa8c0";

function money(minor: number) {
  return `INR ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatIstDate(value: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(value);
}

function finish(document: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.end();
  });
}

export function renderCashReceiptPdf(receipt: ICashReceipt) {
  // Compact receipt: fixed width, height fits the content
  const pageWidth = 432;
  const contentX = 28;
  const contentWidth = pageWidth - contentX * 2;
  const contentRight = contentX + contentWidth;
  const headerX = 180;
  const headerWidth = contentRight - headerX;
  const detailValueX = contentX + 108;
  const detailValueWidth = contentRight - detailValueX;
  const amountX = contentX + 14;
  const amountWidth = contentWidth - 28;

  const customerName = receipt.customerNameSnapshot || receipt.accountIdSnapshot || "Business account";
  const address = receipt.addressSnapshot?.trim() || "";
  const businessMobileNumber = receipt.businessMobileNumberSnapshot?.trim() || "";
  const gstin = receipt.gstinSnapshot?.trim().toUpperCase() || "";
  const receiptDate = receipt.receiptDate ?? receipt.issuedAt ?? receipt.updatedAt ?? receipt.createdAt;

  const amountInWords = amountMinorToWords(receipt.totalReceivedMinor, receipt.currency || "INR");

  const measureDocument = new PDFDocument({ size: [pageWidth, 1000], margin: 0 });
  const measureHeight = (value: string, font: string, fontSize: number, width: number) => {
    measureDocument.font(font).fontSize(fontSize);
    return Math.max(fontSize + 3, measureDocument.heightOfString(value, { width, lineGap: 2 }));
  };
  const customerHeight = measureHeight(customerName, "Helvetica-Bold", 10, contentWidth);
  const addressHeight = address ? measureHeight(address, "Helvetica", 8.5, contentWidth) : 0;
  const mobileHeight = businessMobileNumber
    ? measureHeight(`Mobile: ${businessMobileNumber}`, "Helvetica", 8.5, contentWidth)
    : 0;
  const gstinHeight = gstin ? measureHeight(`GSTIN: ${gstin}`, "Helvetica", 8.5, contentWidth) : 0;

  const amountValue = money(receipt.totalReceivedMinor);
  const amountWordsHeight = measureHeight(amountInWords, "Helvetica", 8.5, amountWidth);

  const headerRuleY = 78;
  const fromY = headerRuleY + 17;
  const nameY = fromY + 14;
  const addressY = nameY + customerHeight + 3;
  const mobileY = address ? addressY + addressHeight + 3 : addressY;
  const gstinY = mobileY + (businessMobileNumber ? mobileHeight + 3 : 0);
  const fromBottom = gstin
    ? gstinY + gstinHeight
    : businessMobileNumber
      ? mobileY + mobileHeight
      : addressY + addressHeight;

  const amountY = fromBottom + 15;
  const amountLabelY = amountY + 12;
  const amountBigY = amountLabelY + 15;
  const amountWordsY = amountBigY + 22;
  const amountBottom = amountWordsY + amountWordsHeight + 9;

  const tableY = amountBottom + 14;
  const tableHeaderHeight = 23;
  const tableRowHeight = 25;
  const tableBottom = tableY + tableHeaderHeight + tableRowHeight;

  const detailsY = tableBottom + 16;
  const detailRows: Array<{ label: string; value: string; height: number }> = [
    { label: "Date", value: formatIstDate(receiptDate).toUpperCase() },
    { label: "Recorded by", value: receipt.cashRecordedByNameSnapshot || receipt.createdByNameSnapshot || "Swiftline Staff" },
    { label: "Payment reference", value: receipt.cashCustodyReference || "-" }
  ].map((row) => ({
    ...row,
    height: Math.max(19, measureHeight(row.value, "Helvetica-Bold", 9, detailValueWidth) + 8)
  }));
  let detailsBottomY = detailsY;
  for (const row of detailRows) detailsBottomY += row.height;

  const signatureRuleY = detailsBottomY + 34;
  const signatureTextY = signatureRuleY + 6;
  const signatureWidth = 120;
  const signatureX = contentRight - signatureWidth;

  const footerRuleY = signatureTextY + 28;
  const footerCompanyY = footerRuleY + 10;
  const footerPhoneY = footerCompanyY + 11;
  const footerNoteY = footerPhoneY + 11;
  const pageHeight = Math.ceil(footerNoteY + 28);

  measureDocument.end();

  const document = new PDFDocument({
    size: [pageWidth, pageHeight],
    margin: 0,
    info: { Title: `${receipt.status === "DRAFT" ? "Draft " : ""}Cash Receipt ${receipt.receiptNumber}` }
  });
  const logoPath = path.resolve(process.cwd(), "assets", "swiftline-invoice-logo.png");
  document.rect(0, 0, pageWidth, pageHeight).fill("#FFFFFF");

  // Logo (top left). The dashed box shows only when the logo file is missing.
  const logoBoxY = 28;
  const logoBoxWidth = 96;
  const logoBoxHeight = 36;
  if (fs.existsSync(logoPath)) {
    document.image(logoPath, contentX, logoBoxY, {
      fit: [logoBoxWidth, logoBoxHeight],
      valign: "center"
    });
  } else {
    document.rect(contentX, logoBoxY, logoBoxWidth, logoBoxHeight)
      .lineWidth(0.8).dash(3, { space: 2 }).strokeColor(MUTED).stroke().undash();
    document.fillColor(MUTED).font("Helvetica").fontSize(8)
      .text("Your logo", contentX, logoBoxY + logoBoxHeight / 2 - 4, { width: logoBoxWidth, align: "center" });
  }

  // Header right
  document.fillColor(NAVY).font("Helvetica-Bold").fontSize(15)
    .text("CASH RECEIPT", headerX, 32, { width: headerWidth, align: "right", characterSpacing: 1.1 });
  document.fillColor(INK).font("Helvetica").fontSize(9)
    .text(receipt.receiptNumber, headerX, 53, { width: headerWidth, align: "right" });

  // Header rule
  document.moveTo(contentX, headerRuleY).lineTo(contentRight, headerRuleY)
    .lineWidth(2.2).strokeColor(NAVY).stroke();

  // RECEIVED FROM block
  document.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.5).text("RECEIVED FROM", contentX, fromY, { characterSpacing: 0.7 });
  document.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(customerName, contentX, nameY, { width: contentWidth, lineGap: 2 });
  if (address) {
    document.fillColor(INK).font("Helvetica").fontSize(8.5).text(address, contentX, addressY, { width: contentWidth, lineGap: 2 });
  }
  if (businessMobileNumber) {
    document.fillColor(INK).font("Helvetica").fontSize(8.5)
      .text(`Mobile: ${businessMobileNumber}`, contentX, mobileY, { width: contentWidth, lineGap: 2 });
  }
  if (gstin) {
    document.fillColor(INK).font("Helvetica").fontSize(8.5).text(`GSTIN: ${gstin}`, contentX, gstinY, { width: contentWidth, lineGap: 2 });
  }

  // Amount received block (light blue, left aligned)
  document.roundedRect(contentX, amountY, contentWidth, amountBottom - amountY, 6).fill(LIGHT_BLUE);
  document.fillColor(NAVY).font("Helvetica-Bold").fontSize(7.5)
    .text("AMOUNT RECEIVED", amountX, amountLabelY, { characterSpacing: 0.7 });
  document.fillColor(NAVY).font("Helvetica-Bold").fontSize(15)
    .text(amountValue, amountX, amountBigY, { lineBreak: false });
  const amountValueWidth = document.widthOfString(amountValue);
  document.fontSize(10.5)
    .text("inc. GST", amountX + amountValueWidth + 5, amountBigY + 3.5, { lineBreak: false });
  document.fillColor(INK).font("Helvetica").fontSize(8.5)
    .text(amountInWords, amountX, amountWordsY, { width: amountWidth, lineGap: 2 });

  // Shipment summary table (centered columns, light blue header)
  const colWidth = contentWidth / 3;
  const col1X = contentX;
  const col2X = contentX + colWidth;
  const col3X = contentX + 2 * colWidth;
  const service = receipt.serviceSnapshot?.trim() || "-";
  const shipType = service === "COURIER" ? "Courier" : service === "CARGO" ? "Cargo" : service;
  const pieces = receipt.piecesSnapshot != null ? `${receipt.piecesSnapshot} PCS` : "-";
  const weight = receipt.weightKgSnapshot != null ? `${receipt.weightKgSnapshot.toFixed(2)} KG` : "-";

  // Fill the header first so the borders are drawn on top of it
  document.rect(contentX, tableY, contentWidth, tableHeaderHeight).fill(LIGHT_BLUE);
  document.lineWidth(0.8).strokeColor(BORDER);
  document.rect(contentX, tableY, contentWidth, tableHeaderHeight + tableRowHeight).stroke();
  document.moveTo(col2X, tableY).lineTo(col2X, tableBottom).stroke();
  document.moveTo(col3X, tableY).lineTo(col3X, tableBottom).stroke();
  document.moveTo(contentX, tableY + tableHeaderHeight).lineTo(contentRight, tableY + tableHeaderHeight).stroke();

  const headerCellY = tableY + tableHeaderHeight / 2 - 4;
  document.fillColor(NAVY).font("Helvetica-Bold").fontSize(7.5);
  for (const [label, x] of [["SHIPMENT", col1X], ["PIECES", col2X], ["WEIGHT", col3X]] as const) {
    document.text(label, x, headerCellY, { width: colWidth, align: "center", characterSpacing: 0.7 });
  }
  const dataCellY = tableY + tableHeaderHeight + tableRowHeight / 2 - 4.5;
  document.fillColor(INK).font("Helvetica-Bold").fontSize(9);
  for (const [value, x] of [[shipType, col1X], [pieces, col2X], [weight, col3X]] as const) {
    document.text(value, x, dataCellY, { width: colWidth, align: "center" });
  }

  // Details rows
  let rowY = detailsY;
  for (const row of detailRows) {
    document.font("Helvetica-Bold").fontSize(9);
    const labelWidth = document.widthOfString(row.label);
    const valueTextWidth = Math.min(document.widthOfString(row.value), detailValueWidth);
    const leaderStartX = contentX + labelWidth + 8;
    const leaderEndX = contentRight - valueTextWidth - 8;
    document.fillColor(MUTED).font("Helvetica-Bold").fontSize(9).text(row.label, contentX, rowY);
    if (leaderEndX > leaderStartX) {
      document.moveTo(leaderStartX, rowY + row.height / 2)
        .lineTo(leaderEndX, rowY + row.height / 2)
        .lineWidth(1.1).strokeColor("#858585").stroke();
    }
    document.fillColor(INK).font("Helvetica-Bold").fontSize(9)
      .text(row.value, detailValueX, rowY, { width: detailValueWidth, align: "right", lineGap: 2 });
    rowY += row.height;
  }

  // Authorised Signatory (right side)
  document.moveTo(signatureX, signatureRuleY).lineTo(contentRight, signatureRuleY).lineWidth(0.8).strokeColor(INK).stroke();
  document.fillColor(INK).font("Helvetica").fontSize(8.5)
    .text("Authorised Signatory", signatureX, signatureTextY, { width: signatureWidth, align: "center" });

  // Footer
  document.moveTo(contentX, footerRuleY).lineTo(contentRight, footerRuleY)
    .lineWidth(0.8).strokeColor(BORDER).stroke();
  document.fillColor(MUTED).font("Helvetica").fontSize(7.5)
    .text(`${SWIFTLINE_LEGAL_NAME}  |  GSTIN: ${SWIFTLINE_GSTIN}`, contentX, footerCompanyY, { width: contentWidth, align: "center" })
    .text(`Phone: ${SWIFTLINE_PHONE}`, contentX, footerPhoneY, { width: contentWidth, align: "center" })
    .text("System generated receipt", contentX, footerNoteY, { width: contentWidth, align: "center" });

  if (receipt.status === "DRAFT") {
    document.save();
    document.rotate(-18, { origin: [pageWidth / 2, signatureRuleY + 10] });
    document.fillColor(MUTED).opacity(0.22).font("Helvetica-Bold").fontSize(20)
      .text("DRAFT - NOT POSTED", contentX, signatureRuleY - 22, { width: contentWidth, align: "center" });
    document.restore().opacity(1);
  }

  return finish(document);
}
