import { apiUrl } from "@/lib/api";

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Why the session ended, when the server ended it rather than the user.
 *
 * Held here so the login screen can explain the bounce- "signed in on another
 * device" reads very differently from an unexplained trip back to the login
 * form, which users report as the app logging them out at random.
 */
let sessionEndedReason: string | null = null;

export function setSessionEndedReason(reason: string | null) {
  sessionEndedReason = reason;
}

// Reading it clears it: the reason explains one bounce, and must not reappear
// on the next visit to the login screen.
export function takeSessionEndedReason() {
  const reason = sessionEndedReason;
  sessionEndedReason = null;

  return reason;
}

export class AuthRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

/** A server-side session termination, distinct from an ordinary expired token. */
export class SessionEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEndedError";
  }
}

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export async function readJsonSafely(response: Response): Promise<Record<string, unknown>> {
  // Rate limiters and proxies answer with plain text or HTML. Callers must never
  // let that parse failure look like a rejected session.
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function requestRefreshedAccessToken() {
  try {
    const response = await fetch(apiUrl("/api/v1/auth/refresh"), {
      method: "POST",
      credentials: "include"
    });

    const data = await readJsonSafely(response);
    if (response.ok && data.success && typeof data.accessToken === "string") {
      setAccessToken(data.accessToken);
      setSessionEndedReason(null);
      return data.accessToken;
    }

    // A session ended elsewhere- signed in on another device, terminated by an
    // admin, or gone idle. The user needs to be told why, otherwise being
    // bounced to the login screen looks like a bug.
    if (data.sessionEnded && typeof data.message === "string") {
      setAccessToken(null);
      setSessionEndedReason(data.message);
      throw new SessionEndedError(data.message);
    }

    // Only a rejected refresh cookie means the session is gone. Throttling,
    // server faults, and offline devices must keep the current token usable.
    if (response.status === 401 || response.status === 403) setAccessToken(null);
    return null;
  } catch (error) {
    // Callers must see the server's reason. Returning null here made request
    // helpers fall back to the original generic 401 response instead.
    if (error instanceof SessionEndedError) throw error;
    return null;
  }
}

export async function refreshAccessToken() {
  // A dashboard page mount can trigger several parallel refreshes. Sharing one
  // request stops them rotating the cookie against each other.
  refreshInFlight ??= requestRefreshedAccessToken().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function logout() {
  try {
    await fetch(apiUrl("/api/v1/auth/logout"), {
      method: "POST",
      credentials: "include"
    });
  } catch {
    // ignore network failures during logout
  } finally {
    setAccessToken(null);
  }
}

async function parseAuthResponse<T>(response: Response): Promise<T> {
  const data = await readJsonSafely(response) as {
    success?: boolean;
    message?: string;
    code?: unknown;
    retryable?: unknown;
    errors?: unknown;
  };

  if (!response.ok || !data.success) {
    const formattedError = findFirstApiError(data.errors);
    throw new AuthRequestError(
      data.message || formattedError || "Authentication request failed",
      response.status,
      typeof data.code === "string" ? data.code : undefined,
      data.retryable === true
    );
  }

  return data as T;
}

export async function loginWithPassword(input: {
  email: string;
  password: string;
  termsAccepted: true;
  recaptchaToken?: string;
}) {
  const response = await fetch(apiUrl("/api/v1/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input)
  });

  return parseAuthResponse<LoginResult>(response);
}

function findFirstApiError(value: unknown): string {
  if (!value || typeof value !== "object") return "";

  const errors = (value as { _errors?: unknown })._errors;
  if (Array.isArray(errors) && typeof errors[0] === "string") return errors[0];

  for (const nested of Object.values(value)) {
    const message = findFirstApiError(nested);
    if (message) return message;
  }

  return "";
}

export type LoginResult = {
  success: true;
  accessToken: string;
  user: { id: string; email: string; role: string; name?: string; userStatus: string; hasSeenWelcome: boolean };
};

/** Exchanges a Google Identity Services ID token for the portal's own access/refresh tokens. */
export async function loginWithGoogle(credential: string) {
  const response = await fetch(apiUrl("/api/v1/auth/login/google"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ credential })
  });

  return parseAuthResponse<LoginResult>(response);
}

/**
 * Asks for an email sign-in code.
 *
 * Resolves the same way whether or not the address has an account- the server
 * will not say, so that the sign-in form cannot be used to test which addresses
 * are registered. The caller must move to the code screen regardless.
 */
export async function requestLoginOtp(input: { email: string; recaptchaToken?: string }) {
  const response = await fetch(apiUrl("/api/v1/auth/login/otp/request"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, termsAccepted: true })
  });

  return parseAuthResponse<{
    success: true;
    message: string;
    expiresInSeconds: number;
    resendInSeconds: number;
  }>(response);
}

export async function verifyLoginOtp(input: { email: string; code: string }) {
  const response = await fetch(apiUrl("/api/v1/auth/login/otp/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ ...input, termsAccepted: true })
  });

  return parseAuthResponse<LoginResult>(response);
}

export async function getInvitation(token: string) {
  const response = await fetch(apiUrl(`/api/v1/auth/invitations/${encodeURIComponent(token)}`));

  return parseAuthResponse<{
    success: true;
    invitation: {
      email: string;
      name: string;
      businessAccountId: string;
      companyName: string;
      expiresAt: string;
    };
  }>(response);
}

export async function activateInvitation(input: {
  token: string;
  password: string;
  confirmPassword: string;
  termsAccepted: boolean;
}) {
  const response = await fetch(apiUrl("/api/v1/auth/activate-invitation"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseAuthResponse<{ success: true; message: string }>(response);
}

export async function requestPasswordReset(email: string) {
  const response = await fetch(apiUrl("/api/v1/auth/forgot-password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });

  return parseAuthResponse<{ success: true; message: string }>(response);
}

export async function resetPassword(input: {
  token: string;
  password: string;
  confirmPassword: string;
}) {
  const response = await fetch(apiUrl("/api/v1/auth/reset-password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseAuthResponse<{ success: true; message: string }>(response);
}
