import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { ICashReceipt } from "../models/cashReceipt.model.js";
import { amountMinorToWords } from "./taxInvoice.service.js";

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
  const ink = "#183153";
  const muted = "#71839D";
  const blue = "#246BB8";
  const panel = "#F0F4FA";
  const pageWidth = 432;
  const contentX = 28;
  const contentWidth = 376;
  const customerName = receipt.customerNameSnapshot || receipt.accountIdSnapshot || "Business account";
  const receiptDate = receipt.receiptDate ?? receipt.issuedAt ?? receipt.updatedAt ?? receipt.createdAt;
  const rows: Array<[string, string]> = [
    ["Payment reference", receipt.cashCustodyReference || "-"],
    ["Recorded by", receipt.cashRecordedByNameSnapshot || receipt.createdByNameSnapshot || "Swiftline Staff"],
    ["Date", formatIstDate(receiptDate)]
  ];
  const valueX = 180;
  const valueWidth = 208;
  const measureDocument = new PDFDocument({ size: [pageWidth, 1000], margin: 0 });
  const measureHeight = (value: string, font: string, fontSize: number, width: number) => {
    measureDocument.font(font).fontSize(fontSize);
    return Math.max(fontSize + 3, measureDocument.heightOfString(value, { width, lineGap: 1 }));
  };
  const customerHeight = measureHeight(customerName, "Helvetica-Bold", 11, valueWidth);
  const amountInWords = amountMinorToWords(receipt.totalReceivedMinor, receipt.currency || "INR");
  const amountWordsHeight = measureHeight(amountInWords, "Helvetica", 8, valueWidth);
  const rowLayouts = rows.map(([label, value]) => ({
    label,
    value,
    height: measureHeight(value, "Helvetica-Bold", 10, valueWidth)
  }));
  const panelY = 94;
  const customerY = panelY + 11;
  const amountRowY = customerY + customerHeight + 8;
  const panelHeight = amountRowY - panelY + 20 + amountWordsHeight + 10;
  const shipmentDetails = [
    receipt.serviceSnapshot ? ["SHIPMENT", receipt.serviceSnapshot === "COURIER" ? "Courier" : receipt.serviceSnapshot === "CARGO" ? "Cargo" : receipt.serviceSnapshot] : null,
    receipt.piecesSnapshot != null ? ["PIECES", `${receipt.piecesSnapshot} ${receipt.piecesSnapshot === 1 ? "pc" : "pcs"}`] : null,
    receipt.weightKgSnapshot != null ? ["WEIGHT", `${receipt.weightKgSnapshot.toFixed(2)} kg`] : null
  ].filter((item): item is [string, string] => item !== null);
  const metricY = panelY + panelHeight + 12;
  const metricHeight = 46;
  const detailsStartY = shipmentDetails.length ? metricY + metricHeight + 12 : panelY + panelHeight + 18;
  let detailsBottomY = detailsStartY;
  for (const row of rowLayouts) detailsBottomY += row.height + 9;
  const signatureY = detailsBottomY + 2;
  const perforationY = signatureY + 25;
  const footerTextY = perforationY + 12;
  const pageHeight = Math.ceil(footerTextY + 25);
  measureDocument.end();

  const document = new PDFDocument({
    size: [pageWidth, pageHeight],
    margin: 0,
    info: { Title: `${receipt.status === "DRAFT" ? "Draft " : ""}Cash Receipt ${receipt.receiptNumber}` }
  });
  const logoPath = path.resolve(process.cwd(), "assets", "swiftline-invoice-logo.png");
  document.rect(0, 0, pageWidth, pageHeight).fill("#FFFFFF");
  if (fs.existsSync(logoPath)) document.image(logoPath, 38, 20, { fit: [96, 54] });

  document.fillColor(blue).font("Helvetica-Bold").fontSize(9)
    .text("CASH RECEIPT", 216, 32, { width: 180, align: "right", characterSpacing: 1.2 });
  document.fillColor(ink).font("Helvetica-Bold").fontSize(11)
    .text(receipt.receiptNumber, 216, 50, { width: 180, align: "right" });

  document.roundedRect(contentX, panelY, contentWidth, panelHeight, 4).fill(panel);
  document.fillColor(muted).font("Helvetica-Bold").fontSize(8).text("RECEIVED FROM :", 44, customerY + 2, { width: 126, characterSpacing: 0.6 });
  document.fillColor(ink).font("Helvetica-Bold").fontSize(11)
    .text(customerName, valueX, customerY, { width: valueWidth, align: "right", lineGap: 1 });
  document.fillColor(muted).font("Helvetica-Bold").fontSize(8).text("AMOUNT RECEIVED :", 44, amountRowY + 2, { width: 130, characterSpacing: 0.6 });
  document.fillColor(blue).font("Helvetica-Bold").fontSize(15)
    .text(money(receipt.totalReceivedMinor), valueX, amountRowY - 2, { width: valueWidth, align: "right" });
  document.fillColor(ink).font("Helvetica").fontSize(8)
    .text(amountInWords, valueX, amountRowY + 19, { width: valueWidth, align: "right", lineGap: 1 });

  const metricGap = 8;
  const metricWidth = shipmentDetails.length
    ? (contentWidth - metricGap * (shipmentDetails.length - 1)) / shipmentDetails.length
    : 0;
  shipmentDetails.forEach(([label, value], index) => {
    const x = contentX + index * (metricWidth + metricGap);
    document.roundedRect(x, metricY, metricWidth, metricHeight, 3).fill(panel);
    document.fillColor(muted).font("Helvetica-Bold").fontSize(7.5)
      .text(label, x + 5, metricY + 9, { width: metricWidth - 10, align: "center", characterSpacing: 0.5 });
    document.fillColor(ink).font("Helvetica-Bold").fontSize(11)
      .text(value, x + 5, metricY + 25, { width: metricWidth - 10, align: "center", ellipsis: true });
  });

  let rowY = detailsStartY;
  rowLayouts.forEach(({ label, value, height }) => {
    document.fillColor(muted).font("Helvetica").fontSize(9).text(label, 44, rowY, { width: 96 });
    document.save().dash(1, { space: 2 }).moveTo(145, rowY + 7).lineTo(173, rowY + 7).lineWidth(0.7).strokeColor("#BFCBDD").stroke().restore();
    document.fillColor(ink).font("Helvetica-Bold").fontSize(10)
      .text(value, valueX, rowY, { width: valueWidth, align: "right", lineGap: 1 });
    rowY += height + 9;
  });

  document.moveTo(252, signatureY).lineTo(388, signatureY).lineWidth(0.8).strokeColor("#52677F").stroke();
  document.save().dash(2, { space: 3 }).moveTo(21, perforationY).lineTo(pageWidth - 21, perforationY).lineWidth(0.8).strokeColor("#BDCADB").stroke().restore();
  document.circle(0, perforationY, 8).fill("#E5EAF1");
  document.circle(pageWidth, perforationY, 8).fill("#E5EAF1");
  document.fillColor(muted).font("Helvetica").fontSize(8).text("System generated receipt", contentX, footerTextY, { width: contentWidth, align: "center", characterSpacing: 0.3 });

  if (receipt.status === "DRAFT") {
    document.save();
    document.rotate(-18, { origin: [pageWidth / 2, signatureY - 20] });
    document.fillColor("#71839D").opacity(0.22).font("Helvetica-Bold").fontSize(25)
      .text("DRAFT - NOT POSTED", 40, signatureY - 33, { width: 352, align: "center" });
    document.restore().opacity(1);
  }

  return finish(document);
}
