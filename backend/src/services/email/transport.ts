import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { env } from "../../config/env.js";
import { getSesClient } from "./sesClient.js";

export type OutboundAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
  cid?: string;
  contentDisposition?: "inline" | "attachment";
};

export type OutboundEmail = {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: OutboundAttachment[];
  headers?: Record<string, string>;
};

export type SendResult = {
  messageId: string;
};

export interface EmailTransport {
  readonly name: "ses" | "smtp" | "noop";
  send(message: OutboundEmail): Promise<SendResult>;
}

/**
 * Errors SES raises for a specific address rather than for the request. Retrying
 * these burns quota and, for bad addresses, actively harms sender reputation.
 */
const terminalSesErrors = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException"
]);

export class EmailSendError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "EmailSendError";
    this.retryable = retryable;
  }
}

function toMailOptions(message: OutboundEmail) {
  return {
    from: env.MAIL_FROM,
    to: message.toName ? { name: message.toName, address: message.to } : message.to,
    replyTo: env.MAIL_REPLY_TO || undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
    attachments: message.attachments
  };
}

function buildRawMessage(message: OutboundEmail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(toMailOptions(message)).compile().build((error, raw) => {
      if (error) reject(error);
      else resolve(raw);
    });
  });
}

/**
 * SESv2's `Content.Simple` cannot carry attachments, so every message goes out
 * as `Content.Raw` with a MIME blob composed by nodemailer. Hand-rolling
 * multipart boundaries and transfer encodings is a bug farm we do not need.
 */
class SesTransport implements EmailTransport {
  readonly name = "ses" as const;

  async send(message: OutboundEmail): Promise<SendResult> {
    const raw = await buildRawMessage(message);

    try {
      const response = await getSesClient().send(new SendEmailCommand({
        FromEmailAddress: env.MAIL_FROM,
        Destination: { ToAddresses: [message.to] },
        Content: { Raw: { Data: raw } },
        ConfigurationSetName: env.SES_CONFIGURATION_SET || undefined
      }));

      return { messageId: response.MessageId ?? "" };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const detail = error instanceof Error ? error.message : "Unknown SES error";
      throw new EmailSendError(`${name || "SESError"}: ${detail}`, !terminalSesErrors.has(name));
    }
  }
}

class SmtpTransport implements EmailTransport {
  readonly name = "smtp" as const;

  async send(message: OutboundEmail): Promise<SendResult> {
    const { SMTP_HOST, SMTP_PORT } = env;
    if (!SMTP_HOST || !SMTP_PORT) {
      throw new EmailSendError("SMTP transport selected but SMTP_HOST/SMTP_PORT are not configured.", false);
    }

    // Google prints app passwords in space-separated groups; Gmail's SMTP wants
    // the compact value. Normalise only for Gmail, leave other providers alone.
    const password = SMTP_HOST.includes("gmail.com")
      ? env.SMTP_PASSWORD?.replace(/\s+/g, "")
      : env.SMTP_PASSWORD;

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
      auth: env.SMTP_USER && password ? { user: env.SMTP_USER, pass: password } : undefined
    });

    try {
      const info = await transporter.sendMail(toMailOptions(message));
      return { messageId: info.messageId ?? "" };
    } catch (error) {
      // A local relay being down is transient; let the outbox retry it.
      throw new EmailSendError(error instanceof Error ? error.message : "Unknown SMTP error", true);
    } finally {
      transporter.close();
    }
  }
}

/** Used by tests and by any environment that must never put mail on the wire. */
class NoopTransport implements EmailTransport {
  readonly name = "noop" as const;

  async send(message: OutboundEmail): Promise<SendResult> {
    console.info("[mail:noop] send suppressed", {
      to: message.to,
      subject: message.subject,
      attachments: message.attachments?.map((attachment) => attachment.filename) ?? []
    });
    return { messageId: `noop-${Date.now()}` };
  }
}

let transport: EmailTransport | null = null;

export function getEmailTransport(): EmailTransport {
  if (transport) return transport;

  if (env.MAIL_DRIVER === "ses") transport = new SesTransport();
  else if (env.MAIL_DRIVER === "smtp") transport = new SmtpTransport();
  else transport = new NoopTransport();

  return transport;
}

export function isMailConfigured() {
  if (!env.MAIL_FROM) return false;
  if (env.MAIL_DRIVER === "smtp") return Boolean(env.SMTP_HOST && env.SMTP_PORT);
  return true;
}
