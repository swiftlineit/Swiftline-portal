import mongoose from "mongoose";
import { env } from "../config/env.js";
import { FlightBuyingRate, type IFlightBuyingRate } from "../models/flightBuyingRate.model.js";
import { FlightCostAllocation, type FlightAllocationComponent } from "../models/flightCostAllocation.model.js";
import { FlightCostSheet, type FlightCostTotals, type IFlightCostSheet } from "../models/flightCostSheet.model.js";
import { ExchangeRateCache } from "../models/exchangeRateCache.model.js";
import { FlightCostSheetRevision } from "../models/flightCostSheetRevision.model.js";
import { AuditLog } from "../models/auditLog.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { OperationsManifest } from "../models/operationsManifest.model.js";
import { OperationsManifestBag } from "../models/operationsManifestBag.model.js";
import { OperationsManifestConsignment } from "../models/operationsManifestConsignment.model.js";
import { OperationsManifestScan } from "../models/operationsManifestScan.model.js";
import { ShipmentProfitability } from "../models/shipmentProfitability.model.js";
import { calculateProfitabilityTotals, normalizeProfitabilityCosts } from "./shipmentProfitability.service.js";
import { resolveTrackingProfile } from "./shipmentJourney.service.js";

export type FlightRateSnapshot = Pick<IFlightBuyingRate,
  "airFreightRateMinorPerKg" | "gstBasisPoints" | "eicfRateMinorPerKg" |
  "customsMinor" | "transportationMinor" | "cflMinorPerBagGbp" | "dpdLabelMinorGbp"
>;

export function resolveFlightRateRegion(destinationCountryCode: string) {
  const profile = resolveTrackingProfile(destinationCountryCode);
  if (profile === "UK" || profile === "CANADA" || profile === "EUROPE") return profile;
  if (profile === "USA") return "US" as const;
  return null;
}

function dateKey(value: Date | string) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

export function isFlightBuyingRateApplicable(
  rate: Pick<IFlightBuyingRate, "region" | "effectiveFrom" | "effectiveTo" | "status">,
  destinationCountryCode: string,
  flightDate: string
) {
  const expectedRegion = resolveFlightRateRegion(destinationCountryCode);
  const from = dateKey(rate.effectiveFrom);
  const to = rate.effectiveTo ? dateKey(rate.effectiveTo) : null;
  return rate.status === "ACTIVE"
    && expectedRegion !== null
    && rate.region === expectedRegion
    && Boolean(from)
    && /^\d{4}-\d{2}-\d{2}$/.test(flightDate)
    && from <= flightDate
    && (!to || to >= flightDate);
}

export function nextFlightSnapshotRevision(currentRevision: number, latestStoredRevision: number | null | undefined) {
  return Math.max(Math.max(1, Math.trunc(currentRevision)), Math.max(0, Math.trunc(latestStoredRevision ?? 0)) + 1);
}

export type FlightOperationalFacts = {
  manifestWeightKg: number;
  billedWeightKg: number;
  totalBags: number;
  totalParcels: number;
  portalDpdLabels: number;
  externalPaidLabels: number;
};

export function calculateFlightCostTotals(input: {
  rate: FlightRateSnapshot;
  facts: FlightOperationalFacts;
  gbpToInr: number;
  totalRevenueMinor?: number;
}): FlightCostTotals {
  const weight = Math.max(0, input.facts.billedWeightKg);
  const airFreightBaseMinor = Math.round(input.rate.airFreightRateMinorPerKg * weight);
  const airFreightGstMinor = Math.round((airFreightBaseMinor * input.rate.gstBasisPoints) / 10_000);
  const airFreightTotalMinor = airFreightBaseMinor + airFreightGstMinor;
  const eicfMinor = Math.round(input.rate.eicfRateMinorPerKg * weight);
  const cflGbpMinor = Math.round(input.rate.cflMinorPerBagGbp * input.facts.totalBags);
  const cflInrMinor = Math.round(cflGbpMinor * input.gbpToInr);
  const billableLabels = input.facts.portalDpdLabels + input.facts.externalPaidLabels;
  const dpdLabelsGbpMinor = Math.round(input.rate.dpdLabelMinorGbp * billableLabels);
  const dpdLabelsInrMinor = Math.round(dpdLabelsGbpMinor * input.gbpToInr);
  const totalCostMinor = airFreightTotalMinor + eicfMinor + input.rate.customsMinor
    + input.rate.transportationMinor + cflInrMinor + dpdLabelsInrMinor;
  const totalRevenueMinor = Math.round(input.totalRevenueMinor ?? 0);
  const grossProfitMinor = totalRevenueMinor - totalCostMinor;
  const marginBasisPoints = totalRevenueMinor > 0
    ? Math.round((grossProfitMinor / totalRevenueMinor) * 10_000)
    : null;
  return {
    airFreightBaseMinor,
    airFreightGstMinor,
    airFreightTotalMinor,
    eicfMinor,
    customsMinor: input.rate.customsMinor,
    transportationMinor: input.rate.transportationMinor,
    cflGbpMinor,
    cflInrMinor,
    dpdLabelsGbpMinor,
    dpdLabelsInrMinor,
    totalCostMinor,
    totalRevenueMinor,
    grossProfitMinor,
    marginBasisPoints
  };
}

export function allocateMinorUnits(totalMinor: number, weights: number[], stableIds: string[]) {
  if (!weights.length) return [];
  const normalized = weights.map((weight) => Math.max(0, Math.round(weight)));
  const denominator = normalized.reduce((sum, weight) => sum + weight, 0);
  if (!denominator) {
    const base = Math.floor(totalMinor / weights.length);
    return weights.map((_, index) => base + (index < totalMinor - base * weights.length ? 1 : 0));
  }
  const raw = normalized.map((weight) => (totalMinor * weight) / denominator);
  const allocations = raw.map(Math.floor);
  let remainder = totalMinor - allocations.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - allocations[index]!, id: stableIds[index] ?? "" }))
    .sort((left, right) => right.fraction - left.fraction || left.id.localeCompare(right.id));
  for (let index = 0; index < order.length && remainder > 0; index += 1, remainder -= 1) {
    const allocationIndex = order[index]!.index;
    allocations[allocationIndex] = (allocations[allocationIndex] ?? 0) + 1;
  }
  return allocations;
}

const BILLED_WEIGHT_TOLERANCE_KG = 0.0005;

export function isBilledWeightOverride(billedWeightKg: number, manifestWeightKg: number) {
  return Number.isFinite(billedWeightKg)
    && Number.isFinite(manifestWeightKg)
    && Math.abs(billedWeightKg - manifestWeightKg) > BILLED_WEIGHT_TOLERANCE_KG;
}

type ExchangeRateSnapshot = {
  gbpToInr: number;
  provider: "ExchangeRate-API" | "Manual";
  providerUpdatedAt: Date | null;
  fetchedAt: Date;
};

let cachedExchangeRate: ExchangeRateSnapshot | null = null;
const EXCHANGE_CACHE_MS = 55 * 60 * 1000;

async function loadPersistedCache(): Promise<ExchangeRateSnapshot | null> {
  try {
    const cached = await ExchangeRateCache.findOne({ baseCurrency: "GBP", targetCurrency: "INR" }).sort({ fetchedAt: -1 }).lean().exec();
    if (!cached) return null;
    return { gbpToInr: cached.gbpToInr, provider: cached.provider as ExchangeRateSnapshot["provider"], providerUpdatedAt: cached.providerUpdatedAt ?? null, fetchedAt: cached.fetchedAt };
  } catch { return null; }
}

async function persistCache(snapshot: ExchangeRateSnapshot): Promise<void> {
  try {
    await ExchangeRateCache.create({ baseCurrency: "GBP", targetCurrency: "INR", gbpToInr: snapshot.gbpToInr, provider: snapshot.provider, providerUpdatedAt: snapshot.providerUpdatedAt, fetchedAt: snapshot.fetchedAt });
  } catch { /* best effort */ }
}

export async function getGbpToInrRate(force = false): Promise<ExchangeRateSnapshot> {
  if (!force && cachedExchangeRate && Date.now() - cachedExchangeRate.fetchedAt.getTime() < EXCHANGE_CACHE_MS) {
    return cachedExchangeRate;
  }
  if (!force) {
    const persisted = await loadPersistedCache();
    if (persisted && Date.now() - persisted.fetchedAt.getTime() < EXCHANGE_CACHE_MS) {
      cachedExchangeRate = persisted;
      return persisted;
    }
  }
  if (!env.EXCHANGE_RATE_API_KEY) {
    if (cachedExchangeRate) return cachedExchangeRate;
    const persisted = await loadPersistedCache();
    if (persisted) {
      cachedExchangeRate = persisted;
      return persisted;
    }
    throw new Error("ExchangeRate-API is not configured. Enter an approved manual GBP/INR rate.");
  }
  try {
    const response = await fetch("https://v6.exchangerate-api.com/v6/latest/GBP", {
      headers: { Authorization: `Bearer ${env.EXCHANGE_RATE_API_KEY}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error("The GBP/INR rate could not be refreshed. Try again or enter an approved manual rate.");
    const payload = await response.json() as {
      result?: string;
      conversion_rates?: { INR?: number };
      time_last_update_unix?: number;
    };
    const gbpToInr = Number(payload.conversion_rates?.INR);
    if (payload.result !== "success" || !Number.isFinite(gbpToInr) || gbpToInr <= 0) {
      throw new Error("ExchangeRate-API returned an invalid GBP/INR rate.");
    }
    cachedExchangeRate = {
      gbpToInr,
      provider: "ExchangeRate-API",
      providerUpdatedAt: payload.time_last_update_unix ? new Date(payload.time_last_update_unix * 1000) : null,
      fetchedAt: new Date()
    };
    await persistCache(cachedExchangeRate);
    return cachedExchangeRate;
  } catch (error) {
    if (cachedExchangeRate) return cachedExchangeRate;
    const persisted = await loadPersistedCache();
    if (persisted) {
      cachedExchangeRate = persisted;
      return persisted;
    }
    throw error instanceof Error ? error : new Error("The GBP/INR rate is unavailable.");
  }
}

export function clearExchangeRateCacheForTests() { cachedExchangeRate = null; }

export async function loadFlightOperationalFacts(manifestId: mongoose.Types.ObjectId, externalPaidLabels = 0, session?: mongoose.ClientSession) {
  const manifestQuery = OperationsManifest.findById(manifestId);
  const consignmentsQuery = OperationsManifestConsignment.find({ manifestId, status: { $ne: "REMOVED" } });
  if (session) { manifestQuery.session(session); consignmentsQuery.session(session); }
  const [manifest, consignments] = await Promise.all([manifestQuery.exec(), consignmentsQuery.exec()]);
  if (!manifest) throw new Error("Operations manifest was not found.");
  const shipmentIds = consignments.map((item) => item.dpdShipmentId);
  const labelsQuery = LabelDocument.countDocuments({
    dpdShipmentId: { $in: shipmentIds }, labelType: "DPD", format: "HTML", voidedAt: null
  });
  if (session) labelsQuery.session(session);
  const portalDpdLabels = await labelsQuery.exec();
  return {
    manifest,
    consignments,
    facts: {
      manifestWeightKg: manifest.totalWeightKg,
      billedWeightKg: manifest.totalWeightKg,
      totalBags: manifest.totalBags,
      totalParcels: manifest.totalPhysicalParcels,
      portalDpdLabels,
      externalPaidLabels
    }
  };
}

function componentTotals(totals: FlightCostTotals): Array<{ component: FlightAllocationComponent; amountMinor: number }> {
  return [
    { component: "AIR_FREIGHT", amountMinor: totals.airFreightBaseMinor },
    { component: "AIR_FREIGHT_GST", amountMinor: totals.airFreightGstMinor },
    { component: "EICF", amountMinor: totals.eicfMinor },
    { component: "CUSTOMS", amountMinor: totals.customsMinor },
    { component: "TRANSPORTATION", amountMinor: totals.transportationMinor },
    { component: "CFL", amountMinor: totals.cflInrMinor },
    { component: "DPD_LABEL", amountMinor: totals.dpdLabelsInrMinor }
  ];
}

export async function rebuildFlightAllocations(sheet: IFlightCostSheet, session?: mongoose.ClientSession) {
  const manifestId = sheet.operationsManifestId;
  const consignmentQuery = OperationsManifestConsignment.find({ manifestId, status: { $ne: "REMOVED" } }).sort({ createdAt: 1 });
  if (session) consignmentQuery.session(session);
  const consignments = await consignmentQuery.exec();
  const shipmentDraftIds = consignments.map((item) => item.shipmentDraftId);
  const profitabilityQuery = ShipmentProfitability.find({ shipmentDraftId: { $in: shipmentDraftIds } });
  if (session) profitabilityQuery.session(session);
  const profitability = await profitabilityQuery.exec();
  const profitabilityByDraft = new Map(profitability.map((item) => [String(item.shipmentDraftId), item]));
  const stableIds = consignments.map((item) => String(item.shipmentDraftId));
  const weightUnits = consignments.map((item) => Math.max(1, Math.round((profitabilityByDraft.get(String(item.shipmentDraftId))?.chargeableWeightKg ?? item.weightKg) * 1000)));
  const parcelUnits = consignments.map((item) => Math.max(0, item.scannedParcelNumbers.length || item.parcelWeightSnapshots.length));
  const components = componentTotals(sheet.totals);
  const allocatedByComponent = new Map<FlightAllocationComponent, number[]>();
  for (const component of components) {
    const weights = component.component === "DPD_LABEL" ? parcelUnits : weightUnits;
    allocatedByComponent.set(component.component, allocateMinorUnits(component.amountMinor, weights, stableIds));
  }
  const allocatedGbpByComponent = new Map<"CFL" | "DPD_LABEL", number[]>();
  allocatedGbpByComponent.set("CFL", allocateMinorUnits(sheet.totals.cflGbpMinor, parcelUnits, stableIds));
  allocatedGbpByComponent.set("DPD_LABEL", allocateMinorUnits(sheet.totals.dpdLabelsGbpMinor, parcelUnits, stableIds));
  const rows = consignments.map((consignment, index) => {
    const profile = profitabilityByDraft.get(String(consignment.shipmentDraftId));
    const rowComponents = components.map(({ component }) => ({
      component,
      amountMinor: allocatedByComponent.get(component)?.[index] ?? 0,
      amountMinorGbp: component === "CFL" || component === "DPD_LABEL"
        ? allocatedGbpByComponent.get(component)?.[index] ?? 0
        : null
    }));
    const totalCostMinor = rowComponents.reduce((sum, item) => sum + item.amountMinor, 0);
    const totalRevenueMinor = profile?.totalRevenueMinor ?? 0;
    const grossProfitMinor = totalRevenueMinor - totalCostMinor;
    return {
      flightCostSheetId: sheet._id,
      operationsManifestId: sheet.operationsManifestId,
      branchId: sheet.branchId,
      shipmentDraftId: consignment.shipmentDraftId,
      shipmentProfitabilityId: profile?._id ?? null,
      awb: profile?.awb ?? consignment.consignmentNumber,
      chargeableWeightKg: profile?.chargeableWeightKg ?? consignment.weightKg,
      parcelCount: parcelUnits[index] ?? 0,
      components: rowComponents,
      totalCostMinor,
      totalRevenueMinor,
      grossProfitMinor,
      marginBasisPoints: totalRevenueMinor > 0 ? Math.round((grossProfitMinor / totalRevenueMinor) * 10_000) : null,
      costState: sheet.status === "FINALIZED" ? "ACTUAL" as const : "ESTIMATED" as const,
      revision: sheet.revision
    };
  });
  const totalRevenueMinor = rows.reduce((sum, row) => sum + row.totalRevenueMinor, 0);
  sheet.totals.totalRevenueMinor = totalRevenueMinor;
  sheet.totals.grossProfitMinor = totalRevenueMinor - sheet.totals.totalCostMinor;
  sheet.totals.marginBasisPoints = totalRevenueMinor > 0
    ? Math.round((sheet.totals.grossProfitMinor / totalRevenueMinor) * 10_000)
    : null;
  await sheet.save({ session });
  if (rows.length) {
    await FlightCostAllocation.bulkWrite(rows.map((row) => ({
      updateOne: {
        filter: { flightCostSheetId: sheet._id, shipmentDraftId: row.shipmentDraftId },
        update: { $set: row },
        upsert: true
      }
    })), { session });
    await FlightCostAllocation.deleteMany({ flightCostSheetId: sheet._id, shipmentDraftId: { $nin: rows.map((row) => row.shipmentDraftId) } }).session(session ?? null).exec();
  } else {
    await FlightCostAllocation.deleteMany({ flightCostSheetId: sheet._id }).session(session ?? null).exec();
  }
  for (const row of rows) {
    if (!row.shipmentProfitabilityId) continue;
    await ShipmentProfitability.updateOne(
      { _id: row.shipmentProfitabilityId },
      {
        $set: {
          primaryVendorId: sheet.vendorId,
          costSource: "FLIGHT_ALLOCATION",
          flightCostSheetId: sheet._id,
          operationsManifestId: sheet.operationsManifestId,
          flightAllocation: row.components,
          flightFxGbpToInr: sheet.fxSnapshot.gbpToInr,
          totalCostMinor: row.totalCostMinor,
          grossProfitMinor: row.grossProfitMinor,
          marginBasisPoints: row.marginBasisPoints,
          coverage: sheet.status === "FINALIZED" ? "ACTUAL" : "ESTIMATED"
        },
        $inc: { version: 1 }
      },
      { session, runValidators: true }
    ).exec();
  }
  return rows;
}

export async function refreshSheetFactsAndTotals(sheet: IFlightCostSheet, options: { session?: mongoose.ClientSession; billedWeightKg?: number } = {}) {
  const { manifest, facts } = await loadFlightOperationalFacts(sheet.operationsManifestId, sheet.externalPaidLabels, options.session);
  sheet.manifestWeightKg = facts.manifestWeightKg;
  sheet.billedWeightKg = options.billedWeightKg ?? sheet.billedWeightKg ?? facts.billedWeightKg;
  sheet.totalBags = facts.totalBags;
  sheet.totalParcels = facts.totalParcels;
  sheet.portalDpdLabels = facts.portalDpdLabels;
  sheet.billableLabels = facts.portalDpdLabels + sheet.externalPaidLabels;
  sheet.missingDpdLabels = Math.max(0, facts.totalParcels - sheet.billableLabels);
  sheet.mawbNumber = manifest.header.mawbNumber;
  sheet.flightNumber = manifest.header.flightNumber;
  sheet.flightDate = manifest.header.departureDate;
  sheet.destinationCountryCode = manifest.header.destinationCountryCode;
  sheet.destinationCountryName = manifest.header.destinationCountryName;
  sheet.totals = calculateFlightCostTotals({
    rate: sheet.rateSnapshot,
    facts: { ...facts, billedWeightKg: sheet.billedWeightKg },
    gbpToInr: sheet.fxSnapshot.gbpToInr,
    totalRevenueMinor: sheet.totals?.totalRevenueMinor ?? 0
  });
  return { manifest, facts };
}

export function copyRateSnapshot(rate: IFlightBuyingRate): FlightRateSnapshot {
  return {
    airFreightRateMinorPerKg: rate.airFreightRateMinorPerKg,
    gstBasisPoints: rate.gstBasisPoints,
    eicfRateMinorPerKg: rate.eicfRateMinorPerKg,
    customsMinor: rate.customsMinor,
    transportationMinor: rate.transportationMinor,
    cflMinorPerBagGbp: rate.cflMinorPerBagGbp,
    dpdLabelMinorGbp: rate.dpdLabelMinorGbp
  };
}

export async function saveFlightCostRevision(
  sheet: IFlightCostSheet,
  changedBy: mongoose.Types.ObjectId,
  reason: string,
  session?: mongoose.ClientSession
) {
  const latest = await FlightCostSheetRevision.findOne({ flightCostSheetId: sheet._id })
    .sort({ revision: -1 })
    .select("revision")
    .session(session ?? null)
    .lean()
    .exec();
  const snapshotRevision = nextFlightSnapshotRevision(sheet.revision, latest?.revision);
  await FlightCostSheetRevision.create([{
    flightCostSheetId: sheet._id,
    operationsManifestId: sheet.operationsManifestId,
    branchId: sheet.branchId,
    revision: snapshotRevision,
    version: sheet.version,
    status: sheet.status,
    manifestNumber: sheet.manifestNumber,
    totals: JSON.parse(JSON.stringify(sheet.totals)),
    rateSnapshot: JSON.parse(JSON.stringify(sheet.rateSnapshot)),
    fxSnapshot: JSON.parse(JSON.stringify(sheet.fxSnapshot)),
    facts: {
      manifestWeightKg: sheet.manifestWeightKg,
      billedWeightKg: sheet.billedWeightKg,
      totalBags: sheet.totalBags,
      totalParcels: sheet.totalParcels,
      portalDpdLabels: sheet.portalDpdLabels,
      externalPaidLabels: sheet.externalPaidLabels,
      billableLabels: sheet.billableLabels,
      missingDpdLabels: sheet.missingDpdLabels
    },
    changeReason: reason,
    changedBy
  }], { session });
  return snapshotRevision;
}

export async function restoreLegacyProfitabilityForSheet(sheet: IFlightCostSheet, session?: mongoose.ClientSession) {
  const profiles = await ShipmentProfitability.find({ flightCostSheetId: sheet._id }).session(session ?? null).exec();
  if (profiles.length) {
    await ShipmentProfitability.bulkWrite(profiles.map((profile) => {
      const costs = normalizeProfitabilityCosts(profile.costs);
      const totals = calculateProfitabilityTotals({ totalRevenueMinor: profile.totalRevenueMinor, costs });
      const primaryVendorId = costs.find((cost) => cost.vendorId)?.vendorId ?? null;
      return {
        updateOne: {
          filter: { _id: profile._id, flightCostSheetId: sheet._id },
          update: {
            $set: {
              primaryVendorId,
              costSource: "LEGACY",
              flightCostSheetId: null,
              operationsManifestId: null,
              flightAllocation: [],
              ...totals
            },
            $inc: { version: 1 }
          }
        }
      };
    }), { session });
  }
  await FlightCostAllocation.deleteMany({ flightCostSheetId: sheet._id }).session(session ?? null).exec();
}

export async function markSheetReviewRequiredIfChanged(
  manifestId: mongoose.Types.ObjectId,
  reason = "Operations manifest changed",
  options: { force?: boolean } = {}
) {
  const session = await mongoose.startSession();
  let sheetId: mongoose.Types.ObjectId | null = null;
  try {
    await session.withTransaction(async () => {
      sheetId = null;
      const sheet = await FlightCostSheet.findOne({ operationsManifestId: manifestId, status: { $in: ["DRAFT", "FINALIZED"] } }).session(session).exec();
      if (!sheet) return;
      const { manifest, facts } = await loadFlightOperationalFacts(manifestId, sheet.externalPaidLabels, session);
      const changed = options.force === true
        || sheet.manifestWeightKg !== facts.manifestWeightKg
        || sheet.totalBags !== facts.totalBags
        || sheet.totalParcels !== facts.totalParcels
        || sheet.mawbNumber !== manifest.header.mawbNumber
        || sheet.flightNumber !== manifest.header.flightNumber
        || sheet.flightDate !== manifest.header.departureDate
        || sheet.destinationCountryCode !== manifest.header.destinationCountryCode;
      if (!changed) return;
      const snapshotRevision = await saveFlightCostRevision(sheet, sheet.updatedBy, sheet.lastChangeReason || "Pre-review snapshot", session);
      sheet.revision = snapshotRevision + 1;
      sheet.status = "REVIEW_REQUIRED";
      sheet.lastChangeReason = reason;
      sheet.version += 1;
      await refreshSheetFactsAndTotals(sheet, { session });
      await rebuildFlightAllocations(sheet, session);
      await AuditLog.create([{
        action: "FLIGHT_COST_SHEET_REVIEW_REQUIRED",
        entityType: "FLIGHT_COST_SHEET",
        entityId: sheet._id,
        performedBy: sheet.updatedBy,
        performedAt: new Date(),
        metadata: { manifestId, reason, automatic: true, revision: sheet.revision }
      }], { session });
      sheetId = sheet._id as mongoose.Types.ObjectId;
    });
    return sheetId ? FlightCostSheet.findById(sheetId).exec() : null;
  } finally {
    await session.endSession();
  }
}

export async function loadSheetWithRelations(sheetId: mongoose.Types.ObjectId) {
  return FlightCostSheet.findById(sheetId)
    .populate("vendorId", "name code status")
    .populate("buyingRateId")
    .exec();
}
