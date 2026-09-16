import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return value;
}, z.boolean());

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(5000),

  CLIENT_URL: z.string().url(),
  CORS_ORIGINS: z.string().optional(),
  // Set true when the frontend and API are served from different origins over HTTPS
  // (e.g. two devtunnel subdomains), so the refresh cookie uses SameSite=None; Secure.
  CROSS_SITE_COOKIES: booleanFromEnv.default(false),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required for signing tokens"),
  ACCESS_TOKEN_EXPIRES_IN: z.string().default("15m"),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default("7d"),
  // Off by default: sessions are tracked and audited either way. When enabled,
  // internal accounts are newest-login-wins; client accounts remain multi-device.
  SINGLE_SESSION_ENFORCED: booleanFromEnv.default(false),
  // Always enforced server-side as a backstop to the browser's visible timeout.
  // Must stay above the browser's 35-minute warning plus 1-minute countdown.
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(36),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  // Selects the outbound transport. "ses" in production, "smtp" for a local
  // Mailhog, "noop" for tests and for any environment that must never send.
  MAIL_DRIVER: z.enum(["ses", "smtp", "noop"]).default("smtp"),
  MAIL_REPLY_TO: z.string().optional(),
  // Outside production the dispatcher refuses to deliver to anything not listed
  // here. Comma-separated addresses or "@domain.com" suffixes. Enforced in code
  // rather than by configuration discipline: staging must not be one typo away
  // from emailing real clients.
  MAIL_SAFELIST: z.string().optional(),
  AWS_REGION: z.string().default("ap-south-1"),
  // Omit both on EC2/ECS so the SDK falls back to the instance role.
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  // Selects where uploaded documents live. Defaults to "local" so nothing changes
  // behaviour until the bucket is ready, tests run without AWS credentials, and a
  // rollback is a config change rather than a deploy.
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  // Bucket name only, not an ARN or URL. Required when STORAGE_DRIVER is "s3";
  // the check is below because zod cannot express the dependency inline.
  S3_BUCKET: z.string().optional(),
  // Bucket region, when it differs from the SES region.
  S3_REGION: z.string().optional(),
  // Namespaces one bucket across environments. Prefer separate buckets; this is
  // for the case where that is not possible.
  S3_KEY_PREFIX: z.string().optional(),
  // How long a signed download link stays valid. Short by default: the URL is a
  // bearer token for its lifetime, so anyone holding it can read the object.
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  // Points the SDK at MinIO or LocalStack for development.
  S3_ENDPOINT: z.string().url().optional(),
  // Shared secret appended to the SNS subscription URL as ?token=. SNS cannot
  // send custom headers, so the query string is the only channel available.
  SES_WEBHOOK_SECRET: z.string().optional(),
  // SES caps a message at 10 MB after base64 encoding. Staying under it means
  // budgeting for the ~33% encoding overhead on the raw attachment bytes.
  EMAIL_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(7 * 1024 * 1024),
  EMAIL_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  IDEAL_POSTCODES_API_KEY: z.string().optional(),
  // Protects stored SSN and ITIN values. Required in production; falls back to
  // JWT_SECRET in development so a local setup still works.
  TAX_ID_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  GOOGLE_ADDRESS_VALIDATION_API_KEY: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_MIN_TOPUP_MINOR: z.coerce.number().int().positive().default(10000),
  RAZORPAY_MAX_TOPUP_MINOR: z.coerce.number().int().positive().default(10000000),
  // Ceiling on how much a business account may push through Razorpay in one IST
  // day. Defaults to 5,00,000 rupees.
  RAZORPAY_MAX_DAILY_TOPUP_MINOR: z.coerce.number().int().positive().default(50000000),
  // How long an unpaid order still counts against the daily total. Without this
  // an abandoned checkout would hold its share of the allowance until midnight.
  RAZORPAY_TOPUP_PENDING_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  // Public online bookings are assigned server-side to this active branch. The
  // customer never chooses a branch and the value is frozen on the draft,
  // payment and shipment. A missing value keeps checkout safely unavailable.
  PUBLIC_BOOKING_BRANCH_ID: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().regex(/^[a-f\d]{24}$/i, "PUBLIC_BOOKING_BRANCH_ID must be a MongoDB ObjectId").optional(),
  ),
  PUBLIC_BOOKING_SESSION_HOURS: z.coerce.number().int().positive().max(168).default(24),
  // "Sign in with Google" verifies the ID token's audience against this client ID.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  // reCAPTCHA v3 siteverify secret for the email/password login form.
  RECAPTCHA_SECRET_KEY: z.string().optional(),
  // Keep captcha off for local development even if a shared secret is present.
  // Production defaults to enabled; set this explicitly for staging overrides.
  RECAPTCHA_ENABLED: booleanFromEnv.optional(),
  RECAPTCHA_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),
  // Verifies a login email's domain exists (DNS MX/A lookup) before accepting it.
  // Disable only in environments without outbound DNS.
  // ALS (Trackmate+ by ITD Services) is the carrier behind the DPD label. Labels
  // are only requested for United Kingdom destinations; every other route ships
  // on Swiftline labels alone and never touches these settings.
  //
  // ALS_ENABLED is the master switch. With it off the portal books exactly as it
  // does today, which is what makes this feature safe to deploy dark.
  ALS_ENABLED: booleanFromEnv.default(false),
  ALS_API_BASE_URL: z.string().url().optional(),
  ALS_COMPANY_ID: z.coerce.number().int().positive().optional(),
  ALS_API_EMAIL: z.string().email().optional(),
  ALS_API_PASSWORD: z.string().min(1).optional(),
  // Confirmed against a live booking: the spec PDF example (D3) is not rated for
  // this account and returns "Freight amount is 0".
  ALS_SERVICE_CODE: z.string().trim().min(1).default("DPD UK NEXTDAY"),
  // Portal values are held in INR; ALS declares customs value in GBP.
  ALS_INR_PER_GBP: z.coerce.number().positive().optional(),
  ALS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Used server-side only. Historical cost sheets persist the fetched rate so
  // their INR totals never move when a later market rate is published.
  EXCHANGE_RATE_API_KEY: z.string().trim().min(1).optional(),
  EMAIL_DOMAIN_CHECK: booleanFromEnv.default(true)
}).superRefine((value, context) => {
  // Fail at boot rather than on the first upload: a missing bucket would
  // otherwise surface as a runtime error only once a client tried to attach a
  // document, long after the deploy looked successful.
  if (value.STORAGE_DRIVER === "s3" && !value.S3_BUCKET) {
    context.addIssue({
      code: "custom",
      path: ["S3_BUCKET"],
      message: "S3_BUCKET is required when STORAGE_DRIVER is \"s3\""
    });
  }
});

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  console.error("Invalid environment variables:");

  for (const issue of result.error.issues) {
    console.error(`- ${issue.path.join(".")}: ${issue.message}`);
  }

  process.exit(1);
}

export const env = result.data;
