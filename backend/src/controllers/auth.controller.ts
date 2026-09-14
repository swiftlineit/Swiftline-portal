import { Request, Response } from "express";
import dns from "node:dns";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import { IUser, User } from "../models/user.model.js";
import { comparePassword, createAccessToken, createRefreshToken, hashPassword } from "../services/auth.service.js";
import { verifyRecaptcha } from "../services/recaptcha.service.js";
import { env } from "../config/env.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccountInvitation } from "../models/businessAccountInvitation.model.js";
import { DriverInvitation } from "../models/driverInvitation.model.js";
import { DriverProfile } from "../models/driverProfile.model.js";
import { hashDriverInvitationToken } from "../services/driverInvitation.service.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { sendLoginOtpEmail, sendPasswordResetEmail } from "../services/mail.service.js";
import { normalizePortalRole } from "../utils/portalRole.js";
import mongoose from "mongoose";
import { accountNotActiveMessage, endSessions, startSession, touchSession, verifySession } from "../services/userSession.service.js";
import {
  passwordLockDetails,
  recordFailedPasswordAttempt,
  recordSuccessfulPasswordLogin
} from "../services/authLockout.service.js";

// The refresh token's lifetime, which is how long a session can survive before
// the token behind it lapses anyway. Parsed from the same env value that signs
// it so the two cannot drift apart.
function refreshTokenTtlMs() {
  const value = env.REFRESH_TOKEN_EXPIRES_IN.trim();
  const match = /^(\d+)([smhd])$/.exec(value);

  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const amount = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];

  return amount * unitMs;
}

const googleClient = env.GOOGLE_OAUTH_CLIENT_ID ? new OAuth2Client(env.GOOGLE_OAUTH_CLIENT_ID) : null;

/**
 * Whether an email points at a domain that actually exists. Rejects typos like
 * `gmail.cos` that format checks accept. Uses the OS resolver (`lookup`) rather
 * than c-ares (`resolveMx`) because the OS path honors hosts-file overrides and
 * works in environments where c-ares can't reach the configured DNS server.
 * Results are cached so repeated sign-in attempts don't hit DNS on every request.
 * The check only exposes whether a domain is registered- public information-
 * so it doesn't weaken the enumeration resistance of the login endpoints.
 */
const EMAIL_DOMAIN_CHECK_ENABLED = env.EMAIL_DOMAIN_CHECK;
const EMAIL_DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000;
const emailDomainCache = new Map<string, { ok: boolean; checkedAt: number }>();

async function emailDomainExists(email: string): Promise<boolean> {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  if (!domain || !domain.includes(".")) return false;

  if (!EMAIL_DOMAIN_CHECK_ENABLED) return true;

  const cached = emailDomainCache.get(domain);
  if (cached && Date.now() - cached.checkedAt < EMAIL_DOMAIN_CACHE_TTL_MS) return cached.ok;

  let ok = false;
  try {
    await dns.promises.lookup(domain);
    ok = true;
  } catch {
    ok = false;
  }

  emailDomainCache.set(domain, { ok, checkedAt: Date.now() });
  return ok;
}

const invalidEmailMessage = "Please enter a valid email address.";

const captchaFailure = {
  success: false,
  code: "CAPTCHA_FAILED",
  retryable: true,
  message: "We could not complete the security check. Refresh the page and try again."
};

// Same message for "no such user", "invited but not activated", and "suspended/disabled"
// so a failed Google sign-in can't be used to probe which emails exist in the system.
const GOOGLE_LOGIN_GENERIC_ERROR = "Unable to sign in with Google for this account. Use your password, or contact your administrator.";

// Cross-site delivery (frontend and API on different HTTPS origins, e.g. devtunnels)
// requires SameSite=None; Secure, or the browser drops the refresh cookie. Same-origin
// / localhost keeps the stricter Lax cookie.
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.CROSS_SITE_COOKIES || env.NODE_ENV === "production",
  sameSite: (env.CROSS_SITE_COOKIES ? "none" : "lax") as "none" | "lax",
  maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
});

const loginSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(6),
  termsAccepted: z.boolean().refine((v) => v === true, { message: "Terms must be accepted" }),
  recaptchaToken: z.string().optional()
});
const googleLoginSchema = z.object({
  credential: z.string().trim().min(20)
});
const activationSchema = z.object({
  token: z.string().trim().min(20),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128),
  termsAccepted: z.boolean().refine((value) => value === true, { message: "Terms must be accepted" })
}).superRefine((data, context) => {
  if (data.password !== data.confirmPassword) {
    context.addIssue({
      code: "custom",
      path: ["confirmPassword"],
      message: "Passwords do not match"
    });
  }
});
const forgotPasswordSchema = z.object({
  email: z.string().trim().email().toLowerCase()
});
const resetPasswordSchema = z.object({
  token: z.string().trim().min(20),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128)
}).superRefine((data, context) => {
  if (data.password !== data.confirmPassword) {
    context.addIssue({
      code: "custom",
      path: ["confirmPassword"],
      message: "Passwords do not match"
    });
  }
});

const passwordResetResponse = {
  success: true,
  message: "If an active account exists for this email, a reset link has been sent."
};

/** Email sign-in codes. Digits only- the code is retyped off a phone screen. */
const LOGIN_OTP_TTL_MS = 10 * 60 * 1000;
/** Per-account send throttle, mirrored by the countdown on the sign-in screen. */
const LOGIN_OTP_RESEND_INTERVAL_MS = 60 * 1000;
/** Guesses allowed against one code. 6 digits would otherwise permit a million. */
const LOGIN_OTP_MAX_ATTEMPTS = 5;

const requestLoginOtpSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  termsAccepted: z.boolean().refine((value) => value === true, { message: "Terms must be accepted" }),
  recaptchaToken: z.string().optional()
});
const verifyLoginOtpSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your email"),
  termsAccepted: z.boolean().refine((value) => value === true, { message: "Terms must be accepted" })
});

/**
 * Answered whether or not the address has an account, and whether or not a code
 * was actually sent. Telling the difference would turn the sign-in form into a
 * way to test which of your clients' addresses are registered.
 */
const loginOtpRequestResponse = {
  success: true,
  message: "If an active account exists for this email, a sign-in code has been sent.",
  // Both are fixed policy, not account state, so returning them leaks nothing and
  // saves the frontend from hard-coding a second copy of the same numbers.
  expiresInSeconds: LOGIN_OTP_TTL_MS / 1000,
  resendInSeconds: LOGIN_OTP_RESEND_INTERVAL_MS / 1000
};

// One message for every rejection- wrong code, expired code, no code
// outstanding, attempts exhausted, unknown address- for the same reason.
const LOGIN_OTP_GENERIC_ERROR = "This sign-in code is invalid or has expired. Request a new one.";

// Bound to the address as well as the code, so a code minted for one account can
// never be replayed against another.
function hashLoginOtp(email: string, code: string) {
  return crypto.createHash("sha256").update(`${email.toLowerCase()}:${code}`).digest("hex");
}

function generateLoginOtp() {
  // randomInt is uniform over the range, so zero-padding does not bias the
  // leading digit the way `Math.random()` slices would.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function loginOtpMatches(email: string, code: string, storedHash: string) {
  const provided = Buffer.from(hashLoginOtp(email, code), "hex");
  const stored = Buffer.from(storedHash, "hex");

  return provided.length === stored.length && crypto.timingSafeEqual(provided, stored);
}

function clearLoginOtp(user: IUser) {
  user.loginOtpHash = "";
  user.loginOtpExpiresAt = null;
  user.loginOtpAttempts = 0;
}

/** An account that may sign in right now, by any method. */
function canSignIn(user: IUser | null): user is IUser {
  if (!user) return false;
  if ((user.userStatus ?? "active") !== "active") return false;
  if (user.lockedUntil && user.lockedUntil > new Date()) return false;

  return true;
}

/**
 * Finishes a successful sign-in- password, Google or email code- by opening a
 * session and issuing the token pair. Shared so the three entry points cannot
 * drift apart on cookie flags, session handling, or the response shape the
 * frontend reads.
 */
async function issueSignedInResponse(req: Request, res: Response, user: IUser): Promise<Response> {
  const role = normalizePortalRole(user.role);
  if (user.role !== role) {
    user.role = role;
    await User.updateOne({ _id: user._id }, { $set: { role } }).exec();
  }

  // Internal accounts remain newest-login-wins. Client accounts may use more
  // than one device, while every session is still independently revocable.
  const sessionId = await startSession(
    user._id as mongoose.Types.ObjectId,
    req,
    refreshTokenTtlMs(),
    role
  );
  const accessToken = createAccessToken({ id: String(user._id), role, email: user.email }, sessionId);
  const refreshToken = createRefreshToken({ id: String(user._id), role, email: user.email }, sessionId);

  // set httpOnly secure cookie for refresh token
  res.cookie("refreshToken", refreshToken, refreshCookieOptions());

  return res.status(200).json({
    success: true,
    accessToken,
    user: {
      id: user._id,
      email: user.email,
      role,
      name: user.name,
      userStatus: user.userStatus ?? "active",
      hasSeenWelcome: user.hasSeenWelcome
    }
  });
}

function lockedPasswordResponse(res: Response, lockedUntil: Date): Response {
  const details = passwordLockDetails(lockedUntil);
  res.setHeader("Retry-After", String(details.retryAfterSeconds));

  return res.status(423).json({
    success: false,
    message: details.message,
    retryAfterSeconds: details.retryAfterSeconds,
    lockedUntil: lockedUntil.toISOString()
  });
}

function hashInvitationToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPasswordResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildPasswordResetUrl(token: string) {
  const url = new URL("/auth/reset-password", env.CLIENT_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

async function findUsableInvitation(token: string) {
  const invitation = await BusinessAccountInvitation.findOne({ tokenHash: hashInvitationToken(token) })
    .populate("user", "email firstName lastName name userStatus")
    .populate("businessAccount", "accountId company.companyName")
    .exec();

  if (invitation) {
    if (invitation.revokedAt) return { kind: null, invitation: null, message: "This invitation has been revoked." };
    if (invitation.acceptedAt) return { kind: null, invitation: null, message: "This invitation has already been accepted." };
    if (invitation.expiresAt <= new Date()) return { kind: null, invitation: null, message: "This invitation has expired." };
    return { kind: "BUSINESS" as const, invitation, message: "" };
  }

  const driverInvitation = await DriverInvitation.findOne({ tokenHash: hashDriverInvitationToken(token) })
    .populate("userId", "email firstName lastName name userStatus")
    .populate("driverProfileId", "deliverySubrole engagementType status")
    .exec();
  if (!driverInvitation) return { kind: null, invitation: null, message: "Invalid invitation link." };
  if (driverInvitation.revokedAt) return { kind: null, invitation: null, message: "This invitation has been revoked." };
  if (driverInvitation.acceptedAt) return { kind: null, invitation: null, message: "This invitation has already been accepted." };
  if (driverInvitation.expiresAt <= new Date()) return { kind: null, invitation: null, message: "This invitation has expired." };
  return { kind: "DRIVER" as const, invitation: driverInvitation, message: "" };
}

export async function login(req: Request, res: Response): Promise<Response> {
  const parse = loginSchema.safeParse(req.body);

  if (!parse.success) {
    return res.status(400).json({ success: false, errors: parse.error.format() });
  }

  const { email, password, recaptchaToken } = parse.data;

  if (!await emailDomainExists(email)) {
    return res.status(400).json({ success: false, message: invalidEmailMessage });
  }

  if (!await verifyRecaptcha(recaptchaToken, req.ip)) {
    return res.status(400).json(captchaFailure);
  }

  const user = await User.findOne({ email }).exec();

  if (!user) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  const userStatus = user.userStatus ?? "active";
  if (userStatus === "invited" || !user.passwordHash) {
    return res.status(403).json({ success: false, message: "Please activate your account before logging in." });
  }

  if (userStatus === "suspended" || userStatus === "disabled") {
    return res.status(403).json({ success: false, message: "This user login is not active." });
  }

  // check lockout
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return lockedPasswordResponse(res, user.lockedUntil);
  }

  const match = await comparePassword(password, user.passwordHash);

  if (!match) {
    const lockedUntil = await recordFailedPasswordAttempt(user._id as mongoose.Types.ObjectId);
    if (lockedUntil) return lockedPasswordResponse(res, lockedUntil);

    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  await recordSuccessfulPasswordLogin(user._id as mongoose.Types.ObjectId);

  return issueSignedInResponse(req, res, user);
}

/**
 * "Sign in with Google" for an EXISTING user only - it never creates a new account.
 * A verified Google email is auto-linked (googleId set) to a matching active user on
 * first use; invited/suspended/disabled/not-found accounts all get the same generic
 * error so the response can't be used to enumerate which emails have accounts.
 */
export async function loginWithGoogle(req: Request, res: Response): Promise<Response> {
  if (!googleClient || !env.GOOGLE_OAUTH_CLIENT_ID) {
    return res.status(503).json({ success: false, message: "Google sign-in is not configured." });
  }

  const parsed = googleLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.format() });
  }

  let googleEmail: string;
  let googleSub: string;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parsed.data.credential,
      audience: env.GOOGLE_OAUTH_CLIENT_ID
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified || !payload.sub) {
      return res.status(401).json({ success: false, message: GOOGLE_LOGIN_GENERIC_ERROR });
    }
    googleEmail = payload.email.toLowerCase();
    googleSub = payload.sub;
  } catch {
    return res.status(401).json({ success: false, message: GOOGLE_LOGIN_GENERIC_ERROR });
  }

  // A user already linked to this Google account can sign in directly; otherwise
  // fall back to matching by email so a first-time Google sign-in can be linked below.
  let user = await User.findOne({ googleId: googleSub }).exec();
  const alreadyLinked = Boolean(user);
  if (!user) user = await User.findOne({ email: googleEmail }).exec();

  // Reject (same generic message either way): no matching account, the account
  // isn't active yet (invited/suspended/disabled), or the email already belongs
  // to a DIFFERENT linked Google account than the one signing in right now.
  if (!user || user.userStatus !== "active" || (!alreadyLinked && user.googleId)) {
    return res.status(401).json({ success: false, message: GOOGLE_LOGIN_GENERIC_ERROR });
  }

  if (user.googleId !== googleSub) {
    const userId = user._id;
    // Atomic + still guarded by the unique index, so a concurrent link attempt
    // (from this same request racing itself, or a stale duplicate) can't corrupt state.
    try {
      const linked = await User.findOneAndUpdate(
        { _id: userId, googleId: null },
        { $set: { googleId: googleSub } },
        { new: true }
      ).exec();
      user = linked ?? await User.findById(userId).exec();
    } catch {
      // Duplicate-key on googleId means another user already claimed this Google
      // account - re-read rather than fail so a benign race doesn't 500.
      user = await User.findById(userId).exec();
    }
    if (!user || user.googleId !== googleSub) {
      return res.status(401).json({ success: false, message: GOOGLE_LOGIN_GENERIC_ERROR });
    }
    await AuditLog.create({
      action: "USER_GOOGLE_LOGIN_LINKED",
      entityType: "USER",
      entityId: user._id,
      performedBy: user._id,
      performedAt: new Date(),
      metadata: { email: user.email }
    });
  }

  user.lastLogin = new Date();
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  return issueSignedInResponse(req, res, user);
}

/**
 * Step one of email sign-in: mint a single-use code and mail it.
 *
 * Always answers with the same neutral 200. An account that does not exist, is
 * not activated, is suspended, or is inside its resend cooldown is silently
 * given nothing- the caller cannot tell those apart from a delivered code, so
 * this endpoint cannot be used to work out which addresses hold portal accounts.
 */
export async function requestLoginOtp(req: Request, res: Response): Promise<Response> {
  const parsed = requestLoginOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const { email } = parsed.data;
  if (!await emailDomainExists(email)) {
    return res.status(400).json({ success: false, message: invalidEmailMessage });
  }

  if (!await verifyRecaptcha(parsed.data.recaptchaToken, req.ip)) {
    return res.status(400).json(captchaFailure);
  }

  const user = await User.findOne({ email })
    .select("+loginOtpHash +loginOtpExpiresAt +loginOtpAttempts +loginOtpSentAt")
    .exec();

  // An invited user has not set a password yet and must come in through their
  // activation link, which is what proves they control the mailbox in the first
  // place- a sign-in code would let them skip that.
  if (!canSignIn(user) || !user.passwordHash) {
    return res.status(200).json(loginOtpRequestResponse);
  }

  const sentAt = user.loginOtpSentAt;
  if (sentAt && Date.now() - sentAt.getTime() < LOGIN_OTP_RESEND_INTERVAL_MS) {
    return res.status(200).json(loginOtpRequestResponse);
  }

  const code = generateLoginOtp();
  const expiresAt = new Date(Date.now() + LOGIN_OTP_TTL_MS);

  // Issuing a new code retires the previous one, including its spent attempts-
  // otherwise a resend would inherit an exhausted counter and fail on arrival.
  user.loginOtpHash = hashLoginOtp(email, code);
  user.loginOtpExpiresAt = expiresAt;
  user.loginOtpAttempts = 0;
  user.loginOtpSentAt = new Date();
  await user.save();

  try {
    await sendLoginOtpEmail({
      to: user.email,
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      code,
      expiresAt
    });
  } catch (error) {
    // The stored code stays put: a transport hiccup should not invalidate a code
    // that may still have reached the mailbox.
    console.error("Login OTP email could not be sent.", {
      email: user.email,
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }

  return res.status(200).json(loginOtpRequestResponse);
}

/** Step two of email sign-in: exchange a valid code for a session. */
export async function verifyLoginOtp(req: Request, res: Response): Promise<Response> {
  const parsed = verifyLoginOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const { email, code } = parsed.data;
  const user = await User.findOne({ email })
    .select("+loginOtpHash +loginOtpExpiresAt +loginOtpAttempts +loginOtpSentAt")
    .exec();

  // Re-checked here rather than trusted from the request step: an account can be
  // suspended or locked in the ten minutes a code stays live.
  if (!canSignIn(user) || !user.loginOtpHash || !user.loginOtpExpiresAt) {
    return res.status(400).json({ success: false, message: LOGIN_OTP_GENERIC_ERROR });
  }

  if (user.loginOtpExpiresAt <= new Date() || (user.loginOtpAttempts ?? 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
    clearLoginOtp(user);
    await user.save();

    return res.status(400).json({ success: false, message: LOGIN_OTP_GENERIC_ERROR });
  }

  if (!loginOtpMatches(email, code, user.loginOtpHash)) {
    user.loginOtpAttempts = (user.loginOtpAttempts ?? 0) + 1;
    // Burning the code on the last guess stops an attacker from getting a fresh
    // five tries by simply not asking for a new one.
    if (user.loginOtpAttempts >= LOGIN_OTP_MAX_ATTEMPTS) clearLoginOtp(user);
    await user.save();

    return res.status(400).json({ success: false, message: LOGIN_OTP_GENERIC_ERROR });
  }

  // Single use: the code is spent whether or not the rest of this succeeds.
  clearLoginOtp(user);
  user.loginOtpSentAt = null;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLogin = new Date();
  // Reading the code off the mailbox is proof they control it, which is the same
  // thing the activation and reset links establish.
  user.isVerified = true;
  user.emailVerifiedAt = user.emailVerifiedAt ?? new Date();
  await user.save();

  await AuditLog.create({
    action: "USER_LOGIN_OTP_VERIFIED",
    entityType: "USER",
    entityId: user._id,
    performedBy: user._id,
    performedAt: new Date(),
    metadata: { email: user.email }
  });

  return issueSignedInResponse(req, res, user);
}

export async function logout(req: Request, res: Response): Promise<Response> {
  // End the session server-side as well as clearing the cookie, so the access
  // token still in the browser's memory stops working immediately rather than
  // lingering until it expires.
  try {
    const token = req.cookies?.refreshToken;

    if (token) {
      const payload = jwt.verify(token, env.JWT_SECRET) as { sid?: string };
      if (payload.sid) await endSessions({ sessionId: payload.sid }, "logout");
    }
  } catch {
    // An unreadable cookie still gets cleared below; there is nothing to end.
  }

  // Clearing must use the same sameSite/secure flags the cookie was set with.
  const { maxAge: _maxAge, ...clearOptions } = refreshCookieOptions();
  res.clearCookie("refreshToken", clearOptions);
  return res.status(200).json({ success: true });
}

export async function me(req: Request, res: Response): Promise<Response> {
  // `attachUser` middleware should have populated req.user
  // but keep a safe fallback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (req as any).user;

  if (!user) return res.status(401).json({ success: false });

  return res.status(200).json({ success: true, user });
}

export async function markWelcomeSeen(req: Request, res: Response): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (req as any).user;

  if (!user) return res.status(401).json({ success: false });

  await User.findByIdAndUpdate(user._id, { hasSeenWelcome: true }).exec();

  return res.status(200).json({ success: true });
}

export async function refresh(req: Request, res: Response): Promise<Response> {
  try {
    const token = req.cookies?.refreshToken;

    if (!token) return res.status(401).json({ success: false });

    // verify
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = jwt.verify(token, env.JWT_SECRET);

    const user = await User.findById(payload.sub).exec();

    if (!user) return res.status(401).json({ success: false });

    // Rotation must not outlive the account. This endpoint hands out a new
    // access token and a new seven-day refresh cookie, so skipping the status
    // check here would let a suspended login renew itself indefinitely.
    if ((user.userStatus ?? "active") !== "active") {
      return res.status(401).json({ success: false, message: accountNotActiveMessage, sessionEnded: true });
    }

    const role = normalizePortalRole(user.role);
    if (user.role !== role) {
      user.role = role;
      await user.save();
    }
    // Rotating tokens must not open a new session, or every refresh would
    // supersede the device doing the refreshing.
    const sessionCheck = await verifySession(payload.sid);
    if (!sessionCheck.ok) return res.status(401).json({ success: false, message: sessionCheck.message, sessionEnded: true });
    await touchSession(payload.sid);

    const accessToken = createAccessToken({ id: String(user._id), role, email: user.email }, payload.sid);
    const refreshToken = createRefreshToken({ id: String(user._id), role, email: user.email }, payload.sid);

    res.cookie("refreshToken", refreshToken, refreshCookieOptions());

    return res.status(200).json({ success: true, accessToken });
  } catch (error) {
    return res.status(401).json({ success: false });
  }
}

export async function requestPasswordReset(req: Request, res: Response): Promise<Response> {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const user = await User.findOne({ email: parsed.data.email })
    .select("+passwordResetTokenHash +passwordResetExpiresAt")
    .exec();

  const userStatus = user?.userStatus ?? "active";
  if (!user || !user.passwordHash || userStatus === "invited" || userStatus === "suspended" || userStatus === "disabled") {
    return res.status(200).json(passwordResetResponse);
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  user.passwordResetTokenHash = hashPasswordResetToken(token);
  user.passwordResetExpiresAt = expiresAt;
  await user.save();

  try {
    await sendPasswordResetEmail({
      to: user.email,
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      resetUrl: buildPasswordResetUrl(token),
      expiresAt
    });
  } catch (error) {
    console.error("Password reset email could not be sent.", {
      email: user.email,
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }

  return res.status(200).json(passwordResetResponse);
}

export async function resetPassword(req: Request, res: Response): Promise<Response> {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const tokenHash = hashPasswordResetToken(parsed.data.token);
  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpiresAt: { $gt: new Date() }
  })
    .select("+passwordResetTokenHash +passwordResetExpiresAt")
    .exec();

  if (!user) {
    return res.status(400).json({ success: false, message: "This reset link is invalid or has expired." });
  }

  const userStatus = user.userStatus ?? "active";
  if (userStatus === "suspended" || userStatus === "disabled") {
    return res.status(403).json({ success: false, message: "This user login is not active." });
  }

  user.passwordHash = await hashPassword(parsed.data.password);
  user.passwordResetTokenHash = "";
  user.passwordResetExpiresAt = null;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.userStatus = "active";
  user.isVerified = true;
  user.emailVerifiedAt = user.emailVerifiedAt ?? new Date();
  await user.save();

  return res.status(200).json({ success: true, message: "Password reset successfully. You can now sign in." });
}

export async function getInvitation(req: Request, res: Response): Promise<Response> {
  const token = typeof req.params.token === "string" ? req.params.token : "";
  if (!token) return res.status(400).json({ success: false, message: "Invitation token is required." });

  const { kind, invitation, message } = await findUsableInvitation(token);
  if (!invitation) return res.status(400).json({ success: false, message });

  if (kind === "DRIVER") {
    const user = invitation.userId as unknown as { email?: string; firstName?: string; lastName?: string; name?: string };
    const profile = invitation.driverProfileId as unknown as { deliverySubrole?: string; engagementType?: string };
    return res.status(200).json({
      success: true,
      invitation: {
        kind: "DRIVER",
        email: user.email ?? "",
        name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
        deliverySubrole: profile.deliverySubrole ?? "DRIVER",
        engagementType: profile.engagementType ?? "DIRECT_CONTRACTOR",
        expiresAt: invitation.expiresAt
      }
    });
  }

  const user = invitation.user as unknown as { email?: string; firstName?: string; lastName?: string; name?: string };
  const account = invitation.businessAccount as unknown as { accountId?: string; company?: { companyName?: string } };

  return res.status(200).json({
    success: true,
    invitation: {
      email: user.email ?? "",
      kind: "BUSINESS",
      name: user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
      businessAccountId: account.accountId ?? "",
      companyName: account.company?.companyName ?? "",
      expiresAt: invitation.expiresAt
    }
  });
}

export async function activateInvitation(req: Request, res: Response): Promise<Response> {
  const parsed = activationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.format() });
  }

  const { kind, invitation, message } = await findUsableInvitation(parsed.data.token);
  if (!invitation) return res.status(400).json({ success: false, message });

  if (kind === "DRIVER") {
    const user = await User.findById(invitation.userId).exec();
    const profile = await DriverProfile.findById(invitation.driverProfileId).exec();
    if (!user || !profile || !(["INVITED", "PENDING_APPROVAL"] as string[]).includes(profile.status)) {
      return res.status(400).json({ success: false, message: "Driver invitation access is no longer valid." });
    }
    const now = new Date();
    user.passwordHash = await hashPassword(parsed.data.password);
    user.userStatus = "active";
    user.isVerified = true;
    user.emailVerifiedAt = now;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    profile.status = "PENDING_APPROVAL";
    invitation.acceptedAt = now;
    await Promise.all([user.save(), profile.save(), invitation.save()]);
    return res.status(200).json({ success: true, message: "Driver account activated. Swiftline approval is required before pickups can be assigned." });
  }

  const user = await User.findById(invitation.user).exec();
  const member = await BusinessAccountMember.findById(invitation.member).exec();

  if (!user || !member || member.status === "removed") {
    return res.status(400).json({ success: false, message: "Invitation access record is no longer valid." });
  }

  const conflictingMembership = await BusinessAccountMember.exists({
    _id: { $ne: member._id },
    user: user._id,
    status: { $in: ["invited", "active", "suspended"] }
  }).exec();
  if (conflictingMembership) {
    return res.status(409).json({
      success: false,
      code: "USER_ALREADY_ASSIGNED",
      message: "This user already belongs to another business account. Restore the existing access instead."
    });
  }

  const now = new Date();
  user.passwordHash = await hashPassword(parsed.data.password);
  user.userStatus = "active";
  user.isVerified = true;
  user.emailVerifiedAt = now;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  member.status = "active";
  member.joinedAt = now;
  invitation.acceptedAt = now;

  await Promise.all([
    user.save(),
    member.save(),
    invitation.save()
  ]);

  return res.status(200).json({ success: true, message: "Account activated successfully." });
}
