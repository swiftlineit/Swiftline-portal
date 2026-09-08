import { env } from "../../config/env.js";
import type { IShipmentDraft } from "../../models/shipmentDraft.model.js";
import type { LabelFormat } from "../../models/labelDocument.model.js";
import {
  AlsPayloadError,
  buildAlsCreateDocketPayload,
  sanitizeAlsRequestSnapshot
} from "./alsPayload.service.js";

/**
 * ALS (Trackmate+ by ITD Services) is the carrier behind the DPD label. It is
 * asked for a label only on United Kingdom shipments; every other destination
 * books on Swiftline labels alone and never reaches this module.
 *
 * There is no usable sandbox - ITD have not enabled test.itdservices.in - so
 * every call here is a real, chargeable booking. Nothing runs unless the
 * destination qualifies; if it does and the integration cannot serve it, that
 * is reported as a failure rather than passed over in silence.
 */

export interface AlsLabel {
  /** ALS returns HTML; a multi-parcel booking is one document of many pages. */
  content: Buffer;
  format: LabelFormat;
  filename: string;
}

export interface AlsCreateDocketResult {
  docketId: string;
  awbNumber: string;
  forwardingNumber: string;
  entryNumber: string;
  parcelNumbers: string[];
  labels: AlsLabel[];
  requestSnapshot: Record<string, unknown>;
  /** Compact receipt only. Label bodies belong in object storage, not MongoDB. */
  responseSnapshot: Record<string, unknown>;
}

/**
 * ALS understood the request and refused it, or its configuration is wrong.
 *
 * Distinct from AlsUncertainError because a refusal is final and safe to report:
 * no booking exists at the carrier, so the caller may roll everything back.
 */
export class AlsRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly providerResponse: Record<string, unknown> = {},
    /** The carrier's own wording, for operations. Never shown to a customer. */
    public readonly carrierErrors: string[] = []
  ) {
    super(message);
    this.name = "AlsRequestError";
  }
}

/**
 * The request left but its outcome is unknown - a timeout, a dropped socket, or
 * a reply that could not be read.
 *
 * A booking may or may not exist at ALS, so the caller must never retry
 * automatically and must never assume the shipment was refused.
 */
export class AlsUncertainError extends Error {
  constructor(message = "The DPD booking result is uncertain. Do not submit it again.") {
    super(message);
    this.name = "AlsUncertainError";
  }
}

export interface AlsConfiguration {
  apiBaseUrl: string;
  companyId: number;
  email: string;
  password: string;
  serviceCode: string;
  inrPerGbp: number;
  timeoutMs: number;
}

/**
 * The master switch for live carrier calls.
 *
 * Off does not mean "book United Kingdom shipments without a label" - it means
 * a label cannot be produced, which the booker is told about and must decide
 * on. Silently shipping a UK parcel with no carrier label is the one outcome
 * this must never cause.
 */
export function isAlsEnabled() {
  return env.ALS_ENABLED === true;
}

/**
 * The live ALS settings, or the list of what is missing.
 *
 * Returns rather than throws: a misconfigured integration must not be able to
 * take down booking for destinations that never use it.
 */
export function readAlsConfiguration():
  | { ok: true; configuration: AlsConfiguration }
  | { ok: false; missing: string[] } {
  const missing = [
    !env.ALS_API_BASE_URL && "ALS_API_BASE_URL",
    !env.ALS_COMPANY_ID && "ALS_COMPANY_ID",
    !env.ALS_API_EMAIL && "ALS_API_EMAIL",
    !env.ALS_API_PASSWORD && "ALS_API_PASSWORD",
    !env.ALS_INR_PER_GBP && "ALS_INR_PER_GBP"
  ].filter((value): value is string => Boolean(value));

  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    configuration: {
      apiBaseUrl: (env.ALS_API_BASE_URL ?? "").replace(/\/$/, ""),
      companyId: env.ALS_COMPANY_ID as number,
      email: env.ALS_API_EMAIL as string,
      password: env.ALS_API_PASSWORD as string,
      serviceCode: env.ALS_SERVICE_CODE,
      inrPerGbp: env.ALS_INR_PER_GBP as number,
      timeoutMs: env.ALS_REQUEST_TIMEOUT_MS
    }
  };
}

type AlsAuth = { token: string; customerId: number };

// One token is shared by every booking until ALS rejects it as expired.
// `pendingAuth` collapses concurrent bookings onto a single authentication
// rather than each opening its own session.
let cachedAuth: AlsAuth | null = null;
let pendingAuth: Promise<AlsAuth> | null = null;

/** Test seam: clears the module-level token between cases. */
export function resetAlsAuthCache() {
  cachedAuth = null;
  pendingAuth = null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** The carrier's own error strings, flattened from the shapes it uses. */
export function readCarrierErrors(providerResponse: Record<string, unknown>): string[] {
  const candidates = [providerResponse.errors, asRecord(providerResponse.data).errors];
  const messages: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) messages.push(candidate.trim());
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (typeof entry === "string" && entry.trim()) messages.push(entry.trim());
      }
    }
  }

  return [...new Set(messages)];
}

function errorMessage(body: Record<string, unknown>) {
  const carrierErrors = readCarrierErrors(body);
  if (carrierErrors.length) return carrierErrors.join(" ");
  return asString(body.message) || "DPD refused this booking.";
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!text) return { response, body: {} as Record<string, unknown>, parsed: false };
    try {
      return { response, body: JSON.parse(text) as Record<string, unknown>, parsed: true };
    } catch {
      return { response, body: {} as Record<string, unknown>, parsed: false };
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function authenticate(configuration: AlsConfiguration): Promise<AlsAuth> {
  let result: Awaited<ReturnType<typeof fetchJson>>;
  try {
    result = await fetchJson(
      `${configuration.apiBaseUrl}/docket_api/get_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: configuration.companyId,
          email: configuration.email,
          password: configuration.password
        })
      },
      configuration.timeoutMs
    );
  } catch {
    // Authentication creates nothing, so a failure here is safely a refusal.
    throw new AlsRequestError("DPD authentication is temporarily unavailable.", 503);
  }

  const data = asRecord(result.body.data);
  const token = asString(data.token);
  const customerId = Number(data.customer_id);

  if (!result.parsed || result.body.success !== true || !token || !Number.isInteger(customerId) || customerId <= 0) {
    throw new AlsRequestError(
      "DPD authentication failed. Check the configured API account.",
      503,
      result.body,
      readCarrierErrors(result.body)
    );
  }

  return { token, customerId };
}

async function getAuth(configuration: AlsConfiguration, forceRefresh = false) {
  if (forceRefresh) {
    cachedAuth = null;
    pendingAuth = null;
  }
  if (cachedAuth) return cachedAuth;
  if (!pendingAuth) {
    pendingAuth = authenticate(configuration)
      .then((auth) => {
        cachedAuth = auth;
        return auth;
      })
      .finally(() => {
        pendingAuth = null;
      });
  }
  return pendingAuth;
}

/**
 * Wraps a returned fragment so it prints as a standalone document.
 *
 * ALS sends inline styles and data-URI images with no document shell. A
 * multi-parcel booking arrives as one fragment whose pages are separated by
 * `page-break-after`, so it must not be split - printing the whole document
 * yields one page per parcel.
 */
function htmlDocument(fragment: string) {
  if (/<html[\s>]/i.test(fragment)) return fragment;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>DPD Label</title>",
    "</head><body>",
    fragment,
    "</body></html>"
  ].join("");
}

function labelFormat(fileType: string): LabelFormat | null {
  const normalized = fileType.trim().toLowerCase();
  if (normalized.includes("html")) return "HTML";
  if (normalized.includes("pdf")) return "PDF";
  if (normalized.includes("zpl")) return "ZPL";
  return null;
}

function labelContent(value: string, format: LabelFormat) {
  if (format === "HTML") {
    // HTML may arrive raw or base64-encoded; a base64 payload has no markup.
    const looksEncoded = !/[<>]/.test(value) && /^[A-Za-z0-9+/=\s]+$/.test(value.trim());
    const html = looksEncoded ? Buffer.from(value, "base64").toString("utf8") : value;
    return Buffer.from(htmlDocument(html), "utf8");
  }
  return Buffer.from(value, "base64");
}

export function parseAlsCreateDocketResponse(
  body: Record<string, unknown>,
  requestSnapshot: Record<string, unknown>
): AlsCreateDocketResult {
  // The payload sits at the top level, not nested under `data` as the spec shows.
  const data = asRecord(body.data);
  const awbNumber = asString(data.awb_no);
  const docketId = asString(data.docket_id);

  if (!awbNumber && !docketId) {
    throw new AlsRequestError("DPD accepted the booking but returned no AWB number.", 502, body);
  }

  const parcels = Array.isArray(body.parcels) ? body.parcels : [];
  const parcelNumbers = parcels
    .map((parcel) => asString(asRecord(parcel).parcel_no))
    .filter(Boolean);

  const labels: AlsLabel[] = [];
  for (const entry of Array.isArray(body.labels) ? body.labels : []) {
    const label = asRecord(entry);
    const value = asString(label.label);
    const format = labelFormat(asString(label.file_type) || "html");
    if (!value || !format) continue;

    labels.push({
      content: labelContent(value, format),
      format,
      filename: asString(label.filename) || `dpd-label-${awbNumber || docketId}`
    });
  }

  if (!labels.length) {
    throw new AlsRequestError("DPD accepted the booking but returned no label.", 502, body);
  }

  // The carrier response can contain a complete HTML/base64 label for every
  // parcel. Persisting that response would duplicate the same document stored
  // in object storage and make each booking row unnecessarily large. Keep only
  // the identifiers and document metadata required for audit/reconciliation.
  const responseSnapshot = {
    provider: "ALS",
    outcome: "ACCEPTED",
    docketId,
    awbNumber,
    forwardingNumber: asString(data.forwording_no),
    entryNumber: asString(data.entry_number),
    parcelNumbers,
    labelCount: labels.length,
    labelFormats: [...new Set(labels.map((label) => label.format))]
  };

  return {
    docketId,
    awbNumber,
    forwardingNumber: responseSnapshot.forwardingNumber,
    entryNumber: responseSnapshot.entryNumber,
    parcelNumbers,
    labels,
    requestSnapshot,
    responseSnapshot
  };
}

async function submitDocket(input: {
  configuration: AlsConfiguration;
  auth: AlsAuth;
  draft: IShipmentDraft;
  trackingNumber: string;
  bookedAt: Date;
}): Promise<AlsCreateDocketResult | { tokenExpired: true }> {
  const { configuration, auth, draft, trackingNumber, bookedAt } = input;

  const payload = buildAlsCreateDocketPayload({
    draft,
    serviceCode: configuration.serviceCode,
    inrPerGbp: configuration.inrPerGbp,
    customerId: auth.customerId,
    trackingNumber,
    bookedAt
  });
  const requestSnapshot = sanitizeAlsRequestSnapshot(payload);

  let result: Awaited<ReturnType<typeof fetchJson>>;
  try {
    result = await fetchJson(
      `${configuration.apiBaseUrl}/docket_api/create_docket`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`
        },
        body: JSON.stringify(payload)
      },
      configuration.timeoutMs
    );
  } catch {
    // The request left and its fate is unknown. A booking may exist at ALS.
    throw new AlsUncertainError();
  }

  if (!result.parsed) {
    throw new AlsUncertainError("DPD returned an unreadable booking response. Do not submit it again.");
  }
  if (result.body.success === true) {
    return parseAlsCreateDocketResponse(result.body, requestSnapshot);
  }

  const message = errorMessage(result.body);
  if (message.toUpperCase().includes("AUTH TOKEN EXPIRED")) {
    return { tokenExpired: true as const };
  }

  // ALS answers a business refusal with HTTP 500 and a JSON body. That status is
  // deliberately not passed through: the shipment was understood and declined,
  // and reporting it as a server error sends everyone looking in the wrong
  // place. Having a parsed body at all is what makes this a decision rather than
  // an outage - an unreadable reply is treated as uncertain above.
  throw new AlsRequestError(message, 409, result.body, readCarrierErrors(result.body));
}

/**
 * Books the shipment with ALS and returns its label.
 *
 * Callers must treat AlsUncertainError as "may have been created" and
 * AlsRequestError as "definitely not created".
 */
export async function createAlsDocket(input: {
  draft: IShipmentDraft;
  trackingNumber: string;
  bookedAt: Date;
}): Promise<AlsCreateDocketResult> {
  // Switched off is a refusal, not a silent skip: a United Kingdom parcel
  // without its carrier label cannot travel, so somebody has to be told and
  // has to choose. No request is made.
  if (!isAlsEnabled()) {
    throw new AlsRequestError(
      "DPD label creation is switched off for this portal (ALS_ENABLED). Turn it on, or book without the carrier label.",
      503
    );
  }

  const settings = readAlsConfiguration();
  if (!settings.ok) {
    throw new AlsRequestError(
      `DPD label creation is unavailable because these server settings are missing: ${settings.missing.join(", ")}.`,
      503
    );
  }

  const { configuration } = settings;
  let auth = await getAuth(configuration);

  try {
    const first = await submitDocket({ configuration, auth, ...input });
    if (!("tokenExpired" in first)) return first;
  } catch (error) {
    if (error instanceof AlsPayloadError) throw new AlsRequestError(error.message, 400);
    throw error;
  }

  // An explicit expired-token rejection means ALS refused before creating
  // anything, so refreshing once is the only safe automatic retry.
  auth = await getAuth(configuration, true);
  try {
    const second = await submitDocket({ configuration, auth, ...input });
    if ("tokenExpired" in second) {
      throw new AlsRequestError("DPD authentication expired again. Contact an administrator.", 503);
    }
    return second;
  } catch (error) {
    if (error instanceof AlsPayloadError) throw new AlsRequestError(error.message, 400);
    throw error;
  }
}
