import crypto from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import type { IOperationsManifest } from "../models/operationsManifest.model.js";
import { getGbpToInrRate } from "./flightProfitability.service.js";
import { buildManifestDocumentModel, parseSealedSnapshot } from "./manifestDocument.service.js";
import {
  OPERATIONS_BAG_MAX_WEIGHT_KG,
  OperationsManifestServiceError,
  UK_OPERATIONS_BAG_MAX_PIECES
} from "./operationsManifest.service.js";
import { fixedPartyAddressRows } from "./shipmentManifest.service.js";
import type { ManifestDocumentConsignment, ManifestDocumentParty } from "../types/manifestDocument.js";

const templatePath = path.resolve(process.cwd(), "assets", "cfl-uk-manifest-template.xlsx");
const firstEntryRow = 16;
const rowsPerEntry = 10;
const firstTemplateColumn = 2;
const lastTemplateColumn = 12;
const ukAutomaticEntryValueMaximumGbpMinor = 4_000;
const ukOverLimitDefaultValueGbpMinor = 3_800;
const ukDescriptionItemLimit = 4;
const ukDescriptionItemMaximumLength = 40;
const ukMaximumBagsPerEntry = 3;

type UkManifestBag = {
  sequence: number;
  bagNumber: string;
  pieces: number;
  weightGrams: number;
  declaredValueMinor?: number;
  descriptions?: string[];
};

export type UkManifestEntry = {
  serial: number;
  consignment: ManifestDocumentConsignment;
  bags: UkManifestBag[];
  pieces: number;
  weightKg: number;
  declaredValueMinor: number;
  descriptions: string[];
};

type UkManifestBuildOptions = {
  gbpToInr?: number;
};

function weightGrams(value: unknown) {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0) {
    throw new OperationsManifestServiceError("The sealed manifest contains an invalid parcel weight.", 409);
  }
  return Math.round(weight * 1000);
}

export function convertInrMinorToGbpMinor(inrMinor: number, gbpToInr: number) {
  if (!Number.isInteger(inrMinor) || inrMinor < 0) {
    throw new OperationsManifestServiceError("A selected consignment contains an invalid declared value.", 409);
  }
  if (!Number.isFinite(gbpToInr) || gbpToInr <= 0) {
    throw new OperationsManifestServiceError("The GBP/INR exchange rate is unavailable.", 503);
  }
  return Math.round(inrMinor / gbpToInr);
}

export function reconcileGbpMinorValues(inrMinorValues: number[], gbpToInr: number) {
  const exactValues = inrMinorValues.map((value) => {
    convertInrMinorToGbpMinor(value, gbpToInr);
    return value / gbpToInr;
  });
  const allocations = exactValues.map(Math.floor);
  const targetTotal = convertInrMinorToGbpMinor(
    inrMinorValues.reduce((sum, value) => sum + value, 0),
    gbpToInr
  );
  const order = exactValues
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  const remainder = targetTotal - allocations.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < remainder; index += 1) {
    allocations[order[index]!.index] = (allocations[order[index]!.index] ?? 0) + 1;
  }
  return allocations;
}

async function resolveGbpToInrRate(override?: number) {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) {
      throw new OperationsManifestServiceError("The GBP/INR exchange rate is unavailable.", 503);
    }
    return override;
  }
  try {
    return (await getGbpToInrRate()).gbpToInr;
  } catch (error) {
    throw new OperationsManifestServiceError(
      error instanceof Error ? error.message : "The GBP/INR exchange rate is unavailable.",
      503
    );
  }
}

export function ukManifestConfiguredEntryCount(totalBags: number) {
  if (!Number.isInteger(totalBags) || totalBags < 1) {
    throw new OperationsManifestServiceError("The UK manifest requires at least one bag.", 409);
  }
  if (totalBags < 10) return totalBags;
  if (totalBags <= 15) return 11;
  if (totalBags <= 19) return 13;
  if (totalBags <= 25) return 15;
  if (totalBags <= 35) return 18;
  if (totalBags <= 50) return 20;
  if (totalBags <= 65) return 26;
  if (totalBags <= 85) return 33;
  return 33 + Math.ceil((totalBags - 85) * 0.4);
}

/**
 * CFL's UK workbook intentionally carries two fewer rows than the configured
 * bag-band target. The final count is still capped by real consignments and
 * validated against the three-bag-per-entry capacity below.
 */
export function ukManifestTargetEntryCount(totalBags: number) {
  if (totalBags < 10) return totalBags;
  return Math.max(1, ukManifestConfiguredEntryCount(totalBags) - 2);
}

function deterministicConsignmentOrder(manifestNumber: string, consignments: ManifestDocumentConsignment[]) {
  return [...consignments].sort((left, right) => {
    const digest = (value: string) => crypto
      .createHash("sha256")
      .update(`${manifestNumber}|UK|${value}`)
      .digest("hex");
    return digest(left.consignmentNumber).localeCompare(digest(right.consignmentNumber));
  });
}

function uniqueConsignments(consignments: ManifestDocumentConsignment[]) {
  const seen = new Set<string>();
  return consignments.filter((consignment) => {
    const key = consignment.consignmentNumber.trim().toUpperCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function uniqueUkDescriptionItems(descriptions: string[]) {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const description of descriptions) {
    for (const item of description.split(/[,;\r\n]+/).map((value) => value.trim()).filter(Boolean)) {
      const key = item.toLocaleUpperCase("en-GB");
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items;
}

function conciseDescriptionItem(value: string) {
  if (value.length <= ukDescriptionItemMaximumLength) return value;
  const shortened = value.slice(0, ukDescriptionItemMaximumLength);
  const lastSpace = shortened.lastIndexOf(" ");
  return (lastSpace >= 12 ? shortened.slice(0, lastSpace) : shortened).trimEnd();
}

export function conciseUkDescriptionItems(descriptions: string[]) {
  const candidates = descriptions.map((description) => {
    const items = uniqueUkDescriptionItems([description]);
    const limit = items.length <= 3 ? items.length : items.length <= 5 ? 3 : 4;
    return items.slice(0, limit).map(conciseDescriptionItem);
  });
  const cursors = candidates.map(() => 0);
  const seen = new Set<string>();
  const selected: string[] = [];

  const takeNextUnique = (parcelIndex: number) => {
    const items = candidates[parcelIndex]!;
    while (cursors[parcelIndex]! < items.length) {
      const item = items[cursors[parcelIndex]!]!;
      cursors[parcelIndex] = cursors[parcelIndex]! + 1;
      const key = item.toLocaleUpperCase("en-GB");
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(item);
      return true;
    }
    return false;
  };

  for (let parcelIndex = 0; parcelIndex < candidates.length && selected.length < ukDescriptionItemLimit; parcelIndex += 1) {
    takeNextUnique(parcelIndex);
  }
  while (selected.length < ukDescriptionItemLimit) {
    let added = false;
    for (let parcelIndex = 0; parcelIndex < candidates.length && selected.length < ukDescriptionItemLimit; parcelIndex += 1) {
      added = takeNextUnique(parcelIndex) || added;
    }
    if (!added) break;
  }
  return selected;
}

function balancedBagGroups(bags: UkManifestBag[], entryCount: number) {
  const minimumSize = Math.floor(bags.length / entryCount);
  const extraBags = bags.length % entryCount;
  const groups: UkManifestBag[][] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const size = minimumSize + (index < extraBags ? 1 : 0);
    groups.push(bags.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

function bagGroupDeclaredValueMinor(bags: UkManifestBag[]) {
  return bags.reduce((sum, bag) => sum + (bag.declaredValueMinor ?? 0), 0);
}

function allocateBagGroups(bags: UkManifestBag[], entryCount: number, gbpToInr?: number) {
  const balanced = balancedBagGroups(bags, entryCount);
  if (balanced.some((group) => group.length > ukMaximumBagsPerEntry)) {
    throw new OperationsManifestServiceError(
      `The UK manifest needs more unique consignments to keep every entry within ${ukMaximumBagsPerEntry} bags.`,
      409
    );
  }
  if (gbpToInr === undefined || balanced.every((group) =>
    Math.floor(bagGroupDeclaredValueMinor(group) / gbpToInr) <= ukAutomaticEntryValueMaximumGbpMinor)) {
    return balanced;
  }

  const groups = Array.from({ length: entryCount }, () => [] as UkManifestBag[]);
  const groupCapacities = balanced.map((group) => group.length);
  const groupValues = Array.from({ length: entryCount }, () => 0);
  const orderedBags = [...bags].sort((left, right) =>
    (right.declaredValueMinor ?? 0) - (left.declaredValueMinor ?? 0)
    || left.sequence - right.sequence);
  for (const bag of orderedBags) {
    const bagValue = bag.declaredValueMinor ?? 0;
    const orderedGroups = groupValues
      .map((value, index) => ({ value, index }))
      .filter(({ index }) => groups[index]!.length < groupCapacities[index]!)
      .sort((left, right) => left.value - right.value || left.index - right.index);
    if (!orderedGroups.length) {
      throw new OperationsManifestServiceError("The UK manifest bags could not be allocated across its entries.", 409);
    }
    const groupIndex = (orderedGroups.find(({ value }) =>
      Math.floor((value + bagValue) / gbpToInr) <= ukAutomaticEntryValueMaximumGbpMinor)
      ?? orderedGroups[0])!.index;
    groups[groupIndex]!.push(bag);
    groupValues[groupIndex] = (groupValues[groupIndex] ?? 0) + bagValue;
  }
  if (groups.some((group) => !group.length)) {
    throw new OperationsManifestServiceError("The UK manifest bags could not be allocated across its entries.", 409);
  }
  return groups
    .map((group) => group.sort((left, right) => left.sequence - right.sequence))
    .sort((left, right) => left[0]!.sequence - right[0]!.sequence);
}

export function buildUkManifestEntries(input: {
  manifestNumber: string;
  totalBags: number;
  totalPhysicalParcels: number;
  totalWeightKg: number;
  bags: UkManifestBag[];
  consignments: ManifestDocumentConsignment[];
  gbpToInr?: number;
}) {
  if (input.bags.length !== input.totalBags) {
    throw new OperationsManifestServiceError("UK manifest bag totals do not match the sealed manifest.", 409);
  }

  const bagNumbers = new Set<string>();
  const bagSequences = new Set<number>();
  for (const bag of input.bags) {
    if (!bag.bagNumber || bagNumbers.has(bag.bagNumber)) {
      throw new OperationsManifestServiceError("Every UK manifest bag must be present exactly once.", 409);
    }
    bagNumbers.add(bag.bagNumber);
    if (!Number.isInteger(bag.sequence) || bag.sequence < 1 || bagSequences.has(bag.sequence)) {
      throw new OperationsManifestServiceError("Every UK manifest bag must have a unique sequence number.", 409);
    }
    bagSequences.add(bag.sequence);
    if (!Number.isInteger(bag.pieces)
      || bag.pieces < 1
      || bag.pieces > UK_OPERATIONS_BAG_MAX_PIECES) {
      throw new OperationsManifestServiceError(
        `${bag.bagNumber} must contain between 1 and ${UK_OPERATIONS_BAG_MAX_PIECES} parcels for the UK manifest.`,
        409
      );
    }
    if (!Number.isInteger(bag.weightGrams)
      || bag.weightGrams < 0
      || bag.weightGrams > OPERATIONS_BAG_MAX_WEIGHT_KG * 1000) {
      throw new OperationsManifestServiceError(
        `${bag.bagNumber} exceeds the ${OPERATIONS_BAG_MAX_WEIGHT_KG} kg bag limit.`,
        409
      );
    }
  }

  const totalPieces = input.bags.reduce((sum, bag) => sum + bag.pieces, 0);
  const totalWeightGrams = input.bags.reduce((sum, bag) => sum + bag.weightGrams, 0);
  if (totalPieces !== input.totalPhysicalParcels) {
    throw new OperationsManifestServiceError("UK manifest piece totals do not match the sealed manifest.", 409);
  }
  if (totalWeightGrams !== weightGrams(input.totalWeightKg)) {
    throw new OperationsManifestServiceError("UK manifest weight totals do not match the sealed manifest.", 409);
  }

  const candidates = deterministicConsignmentOrder(
    input.manifestNumber,
    uniqueConsignments(input.consignments)
  );
  const entryCount = Math.min(
    ukManifestTargetEntryCount(input.totalBags),
    candidates.length,
    input.bags.length
  );
  if (!entryCount) {
    throw new OperationsManifestServiceError("The UK manifest has no unique real consignments to display.", 409);
  }
  if (entryCount < Math.ceil(input.bags.length / ukMaximumBagsPerEntry)) {
    throw new OperationsManifestServiceError(
      `The UK manifest needs at least ${Math.ceil(input.bags.length / ukMaximumBagsPerEntry)} unique real consignments to represent ${input.bags.length} bags without exceeding ${ukMaximumBagsPerEntry} bags per entry.`,
      409
    );
  }

  return allocateBagGroups(input.bags, entryCount, input.gbpToInr).map<UkManifestEntry>((bags, index) => ({
    serial: index + 1,
    consignment: candidates[index]!,
    bags,
    pieces: bags.reduce((sum, bag) => sum + bag.pieces, 0),
    weightKg: bags.reduce((sum, bag) => sum + bag.weightGrams, 0) / 1000,
    declaredValueMinor: bags.reduce((sum, bag) => sum + (bag.declaredValueMinor ?? 0), 0),
    descriptions: conciseUkDescriptionItems(bags.flatMap((bag) => bag.descriptions ?? []))
  }));
}

function fallbackAddressRows(value: string, includePhone: boolean) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const phoneIndex = lines.findIndex((line) => line.toUpperCase().startsWith("TEL-"));
  const phone = phoneIndex >= 0 ? lines.splice(phoneIndex, 1)[0] ?? "" : "";
  const rows = [...lines.slice(0, 7), "", includePhone ? phone : "", ""];
  while (rows.length < rowsPerEntry) rows.push("");
  return rows.slice(0, rowsPerEntry);
}

function partyRows(party: ManifestDocumentParty, includePhone: boolean) {
  return party.party
    ? fixedPartyAddressRows(party.party, includePhone)
    : fallbackAddressRows(party.formatted, includePhone);
}

function wrappedDescriptionLines(value: string, maximumLength = 40) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines[lines.length - 1] ?? "";
    if (!current || current.length + word.length + 1 > maximumLength) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  if (lines.length > rowsPerEntry) {
    throw new OperationsManifestServiceError(
      "A selected consignment description is too long for the CFL UK manifest entry block.",
      409
    );
  }
  return lines;
}

function templateEntryStyles(worksheet: ExcelJS.Worksheet) {
  return Array.from({ length: rowsPerEntry }, (_, offset) => ({
    height: worksheet.getRow(firstEntryRow + offset).height,
    cells: Array.from({ length: lastTemplateColumn - firstTemplateColumn + 1 }, (_, columnOffset) =>
      worksheet.getCell(firstEntryRow + offset, firstTemplateColumn + columnOffset).style)
  }));
}

function prepareEntryRows(worksheet: ExcelJS.Worksheet, entryCount: number) {
  const styles = templateEntryStyles(worksheet);
  const requiredLastRow = firstEntryRow + entryCount * rowsPerEntry - 1;
  for (let rowNumber = firstEntryRow; rowNumber <= requiredLastRow; rowNumber += 1) {
    const style = styles[(rowNumber - firstEntryRow) % rowsPerEntry]!;
    const row = worksheet.getRow(rowNumber);
    row.height = style.height;
    for (let column = firstTemplateColumn; column <= lastTemplateColumn; column += 1) {
      const cell = row.getCell(column);
      cell.value = null;
      cell.style = style.cells[column - firstTemplateColumn]!;
    }
  }
  for (let rowNumber = requiredLastRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    for (let column = firstTemplateColumn; column <= lastTemplateColumn; column += 1) {
      const cell = row.getCell(column);
      cell.value = null;
      cell.style = {};
    }
  }
}

function manifestDate(value: unknown) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : text;
}

export function ukOperationsManifestFilename(manifestNumber: string) {
  return `${manifestNumber.trim().toUpperCase()}UKMANIFEST.xlsx`;
}

export async function buildOperationsManifestUkExcel(
  manifest: IOperationsManifest,
  options: UkManifestBuildOptions = {}
) {
  const snapshot = parseSealedSnapshot(manifest.sealedSnapshot);
  if (!snapshot) throw new OperationsManifestServiceError("The sealed manifest snapshot is unavailable.", 409);
  if (String(snapshot.header.destinationCountryCode ?? "").trim().toUpperCase() !== "GB") {
    throw new OperationsManifestServiceError("The UK manifest is available only for United Kingdom operations manifests.", 409);
  }
  if (snapshot.consignments.some((consignment) => !Array.isArray(consignment.parcels))) {
    throw new OperationsManifestServiceError("This historical manifest does not contain parcel-level bag data required for a UK manifest.", 409);
  }

  const model = buildManifestDocumentModel(snapshot);
  const bagByNumber = new Map<string, UkManifestBag>();
  snapshot.bags.forEach((bag, index) => {
    const bagNumber = String(bag.bagNumber ?? "").trim().toUpperCase();
    bagByNumber.set(bagNumber, {
      sequence: Number(bag.sequence) > 0 ? Number(bag.sequence) : index + 1,
      bagNumber,
      pieces: 0,
      weightGrams: 0,
      declaredValueMinor: 0,
      descriptions: []
    });
  });
  for (const parcel of model.parcelRows) {
    const bag = bagByNumber.get(parcel.bagNumber.trim().toUpperCase());
    if (!bag) throw new OperationsManifestServiceError("A sealed parcel is missing its UK manifest bag.", 409);
    if (parcel.declaredValueMinor != null
      && (!Number.isInteger(parcel.declaredValueMinor) || parcel.declaredValueMinor < 0)) {
      throw new OperationsManifestServiceError("A UK manifest parcel contains an invalid declared value.", 409);
    }
    bag.pieces += 1;
    bag.weightGrams += weightGrams(parcel.weightKg);
    bag.declaredValueMinor = (bag.declaredValueMinor ?? 0) + (parcel.declaredValueMinor ?? 0);
    bag.descriptions?.push(parcel.description ?? "");
  }
  const sourceDeclaredValueMinor = model.consignments.reduce((sum, consignment) => {
    if (!Number.isInteger(consignment.declaredValueMinor) || (consignment.declaredValueMinor ?? -1) < 0) {
      throw new OperationsManifestServiceError("Every UK manifest consignment requires a valid declared value.", 409);
    }
    return sum + consignment.declaredValueMinor!;
  }, 0);
  const representedDeclaredValueMinor = [...bagByNumber.values()]
    .reduce((sum, bag) => sum + (bag.declaredValueMinor ?? 0), 0);
  if (representedDeclaredValueMinor !== sourceDeclaredValueMinor) {
    throw new OperationsManifestServiceError(
      "UK manifest parcel values do not match the sealed consignment values.",
      409
    );
  }

  const displayBags = [...bagByNumber.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map((bag, index) => ({ ...bag, sequence: index + 1 }));
  const gbpToInr = await resolveGbpToInrRate(options.gbpToInr);
  const entries = buildUkManifestEntries({
    manifestNumber: model.manifestNumber,
    totalBags: model.totals.totalBags,
    totalPhysicalParcels: model.totals.totalPhysicalParcels,
    totalWeightKg: model.totals.totalWeightKg,
    bags: displayBags,
    consignments: model.consignments,
    gbpToInr
  });
  const entryValuesGbpMinor = reconcileGbpMinorValues(
    entries.map((entry) => entry.declaredValueMinor),
    gbpToInr
  );

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(templatePath);
  } catch {
    throw new OperationsManifestServiceError("The CFL UK manifest template is unavailable.", 500);
  }
  const worksheet = workbook.getWorksheet("CFL Manifest Template");
  if (!worksheet) throw new OperationsManifestServiceError("The CFL UK manifest template is invalid.", 500);

  prepareEntryRows(worksheet, entries.length);
  worksheet.getCell("J3").value = model.manifestNumber;
  worksheet.getCell("J4").value = String(snapshot.header.flightNumber ?? "");
  worksheet.getCell("J5").value = manifestDate(snapshot.header.departureDate);
  worksheet.getCell("J6").value = String(snapshot.header.mawbNumber ?? "");
  worksheet.getCell("J8").value = String(snapshot.header.originIataCode ?? "");
  worksheet.getCell("J9").value = String(snapshot.header.destinationIataCode ?? "");
  worksheet.getCell("J10").value = model.totals.totalBags;
  worksheet.getCell("J11").value = model.totals.totalWeightKg;
  worksheet.getCell("J12").value = String(snapshot.header.valueType ?? "");

  entries.forEach((entry, index) => {
    const rowNumber = firstEntryRow + index * rowsPerEntry;
    const consignor = partyRows(entry.consignment.consignor, false);
    const consignee = partyRows(entry.consignment.consignee, true);
    const description = wrappedDescriptionLines(entry.descriptions.join(", "));

    worksheet.getCell(rowNumber, 2).value = entry.serial;
    worksheet.getCell(rowNumber, 3).value = entry.consignment.formattedConsignmentNumber;
    worksheet.getCell(rowNumber, 4).value = entry.pieces;
    worksheet.getCell(rowNumber, 5).value = entry.weightKg;
    const entryValueGbpMinor = entryValuesGbpMinor[index]!;
    // CFL's import contract uses GBP 38 as its operational placeholder when
    // the real combined entry value exceeds GBP 40. The sealed source values
    // remain unchanged and continue to drive the actual conversion above.
    worksheet.getCell(rowNumber, 9).value = entryValueGbpMinor <= ukAutomaticEntryValueMaximumGbpMinor
      ? entryValueGbpMinor / 100
      : ukOverLimitDefaultValueGbpMinor / 100;
    worksheet.getCell(rowNumber, 10).value = "GBP";
    worksheet.getCell(rowNumber, 11).value = entry.bags.map((bag) => bag.sequence).join(",");
    worksheet.getCell(rowNumber, 12).value = "EXP";

    for (let offset = 0; offset < rowsPerEntry; offset += 1) {
      worksheet.getCell(rowNumber + offset, 6).value = consignor[offset] ?? "";
      worksheet.getCell(rowNumber + offset, 7).value = consignee[offset] ?? "";
      worksheet.getCell(rowNumber + offset, 8).value = description[offset] ?? "";
    }
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
