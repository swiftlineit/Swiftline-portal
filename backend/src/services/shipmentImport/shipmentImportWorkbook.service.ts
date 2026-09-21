import ExcelJS from "exceljs";
import {
  contentTypeOptions,
  destinationCountryOptions,
  serviceTypeOptions,
  shipmentImportFields,
  shipmentImportSheetNames,
  shipmentImportLimits,
  shipmentImportTemplateVersion,
  shipmentTypeOptions,
  unitTypeOptions
} from "./shipmentImportContract.js";

const colours = {
  navy: "FF0D1282",
  white: "FFFFFFFF",
  paleBlue: "FFEFF6FF",
  paleGrey: "FFF8FAFC",
  border: "FFCBD5E1",
  text: "FF0F172A",
  muted: "FF64748B"
};

function border(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: colours.border } };
  return { top: side, left: side, bottom: side, right: side };
}

function title(sheet: ExcelJS.Worksheet, value: string, lastColumn: number) {
  sheet.mergeCells(1, 1, 1, lastColumn);
  const cell = sheet.getCell(1, 1);
  cell.value = value;
  cell.font = { name: "Calibri", size: 15, bold: true, color: { argb: colours.white } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colours.navy } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 30;
}

function header(row: ExcelJS.Row) {
  row.height = 27;
  row.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: colours.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colours.navy } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = border();
  });
}

function styleBody(sheet: ExcelJS.Worksheet, fromRow: number, toRow: number, toColumn: number) {
  for (let row = fromRow; row <= toRow; row += 1) {
    sheet.getRow(row).height = 24;
    for (let column = 1; column <= toColumn; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.font = { name: "Calibri", size: 10, color: { argb: colours.text }, bold: column === 1 };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = border();
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: column === 1 ? colours.paleGrey : colours.white }
      };
    }
  }
}

function listFormula(column: string, count: number) {
  return `'${shipmentImportSheetNames.lists}'!$${column}$2:$${column}$${count + 1}`;
}

function listValidation(formula: string, prompt: string): ExcelJS.DataValidation {
  return {
    type: "list",
    allowBlank: false,
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: "Choose a listed value",
    error: "This field only accepts a value from its dropdown list.",
    showInputMessage: true,
    promptTitle: "Accepted values",
    prompt,
    formulae: [formula]
  };
}

async function addInstructions(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet(shipmentImportSheetNames.instructions, { views: [{ state: "frozen", ySplit: 2 }] });
  sheet.columns = [{ width: 28 }, { width: 92 }];
  title(sheet, "Swiftline Shipment Import - Instructions", 2);
  header(sheet.addRow(["Topic", "Instructions"]));
  const rows = [
    ["Purpose", "This workbook only prefills an editable shipment draft. It does not book, charge, allocate an AWB, contact a carrier or generate a tax invoice."],
    ["Shipment", "Replace every EXAMPLE value and every CHOOSE ONE value on the Shipment sheet. Do not rename fields or worksheets."],
    ["Shipment Type", "Accepted values: CSB-IV or CSB-V. CSB-V has additional customs-document and clearance-charge requirements."],
    ["Service Type", "Accepted values: Courier or Cargo."],
    ["Content Type", `Accepted values: ${contentTypeOptions.map((option) => option.label).join(", ")}.`],
    ["Unit Type", `Accepted values: ${unitTypeOptions.join(", ")}.`],
    ["Add a parcel", `Go to Parcels and insert or type into the next table row. Use sequential parcel numbers: 1, 2, 3... Maximum ${shipmentImportLimits.parcelsPerShipment} parcels.`],
    ["Add an item", `Go to Items and insert or type into the next table row. Enter the Parcel No. that owns the item. Maximum ${shipmentImportLimits.itemsPerParcel} items per parcel.`],
    ["Amounts", "Calculated Amount is Quantity x Unit Rate. The portal recalculates it and never trusts a workbook formula."],
    ["Repeated shipments", "The same completed workbook may be uploaded again to create another editable draft."],
    ["Before booking", "Review the imported draft, validate the delivery address, upload KYC documents and confirm pricing in the portal."]
  ];
  rows.forEach((values) => sheet.addRow(values));
  styleBody(sheet, 3, sheet.rowCount, 2);
  sheet.getColumn(1).font = { name: "Calibri", size: 10, bold: true, color: { argb: colours.navy } };
  await sheet.protect("swiftline-template", { selectLockedCells: true, selectUnlockedCells: true });
}

function addLists(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet(shipmentImportSheetNames.lists, { state: "veryHidden" });
  const lists = [
    ["Shipment Type", ...shipmentTypeOptions],
    ["Service Type", ...serviceTypeOptions],
    ["Content Type", ...contentTypeOptions.map((option) => option.label)],
    ["Unit Type", ...unitTypeOptions],
    ["Destination Country", ...destinationCountryOptions]
  ];
  lists.forEach((values, index) => {
    values.forEach((value, row) => {
      sheet.getCell(row + 1, index + 1).value = value;
    });
  });
}

async function addShipmentSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet(shipmentImportSheetNames.shipment, { views: [{ state: "frozen", ySplit: 2 }] });
  sheet.columns = [{ width: 52 }, { width: 64 }];
  title(sheet, "Shipment Details - Edit Value Column Only", 2);
  header(sheet.addRow(["Field", "Value"]));

  for (const field of shipmentImportFields) {
    const row = sheet.addRow([`${field.label}${field.required ? " *" : ""}`, field.placeholder]);
    const value = row.getCell(2);
    const locked = "locked" in field && field.locked === true;
    value.protection = { locked };
    value.font = {
      name: "Calibri",
      size: 10,
      italic: field.placeholder === "CHOOSE ONE" || field.placeholder.startsWith("EXAMPLE:"),
      color: { argb: locked ? colours.muted : colours.text }
    };
    if (field.key === "shipmentType") {
      value.dataValidation = listValidation(listFormula("A", shipmentTypeOptions.length), "Choose CSB-IV or CSB-V.");
    } else if (field.key === "serviceType") {
      value.dataValidation = listValidation(listFormula("B", serviceTypeOptions.length), "Choose Courier or Cargo.");
    } else if (field.key === "destinationCountry") {
      value.dataValidation = listValidation(listFormula("E", destinationCountryOptions.length), "Choose a destination country.");
    }
    if (["consignorMobileNumber", "pickupPinCode", "consigneeMobile", "deliveryPostcode"].includes(field.key)) {
      value.numFmt = "@";
    }
  }
  styleBody(sheet, 3, sheet.rowCount, 2);
  sheet.autoFilter = "A2:B2";
  await sheet.protect("swiftline-template", { selectLockedCells: true, selectUnlockedCells: true, autoFilter: true });
}

function addParcelsSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet(shipmentImportSheetNames.parcels, { views: [{ state: "frozen", ySplit: 2 }] });
  sheet.columns = [
    { width: 13 }, { width: 19 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 68 }, { width: 30 }
  ];
  title(sheet, "Parcels - Add One Row Per Parcel", 7);
  const headings = [
    "Parcel No. *", "Actual Weight KG *", "Length CM *", "Width CM *", "Height CM *",
    `Content Type * - Choose: ${contentTypeOptions.map((option) => option.label).join(", ")}`,
    "Reference *"
  ];
  header(sheet.addRow(headings));
  const parcelRowCount = shipmentImportLimits.parcelsPerShipment;
  const parcelLastRow = parcelRowCount + 2;
  for (let row = 3; row <= parcelLastRow; row += 1) {
    sheet.addRow(row === 3 ? [1, "", "", "", "", "CHOOSE ONE", ""] : ["", "", "", "", "", "", ""]);
  }
  styleBody(sheet, 3, parcelLastRow, 7);
  for (let row = 3; row <= parcelLastRow; row += 1) {
    sheet.getCell(row, 6).dataValidation = listValidation(listFormula("C", contentTypeOptions.length), contentTypeOptions.map((option) => option.label).join(", "));
    for (const column of [1, 2, 3, 4, 5]) sheet.getCell(row, column).numFmt = "0.00";
    sheet.getCell(row, 7).numFmt = "@";
  }
  sheet.addTable({
    name: "ShipmentParcels",
    ref: "A2",
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: headings.map((name) => ({ name })),
    rows: Array.from({ length: parcelRowCount }, (_, index) => (
      index === 0 ? [1, "", "", "", "", "CHOOSE ONE", ""] : ["", "", "", "", "", "", ""]
    ))
  });
  sheet.autoFilter = undefined;
}

function addItemsSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet(shipmentImportSheetNames.items, { views: [{ state: "frozen", ySplit: 2 }] });
  sheet.columns = [{ width: 13 }, { width: 36 }, { width: 17 }, { width: 47 }, { width: 14 }, { width: 17 }, { width: 20 }];
  title(sheet, "Items - Add One Row Per Item and Select Its Parcel No.", 7);
  const headings = [
    "Parcel No. *", "Description *", "HS Code *",
    `Unit Type * - Choose: ${unitTypeOptions.join(", ")}`,
    "Quantity *", "Unit Rate *", "Calculated Amount"
  ];
  header(sheet.addRow(headings));
  const itemRowCount = shipmentImportLimits.itemsPerParcel;
  const itemLastRow = itemRowCount + 2;
  const rows = Array.from({ length: itemRowCount }, (_, index) => index === 0
    ? [1, "", "", "CHOOSE ONE", "", "", { formula: "E3*F3", result: 0 }]
    : ["", "", "", "", "", "", { formula: `E${index + 3}*F${index + 3}`, result: 0 }]);
  rows.forEach((values) => sheet.addRow(values));
  styleBody(sheet, 3, itemLastRow, 7);
  for (let row = 3; row <= itemLastRow; row += 1) {
    sheet.getCell(row, 4).dataValidation = listValidation(listFormula("D", unitTypeOptions.length), unitTypeOptions.join(", "));
    sheet.getCell(row, 3).numFmt = "@";
    sheet.getCell(row, 5).numFmt = "0.00";
    sheet.getCell(row, 6).numFmt = "0.00";
    sheet.getCell(row, 7).numFmt = "0.00";
    sheet.getCell(row, 7).protection = { locked: true };
    sheet.getCell(row, 7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: colours.paleBlue } };
  }
  sheet.addTable({ name: "ShipmentItems", ref: "A2", headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true }, columns: headings.map((name) => ({ name })), rows });
}

export async function buildShipmentImportTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Swiftline Portal";
  workbook.subject = "Editable shipment import template";
  workbook.created = new Date();
  await addInstructions(workbook);
  await addShipmentSheet(workbook);
  addParcelsSheet(workbook);
  addItemsSheet(workbook);
  addLists(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
