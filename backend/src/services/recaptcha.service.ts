import { env } from "../config/env.js";

type SiteverifyResponse = {
  success: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
};

/**
 * Verifies a reCAPTCHA v3 token against Google's siteverify endpoint.
 *
 * Fails open: if RECAPTCHA_SECRET_KEY isn't configured, or siteverify itself
 * errors/times out, the login is allowed through (logged, not blocked) - a
 * Google-side outage shouldn't lock every user out of the portal. The score
 * cutoff is only enforced when siteverify actually answers.
 */
export async function verifyRecaptcha(token: string | undefined, remoteIp?: string, options: { failOpen?: boolean } = {}): Promise<boolean> {
  const failOpen = options.failOpen ?? true;
  if (!isRecaptchaEnabled()) return true;
  if (!env.RECAPTCHA_SECRET_KEY) return failOpen;
  if (!token) {
    console.warn(`reCAPTCHA token missing; ${failOpen ? "allowing through" : "blocking request"}.`);
    return failOpen;
  }

  try {
    const params = new URLSearchParams({ secret: env.RECAPTCHA_SECRET_KEY, response: token });
    if (remoteIp) params.set("remoteip", remoteIp);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let result: SiteverifyResponse;
    try {
      const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal
      });
      result = await response.json() as SiteverifyResponse;

      if (!response.ok) {
        console.warn("reCAPTCHA siteverify returned a non-success HTTP status.", {
          httpStatus: response.status,
          errors: result["error-codes"]
        });
        return false;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!result.success) {
      console.warn("reCAPTCHA verification failed.", {
        errors: result["error-codes"],
        action: result.action,
        hostname: result.hostname
      });
      return false;
    }
    if (typeof result.score === "number" && result.score < env.RECAPTCHA_MIN_SCORE) {
      console.warn("reCAPTCHA score below threshold.", {
        score: result.score,
        minimumScore: env.RECAPTCHA_MIN_SCORE,
        action: result.action,
        hostname: result.hostname
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error(`reCAPTCHA siteverify request failed; ${failOpen ? "allowing request" : "blocking request"}.`, {
      message: error instanceof Error ? error.message : "Unknown error"
    });
    return failOpen;
  }
}

export function isRecaptchaEnabled() {
  return env.RECAPTCHA_ENABLED ?? env.NODE_ENV === "production";
}
