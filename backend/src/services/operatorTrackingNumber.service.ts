import mongoose from "mongoose";
import { OperatorShipmentTrackingCounter } from "../models/operatorShipmentTrackingCounter.model.js";
import { getTenantContext } from "./tenantScope.service.js";
import { normalizeStationCode } from "./swiftlineTracking.service.js";

const MAX_DAILY_SEQUENCE = Number.MAX_SAFE_INTEGER;

function indiaDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    displayDate: `${value("day")}${value("month")}${value("year").slice(-2)}`,
    dateKey: `${value("year")}${value("month")}${value("day")}`
  };
}

export function formatOperatorShipmentTrackingNumber(input: {
  tenantId: mongoose.Types.ObjectId | string;
  companyName: string;
  stationCode: string;
  date: Date;
  sequence: number;
}) {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > MAX_DAILY_SEQUENCE) {
    throw new Error("OPERATOR_TRACKING_SEQUENCE_EXHAUSTED");
  }
  const tenantId = String(input.tenantId).toUpperCase();
  if (!/^[A-F\d]{24}$/.test(tenantId)) throw new Error("OPERATOR_TENANT_ID_INVALID");
  const companyPrefix = getOperatorCompanyTrackingPrefix(input.companyName);
  const stationCode = normalizeStationCode(input.stationCode);
  const { displayDate } = indiaDateParts(input.date);
  const sequence = String(input.sequence).padStart(3, "0");
  return `${companyPrefix}${stationCode}${displayDate}${sequence}`;
}

/** Three-letter operator identifier used in place of Swiftline's SLC prefix. */
export function getOperatorCompanyTrackingPrefix(companyName: string) {
  const words = companyName.normalize("NFKD").toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  let prefix = words.length >= 3
    ? words.slice(0, 3).map((word) => word[0]).join("")
    : words.length === 2
      ? `${first.slice(0, 2)}${second[0] ?? ""}`
      : first.slice(0, 3);

  if (!prefix) prefix = "OPR";
  return prefix.padEnd(3, prefix.at(-1) ?? "R").slice(0, 3);
}

export async function allocateOperatorShipmentTrackingNumber(input: {
  tenantId: mongoose.Types.ObjectId;
  companyName: string;
  branchId: mongoose.Types.ObjectId;
  stationCode: string;
  date?: Date;
}) {
  const context = getTenantContext();
  if (context?.kind !== "OPERATOR" || !context.tenantId.equals(input.tenantId)) {
    throw new Error("OPERATOR_TRACKING_TENANT_CONTEXT_REQUIRED");
  }

  const date = input.date ?? new Date();
  const { dateKey } = indiaDateParts(date);
  const stationCode = normalizeStationCode(input.stationCode);
  const counter = await OperatorShipmentTrackingCounter.findOneAndUpdate(
    { tenantId: input.tenantId, branchId: input.branchId, dateKey },
    {
      $inc: { sequence: 1 },
      $setOnInsert: { tenantId: input.tenantId, branchId: input.branchId, dateKey }
    },
    { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).exec();
  if (!counter) throw new Error("OPERATOR_TRACKING_ALLOCATION_FAILED");

  return formatOperatorShipmentTrackingNumber({
    tenantId: input.tenantId,
    companyName: input.companyName,
    stationCode,
    date,
    sequence: counter.sequence
  });
}
