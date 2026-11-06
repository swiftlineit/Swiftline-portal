// Pure formatters for the customs EDI. Each rule is derived from the rows of the
// sample EDI that were not scrambled, and is unit-tested in isolation.
import { compactSwiftlineParcelNumber } from "../swiftlineParcelIdentifier.service.js";

/** Anything → a trimmed string. Numbers become their string form; null/undefined → "". */
export function ediText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** Compacts a recognized Swiftline parcel ID without changing custom references. */
export function ediSwiftlineParcelNumber(value: unknown): string {
  const text = ediText(value);
  return compactSwiftlineParcelNumber(text) ?? text;
}

/** Trims and strips a single trailing comma; internal commas are preserved. */
export function ediAddressLine(value: unknown): string {
  return ediText(value).replace(/,\s*$/, "").trim();
}

/**
 * Per-word Title Case for state names: PUNJAB → Punjab, UTTAR PRADESH → Uttar
 * Pradesh, MANCHESTER → Manchester. Values already in title case pass through.
 */
export function titleCaseState(value: unknown): string {
  return ediText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * yyyy-MM-dd → d/M/yyyy as text, without leading zeros (2026-07-17 → 17/7/2026).
 * A value that is not an ISO date is returned unchanged. Distinct from the manifest's
 * dd-MM-yyyy helper- do not interchange them.
 */
export function ediDate(value: unknown): string {
  const text = ediText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return text;
  const [, year, month, day] = match;
  return `${Number(day)}/${Number(month)}/${year}`;
}

/** Declared value in minor units → a numeric major-unit value, or "" when absent. */
export function ediValue(declaredValueMinor: number | null | undefined): number | "" {
  return typeof declaredValueMinor === "number" ? declaredValueMinor / 100 : "";
}

/** 12-digit Aadhaar as a number for the numeric GSTINNumber cell, or "" when unusable. */
export function ediAadhaarNumber(value: unknown): number | "" {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length === 12 ? Number(digits) : "";
}
