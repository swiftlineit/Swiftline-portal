import rateLimit from "express-rate-limit";
import type { Request } from "express";
import crypto from "node:crypto";
import { env } from "../config/env.js";

function isOperationsScannerRequest(path: string) {
  return /^\/api\/v1\/operations-manifests\/(?:scan-sessions(?:\/|$)|[^/]+\/(?:scan|scan-feed|scan-sessions)(?:\/|$))/.test(path);
}

function authenticatedScannerKey(request: Request) {
  const userId = String((request as typeof request & { user?: { _id?: unknown } }).user?._id ?? "anonymous");
  const sessionId = String(request.params?.sessionId ?? request.body?.sessionId ?? "no-session");
  return `${userId}:${sessionId}`;
}

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.NODE_ENV === "production" ? 1200 : 20000, // dashboards poll; a per-IP cap of 100 logs real operators out
  // Every limiter must answer with the portal JSON envelope. A plain-text 429
  // makes the browser clients fail `response.json()` and treat it as a signed-out session.
  message: { success: false, message: "Too many requests. Wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (request) => isOperationsScannerRequest(request.path)
});

export const scannerPairingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 10 : 100,
  keyGenerator: authenticatedScannerKey,
  message: { success: false, message: "Too many phone pairing attempts. Wait a few minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

export const scannerScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "production" ? 120 : 1000,
  keyGenerator: authenticatedScannerKey,
  message: { success: false, message: "This scanner is sending parcels too quickly. Pause briefly and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

export const scannerFeedLimiter = rateLimit({
  windowMs: 60 * 1000,
  // A paired station polls session status from both the laptop and the phone,
  // so the ceiling has to sit clear of their combined steady-state rate.
  max: env.NODE_ENV === "production" ? 180 : 1000,
  keyGenerator: authenticatedScannerKey,
  message: { success: false, message: "Manifest updates are being requested too quickly." },
  standardHeaders: true,
  legacyHeaders: false
});

// Address lookup reaches paid third-party APIs and is now open to clients, so
// it carries its own cap. Sized for real typing (a debounced field fires a few
// times per address) while stopping a loop from burning the Places quota.
export const addressLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "production" ? 60 : 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many address lookups. Please wait a moment and try again." }
});

// The public rate card link is the one portal surface reachable without a
// session. The token carries 256 bits of entropy so brute force is not the
// threat; this exists so a leaked link cannot be turned into a document-
// generation firehose, since every hit renders a PDF or a workbook.
export const publicRateCardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "production" ? 30 : 300,
  message: { success: false, message: "Too many rate card requests. Please wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Public shipment tracking, capped harder than the rate card above.
 *
 * That limiter can afford 30/min because its link token carries 256 bits of
 * entropy, so nobody guesses their way in. A Swiftline AWB is `SLC` + station +
 * DDMMYY + a three-digit daily counter, which walks in about 999 requests- so
 * here the limiter is the only thing standing between a script and a bulk
 * harvest of every shipment a station booked that day.
 *
 * Two buckets: a burst ceiling for the person tracking three parcels in a row,
 * and an hourly one that a human never reaches but a crawl does within minutes.
 *
 * Caveat worth knowing before this is relied on: express-rate-limit here uses
 * the default in-memory store, so counters are per-process. Behind more than one
 * backend instance the effective ceiling multiplies by the instance count, and a
 * shared store stops being a nicety. What actually makes the endpoint safe to
 * expose is that its payload carries nothing the shipping label does not.
 */
export const publicTrackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "production" ? 15 : 300,
  message: { success: false, message: "Too many tracking requests. Please wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

export const publicTrackingHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 120 : 3000,
  message: { success: false, message: "Too many tracking requests from this network. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false
});

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const passwordLoginLimitMessage = {
  success: false,
  message: "Too many unsuccessful login attempts. Try again in 15 minutes."
};

function requestIp(request: Request) {
  return String(request.ip || request.socket.remoteAddress || "unknown-ip");
}

function normalizedBodyEmail(request: Request) {
  const email = request.body?.email;
  return typeof email === "string" && email.trim()
    ? email.trim().toLowerCase()
    : "missing-email";
}

/**
 * A strict password-login bucket belongs to one attempted account on one
 * network. Office devices commonly share one public NAT IP, so an IP-only key
 * lets one employee's typo block every colleague before their credentials are
 * even checked.
 */
export function passwordLoginAccountKey(request: Request) {
  return `${requestIp(request)}:${normalizedBodyEmail(request)}`;
}

/** Only an invalid-credentials response spends the strict account/IP budget. */
export function isNotInvalidPasswordResponse(statusCode: number) {
  return statusCode !== 401;
}

/**
 * Build fresh limiter instances for tests as well as production. Each call gets
 * its own in-memory stores, so test cases cannot leak counters into one another.
 */
export function createPasswordLoginLimiters(options?: { accountMax?: number; networkMax?: number }) {
  const accountMax = options?.accountMax ?? (env.NODE_ENV === "production" ? 5 : 50);
  const networkMax = options?.networkMax ?? (env.NODE_ENV === "production" ? 50 : 500);

  return {
    // Emergency brake for password spraying across many email addresses. This
    // is intentionally much higher than the account limit so normal shared-
    // office traffic is not collateral damage.
    network: rateLimit({
      windowMs: AUTH_WINDOW_MS,
      max: networkMax,
      message: {
        success: false,
        message: "Unusually high failed-login traffic from this network. Try again in 15 minutes."
      },
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_request, response) => ![401, 423].includes(response.statusCode)
    }),
    account: rateLimit({
      windowMs: AUTH_WINDOW_MS,
      max: accountMax,
      keyGenerator: passwordLoginAccountKey,
      message: passwordLoginLimitMessage,
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      // Captcha/validation failures and backend 5xx responses are not wrong
      // passwords and must not lock a user out because the server had a problem.
      requestWasSuccessful: (_request, response) => isNotInvalidPasswordResponse(response.statusCode)
    })
  };
}

const passwordLoginLimiters = createPasswordLoginLimiters();
export const passwordLoginNetworkLimiter = passwordLoginLimiters.network;
export const passwordLoginAccountLimiter = passwordLoginLimiters.account;

// These authentication actions have different credentials and failure modes;
// they must not share the password-login counter.
export const googleLoginLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: env.NODE_ENV === "production" ? 50 : 500,
  message: { success: false, message: "Too many Google sign-in attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_request, response) => response.statusCode !== 401
});

export const otpVerifyLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: env.NODE_ENV === "production" ? 5 : 50,
  keyGenerator: passwordLoginAccountKey,
  message: { success: false, message: "Too many incorrect sign-in codes. Request a new code and try again." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_request, response) => response.statusCode !== 400
});

export const passwordResetRequestLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: env.NODE_ENV === "production" ? 5 : 50,
  keyGenerator: passwordLoginAccountKey,
  message: { success: false, message: "Too many password-reset requests. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false
});

function passwordResetKey(request: Request) {
  const token = typeof request.body?.token === "string" ? request.body.token : "missing-token";
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return `${requestIp(request)}:${tokenHash}`;
}

export const passwordResetLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: env.NODE_ENV === "production" ? 5 : 50,
  keyGenerator: passwordResetKey,
  message: { success: false, message: "Too many password-reset attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_request, response) => response.statusCode !== 400
});

// Requesting a sign-in code needs its own cap, and it must count *successful*
// requests too. The endpoint answers 200 whether or not the address has an
// account- deliberately, so it cannot be used to enumerate clients- which
// means `skipSuccessfulRequests` would leave it effectively uncapped and turn it
// into a way to mail-bomb any address. Sized for a shared office IP where a few
// people sign in around the same time; flooding a single mailbox is held off
// separately by the per-account resend cooldown, which no IP can get around.
export const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 10 : 100,
  message: { success: false, message: "Too many sign-in code requests. Wait a few minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

function publicBusinessAccountKey(request: Request) {
  const email = typeof request.body?.email === "string" ? request.body?.email.trim().toLowerCase() : normalizedBodyEmail(request);
  return `${requestIp(request)}:${email}`;
}

export const publicBusinessAccountLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "production" ? 20 : 300,
  message: { success: false, message: "Too many business account requests. Please wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

export const publicBusinessAccountHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 60 : 1000,
  message: { success: false, message: "Too many business account requests from this network. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false
});

export const publicBusinessAccountCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 5 : 100,
  keyGenerator: publicBusinessAccountKey,
  message: { success: false, message: "Too many business account submissions. Please wait a few minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

export const publicEmailOtpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 5 : 100,
  keyGenerator: publicBusinessAccountKey,
  message: { success: false, message: "Too many verification code requests. Please wait a few minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false
});

export const publicEmailOtpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 10 : 100,
  keyGenerator: publicBusinessAccountKey,
  message: { success: false, message: "Too many verification attempts. Please request a new code." },
  standardHeaders: true,
  legacyHeaders: false
});

export const publicShipmentBookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "production" ? 45 : 500,
  message: { success: false, message: "Too many booking requests. Please wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

export const publicShipmentPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === "production" ? 10 : 200,
  message: { success: false, message: "Too many payment attempts. Please wait before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});
