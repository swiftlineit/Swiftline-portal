# AWS SES Email Notifications- Feature Plan

Date: 2026-07-27
Status: Planning (no implementation yet)

---

## 1. Executive Summary

Swiftline Portal already has a **working in-app notification system** (`portalNotification.service.ts`, 18 event types, idempotency-keyed, audience fan-out helpers) and a **minimal email service** (`mail.service.ts`, nodemailer + SMTP, exactly 2 emails: client invitation and password reset).

The right move is **not** to build a second, parallel email system. It is to make **email a delivery channel on the notification event that already exists**, then extend the event catalogue to cover the ~60 lifecycle moments that currently notify nobody.

Three decisions drive this plan:

1. **Email rides the existing notification fan-out.** One domain event → one audience resolution → N recipients → per-recipient channel dispatch (in-app + email). We do not sprinkle `sendMail()` calls across 30 services.
2. **Transactional outbox, not inline sends.** The existing notify helpers accept a Mongoose `session` and are called *inside* transactions (`creditPayment.service.ts`, `creditBillingCycle.service.ts`). An email cannot be un-sent when a transaction rolls back. Emails must be enqueued in the same transaction and dispatched after commit.
3. **SES replaces SMTP as a transport, not as an API.** Keep nodemailer as the MIME builder (we need PDF attachments for invoices and statements) and swap the transport to SESv2. Dev keeps SMTP/Mailhog; prod uses SES.

---

## 2. What Already Exists

### 2.1 Email (thin)
| Item | Location | Notes |
|---|---|---|
| `sendClientInvitationEmail` | [mail.service.ts:122](portal/backend/src/services/mail.service.ts#L122) | Called from [businessAccountAccess.controller.ts:121](portal/backend/src/controllers/businessAccountAccess.controller.ts#L121) |
| `sendPasswordResetEmail` | [mail.service.ts:153](portal/backend/src/services/mail.service.ts#L153) | Called from [auth.controller.ts:249](portal/backend/src/controllers/auth.controller.ts#L249) |
| SMTP env vars | [config/env.ts:31-36](portal/backend/src/config/env.ts#L31-L36) | `SMTP_HOST/PORT/SECURE/USER/PASSWORD`, `MAIL_FROM`- all optional |

**Gaps:** no queue, no retry, no send log, no bounce handling, no templating layer (HTML is hand-built per function), no unsubscribe, no attachments, no per-user preferences. Sends are inline and awaited on the request path.

### 2.2 In-app notifications (solid foundation)
- [portalNotification.model.ts](portal/backend/src/models/portalNotification.model.ts)- 18 types, unique `idempotencyKey`, `metadata`, `href`, `readAt`.
- [portalNotification.service.ts](portal/backend/src/services/portalNotification.service.ts)- audience helpers, all session-aware:
  - `notifyActiveAdmins` → `User{role:"admin", userStatus:"active"}`
  - `notifyBusinessFinancialMembers` → members `account_owner|account_admin|finance`
  - `notifyBusinessQuoteMembers` → members `account_owner|account_admin|operations|finance`
  - `notifyPortalUsers` → explicit user id list
- Idempotency is per-recipient (`${key}:${userId}`) via upsert- **this same discipline is what makes email-dedupe safe.**

**Only 11 call sites exist today:** credit billing/account/payment, shipment cancellation, shipment quote, support ticket. Everything else in the portal is silent.

### 2.3 Roles
- **Staff** (`user.model.ts`): `admin`, `operations`, `accounts`, `delivery`, `hr`, `client` (+legacy `staff`)
- **Business members** (`businessAccountMember.model.ts`): `account_owner`, `account_admin`, `operations`, `finance`, `tracking_only`; plus `creditPermissions[]`

### 2.4 Scheduled jobs
No in-process cron. Existing pattern is **standalone scripts invoked externally**: `job:credit:close-billing`, `job:credit:expire-reservations`, `job:credit:mark-overdue`, `job:credit:reconcile`. Due-date reminder emails should follow this exact pattern, not introduce `node-cron`.

---

## 3. Target Architecture

```
Domain service (in txn)
   └─ emitNotification(event)                    ← single entry point
        ├─ resolveAudience(event)                ← role/permission → user[]
        ├─ PortalNotification.bulkWrite(session)  ← in-app (existing)
        └─ EmailOutbox.insertMany(session)        ← NEW: queued, not sent
                    │
              [txn commits]
                    │
        ┌───────────┴────────────┐
   post-commit drain        job:email:drain (safety net, catches
   (best-effort, fast)       crashed/failed/retryable rows)
                    │
             emailDispatcher
                ├─ preference + suppression check
                ├─ render template (MJML/JSX → HTML + text)
                ├─ nodemailer buildMessage → raw MIME
                └─ SESv2 SendEmailCommand
                            │
                     SES Configuration Set
                            │
                        SNS topic
                            │
                  POST /api/v1/webhooks/ses  → EmailSuppression + EmailLog status
```

### 3.1 New models

**`emailOutbox.model.ts`**- the queue and the audit log in one.
| Field | Purpose |
|---|---|
| `idempotencyKey` (unique) | `${notificationKey}:${userId}:email`- hard guarantee against double-send on job reruns |
| `recipientUserId`, `toEmail` | resolved at enqueue time (email may change later; we send to what we resolved) |
| `businessAccountId` | scoping / admin filtering |
| `templateKey` | e.g. `SHIPMENT_BOOKED` |
| `payload` | template variables (denormalized- template must render without re-querying) |
| `status` | `PENDING → SENDING → SENT → DELIVERED` / `FAILED` / `BOUNCED` / `COMPLAINED` / `SUPPRESSED` / `CANCELLED` |
| `attempts`, `nextAttemptAt`, `lastError` | exponential backoff |
| `sesMessageId` | correlates SNS events back to the row |
| `category` | `TRANSACTIONAL` \| `OPERATIONAL` \| `MARKETING`- drives preference enforcement |
| `priority` | lets invoices/security jump ahead of digests |

**`emailPreference.model.ts`**- per user, per category/type opt-out. Transactional cannot be disabled.

**`emailSuppression.model.ts`**- hard bounces + complaints, keyed by email. Checked before every send. Account-level protection: SES suspends sending above 5% bounce / 0.1% complaint.

### 3.2 Transport layer
`services/email/` (new folder):
- `sesClient.ts`- `@aws-sdk/client-sesv2`, IAM role in prod, keys in dev
- `transport.ts`- driver interface; `SesTransport` + `SmtpTransport` + `NoopTransport` (tests/local)
- `renderer.ts`- template registry, layout wrapper, HTML + plaintext
- `dispatcher.ts`- preference/suppression checks, retry, SES call
- `templates/`- one module per `templateKey`

**Why nodemailer stays:** SESv2 `SendEmail` with `Content.Simple` cannot do attachments. Invoice/statement PDFs require `Content.Raw` with a full MIME blob- nodemailer's `MailComposer` builds that correctly (encoding, multipart boundaries, headers). Rewriting MIME by hand is a bug farm.

### 3.3 AWS setup (prerequisite, ~2-3 days of DNS + approval latency)
1. Verify sending **domain** (not just an address) in SES, region `ap-south-1` (matches India-centric portal; confirm against existing infra).
2. Enable **Easy DKIM** (3 CNAMEs), add **SPF** TXT (`include:amazonses.com`), add **DMARC** (`p=none` → tighten to `quarantine` after 2 weeks of clean reports).
3. Create a **Configuration Set** with event destination → SNS topic → HTTPS subscription to our webhook. Subscribe to: `Bounce`, `Complaint`, `Delivery`, `Reject`, `RenderingFailure`.
4. **Request production access** (exits the 200/day, verified-recipients-only sandbox). Requires describing bounce/complaint handling- have the suppression model ready before applying.
5. Separate identities/config sets per environment; staging must never send to real client addresses (see §7).

### 3.4 New env vars
`AWS_REGION`, `SES_CONFIGURATION_SET`, `SES_FROM_ADDRESS`, `SES_REPLY_TO`, `MAIL_DRIVER` (`ses|smtp|noop`), `MAIL_SAFELIST` (staging guard), `APP_PUBLIC_URL` (for deep links), `SES_WEBHOOK_SECRET`.

---

## 4. The Email Catalogue

**Audience legend- client side:** `OWN` account_owner · `ADM` account_admin · `FIN` finance · `BOPS` business operations · `TRK` tracking_only · `ACTOR` the user who performed the action
**Audience legend- staff side:** `ADMIN` role:admin · `OPS` role:operations · `ACCT` role:accounts · `DELIV` role:delivery

`★` = in-app notification type already exists, email is a pure add-on (cheapest wins)
`▲` = no notification exists today; new event needed

### 4.1 Account, Access & Security
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 1 | Client invitation | invite created | invitee |- | TXN | P0 ✅exists |
| 2 | Password reset | reset requested | ACTOR |- | TXN | P0 ✅exists |
| 3 | Password changed | password updated | ACTOR |- | TXN | P0 |
| 4 | Email verified / changed | email updated | ACTOR + old address |- | TXN | P1 |
| 5 | New device / unusual login | login from new IP/UA | ACTOR |- | TXN | P2 |
| 6 | Account locked (failed attempts) | lockout threshold | ACTOR | ADMIN | TXN | P1 |
| 7 | Member added to business account | membership active | new member, OWN+ADM |- | TXN | P1 |
| 8 | Member role changed | role updated | affected member, OWN+ADM |- | OPS | P1 |
| 9 | Member removed / suspended | status change | affected member, OWN+ADM |- | OPS | P1 |
| 10 | Invitation expiring / expired | T-2 days, T+0 | invitee, OWN+ADM |- | OPS | P2 |
| 11 | Staff user created | admin creates staff |- | new staff | TXN | P1 |

### 4.2 Business Account Onboarding & KYC
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 12 | Business account registered ▲ | signup complete | OWN | ADMIN, ACCT | TXN | P0 |
| 13 | KYC documents submitted ▲ | upload complete | OWN+ADM | ADMIN, ACCT | OPS | P1 |
| 14 | KYC approved ▲ | admin approves | OWN+ADM |- | TXN | P0 |
| 15 | KYC rejected / more info needed ▲ | admin rejects | OWN+ADM |- | TXN | P0 |
| 16 | Account activated- ready to ship ▲ | status → active | OWN+ADM+BOPS | ADMIN | TXN | P0 |
| 17 | Account suspended / reactivated ▲ | status change | OWN+ADM+FIN | ADMIN | TXN | P0 |
| 18 | Aadhaar/GST validation failed ▲ | validation service fails | OWN+ADM | ADMIN | OPS | P2 |

### 4.3 Credit Account & Agreements
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 19 | Credit application submitted ▲ | client requests credit | OWN+FIN | ADMIN, ACCT | TXN | P0 |
| 20 | Credit limit approved ▲ | `creditLimitStatus → approved` | OWN+ADM+FIN |- | TXN | P0 |
| 21 | Credit limit not approved ▲ | `→ not_approved` | OWN+ADM+FIN |- | TXN | P0 |
| 22 | Credit limit changed ▲ | `creditLimitHistory` write | OWN+FIN | ACCT | TXN | P1 |
| 23 | Security deposit required ▲ | `depositStatus → required` | OWN+FIN |- | TXN | P1 |
| 24 | Security deposit received ▲ | `→ received` | OWN+FIN | ACCT | TXN | P1 |
| 25 | Credit agreement generated / sent ▲ | status `GENERATED`/`SENT` | OWN+ADM |- | TXN | P0 |
| 26 | Agreement reminder- unsigned ▲ | T+3, T+7 after SENT | OWN+ADM | ADMIN | OPS | P1 |
| 27 | Agreement signed ▲ | status `SIGNED` (+PDF attached) | OWN+ADM+FIN | ADMIN, ACCT | TXN | P0 |
| 28 | Agreement declined / expired ▲ | status change | OWN+ADM | ADMIN | TXN | P1 |
| 29 | Credit utilization warning ★ | threshold % crossed | OWN+ADM+FIN |- | OPS | P0 |
| 30 | Low booking capacity ★ | available credit low | OWN+ADM+FIN+BOPS |- | OPS | P0 |
| 31 | Credit restricted- bookings blocked ▲ | restriction level escalates | OWN+ADM+FIN+BOPS | ADMIN, ACCT | TXN | P0 |
| 32 | Credit reconciliation alert ★ | job detects mismatch |- | ADMIN, ACCT | OPS | P1 |

### 4.4 Quotes
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 33 | Quote requested ★ | client submits | requester | ADMIN, OPS | TXN | P0 |
| 34 | Quote under review ▲ | status `UNDER_REVIEW` | quote members |- | OPS | P2 |
| 35 | Quote published ★ | status `QUOTED` | quote members |- | TXN | P0 |
| 36 | Quote declined ★ | status `DECLINED` | quote members |- | TXN | P0 |
| 37 | Quote expiring soon ▲ | T-2 days before expiry | quote members |- | OPS | P1 |
| 38 | Quote expired ▲ | status `EXPIRED` | quote members | ADMIN | OPS | P2 |
| 39 | Quote converted to booking ★ | status `CONVERTED` | quote members | ADMIN, OPS | TXN | P1 |

### 4.5 Shipment Booking Lifecycle
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 40 | **Shipment created (draft saved)** ▲ | draft persisted | ACTOR |- | OPS | P1 |
| 41 | Draft incomplete reminder ▲ | draft idle 48h | ACTOR, BOPS |- | OPS | P2 |
| 42 | **Shipment booked** ▲ | `SHIPMENT_BOOKED` event | ACTOR, BOPS, OWN | OPS | TXN | **P0** |
| 43 | Label ready ▲ | `LABEL_RECEIVED` (+PDF attached) | ACTOR, BOPS | OPS | TXN | **P0** |
| 44 | Booking failed / DPD rejected ▲ | `DPD_REJECTED` | ACTOR, BOPS | ADMIN, OPS | TXN | **P0** |
| 45 | Booking pending- provider unknown ▲ | `DPD_STATUS_UNKNOWN` |- | ADMIN, OPS | OPS | P1 |
| 46 | KYC required for shipment ▲ | shipment KYC gate hit | ACTOR, BOPS |- | TXN | P1 |
| 47 | Restricted goods flagged ▲ | validation service flags | ACTOR, BOPS | ADMIN, OPS | TXN | P1 |
| 48 | Shipment on hold ▲ | `ON_HOLD` | ACTOR, BOPS, OWN | OPS | TXN | **P0** |
| 49 | Released from hold ▲ | `RELEASED_FROM_HOLD` | ACTOR, BOPS | OPS | TXN | P1 |

Booking emails are sent to active business owners, admins, operations/finance members, active operations staff, and the consignor email entered on the shipment. Attachments include the GST tax invoice and customs shipment invoice, available Swiftline/internal labels, a DPD label when generated, and a finalized cash receipt when present.

### 4.6 Shipment Tracking Milestones
> Highest-volume category. **Must be preference-gated and digestible**- a 200-shipment/day client will not tolerate per-parcel emails. Default: opt-in per milestone, with a daily digest alternative.

| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 50 | Parcel collected ▲ | `PARCEL_COLLECTED` | TRK+BOPS (opt-in) |- | OPS | P1 |
| 51 | Warehouse scan-in ▲ | `WAREHOUSE_SCAN_IN` | opt-in |- | OPS | P2 |
| 52 | Export customs cleared ▲ | `EXPORT_CUSTOMS_CLEARED` | TRK+BOPS |- | OPS | P1 |
| 53 | Flight departed ▲ | `FLIGHT_DEPARTED` | opt-in |- | OPS | P2 |
| 54 | Arrived at destination ▲ | `DESTINATION_ARRIVED` | TRK+BOPS |- | OPS | P1 |
| 55 | Import customs clearance ▲ | `IMPORT_CUSTOMS_CLEARANCE` | TRK+BOPS |- | OPS | P1 |
| 56 | Customs held / duty payable ▲ | exception state | ACTOR, BOPS, OWN | ADMIN, OPS | TXN | **P0** |
| 57 | Out for delivery ▲ | `OUT_FOR_DELIVERY` | TRK+BOPS | DELIV | OPS | P1 |
| 58 | **Delivered** ▲ | `DELIVERED` | ACTOR, TRK, BOPS | DELIV | TXN | **P0** |
| 59 | Delivery exception / failed attempt ▲ | exception | ACTOR, BOPS | DELIV, OPS | TXN | **P0** |
| 60 | Stuck shipment alert ▲ | no scan in N days (job) | BOPS | ADMIN, OPS | OPS | P1 |
| 61 | **Daily tracking digest** ▲ | job, per business account | opt-in list |- | OPS | P1 |

### 4.7 Amendments
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 62 | **Amendment requested** ▲ | status `REQUESTED` | ACTOR, BOPS | ADMIN, OPS | TXN | **P0** |
| 63 | **Amendment approved** ▲ | status `APPROVED` | ACTOR, BOPS, FIN* | OPS | TXN | **P0** |
| 64 | **Amendment rejected** ▲ | status `REJECTED` | ACTOR, BOPS |- | TXN | **P0** |
| 65 | Amendment applied ▲ | status `APPLIED` | ACTOR, BOPS | OPS | TXN | P1 |
| 66 | Amendment fee charged ▲ | `amendmentBilling` posts charge | FIN, OWN | ACCT | TXN | P0 |
| 67 | Amendment pending too long ▲ | job, >24h in REQUESTED |- | ADMIN, OPS | OPS | P1 |

\* FIN included on approval only when the amendment carries a fee.

### 4.8 Cancellations
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 68 | Cancellation requested ★ | status `REQUESTED` | ACTOR, FIN | ADMIN, OPS | TXN | P0 |
| 69 | Cancellation completed ★ | status `COMPLETED` | ACTOR, FIN, BOPS | ACCT | TXN | P0 |
| 70 | Cancellation rejected ★ | status `REJECTED` | ACTOR, FIN |- | TXN | P0 |
| 71 | Cancellation fee invoice issued ▲ | fee invoice created (+PDF) | FIN, OWN | ACCT | TXN | P0 |
| 72 | Credit note issued ▲ | `shipmentCreditNote` created (+PDF) | FIN, OWN | ACCT | TXN | P1 |

### 4.9 Invoices & Documents
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 73 | **Shipment invoice issued** ▲ | invoice created (+PDF) | FIN, OWN+ADM |- | TXN | **P0** |
| 74 | **Tax invoice issued** ▲ | tax invoice created (+PDF) | FIN, OWN+ADM | ACCT | TXN | **P0** |
| 75 | Commercial invoice upload received ▲ | `invoiceUpload` UPLOADED | ACTOR |- | OPS | P2 |
| 76 | Invoice parsing failed ▲ | `PARSING_FAILED` | ACTOR, BOPS | ADMIN, OPS | TXN | P1 |
| 77 | Invoice parsed- review needed ▲ | `PARSED` | ACTOR |- | OPS | P2 |
| 78 | Charge verification discrepancy ▲ | `shipmentChargeVerification` mismatch | FIN | ADMIN, ACCT | OPS | P1 |
| 79 | Manifest / EDI generated ▲ | manifest doc ready | BOPS | OPS | OPS | P2 |

### 4.10 Billing Statements & Due Dates
> The core of the "due dates" requirement. All reminder emails are produced by a **single idempotent job** keyed on `${statementId}:${offsetLabel}`.

| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 80 | **Statement issued** ★ | `ISSUED` (+PDF attached) | FIN, OWN+ADM | ACCT | TXN | **P0** |
| 81 | Payment due in 7 days ▲ | job, T-7 | FIN, OWN |- | TXN | P1 |
| 82 | **Payment due in 3 days** ★ | job, T-3 (existing type) | FIN, OWN |- | TXN | **P0** |
| 83 | Payment due tomorrow ▲ | job, T-1 | FIN, OWN+ADM |- | TXN | P0 |
| 84 | Payment due today ▲ | job, T-0 | FIN, OWN+ADM |- | TXN | P0 |
| 85 | **Payment overdue** ★ | job, T+1 | FIN, OWN+ADM | ACCT | TXN | **P0** |
| 86 | Overdue escalation ▲ | job, T+7 / T+15 / T+30 | FIN, OWN+ADM | ADMIN, ACCT | TXN | P0 |
| 87 | Grace period ending ▲ | `gracePeriodDays` − 1 | FIN, OWN+ADM | ACCT | TXN | P0 |
| 88 | Statement partially paid ▲ | `PARTIALLY_PAID` | FIN | ACCT | TXN | P1 |
| 89 | Statement fully paid ▲ | `PAID` | FIN, OWN | ACCT | TXN | P0 |
| 90 | Statement voided ▲ | `VOID` | FIN, OWN | ACCT | TXN | P1 |
| 91 | Billing adjustment applied ▲ | `creditBillingAdjustment` | FIN | ACCT | TXN | P1 |
| 92 | **Monthly statement summary** ▲ | job, cycle close | FIN, OWN |- | OPS | P1 |
| 93 | Aging/AR digest ▲ | job, weekly |- | ADMIN, ACCT | OPS | P1 |

### 4.11 Payments
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 94 | Payment confirmed ★ | `VERIFIED` (+receipt PDF) | payer, FIN, OWN | ACCT | TXN | **P0** |
| 95 | Offline payment submitted ★ | `PENDING_VERIFICATION` | payer, FIN | ADMIN, ACCT | TXN | P0 |
| 96 | Offline payment rejected ▲ | verification fails | payer, FIN |- | TXN | P0 |
| 97 | Payment failed ▲ | `FAILED` | payer, FIN | ACCT | TXN | P0 |
| 98 | Top-up initiated ▲ | `CREATED`/`CHECKOUT_OPENED` | payer |- | OPS | P2 |
| 99 | **Top-up successful** ▲ | `CAPTURED` (+receipt) | payer, FIN, OWN | ACCT | TXN | **P0** |
| 100 | Top-up failed / cancelled ▲ | `FAILED`/`CANCELLED` | payer |- | TXN | P1 |
| 101 | Refund initiated ▲ | `REFUND_PENDING` | payer, FIN | ACCT | TXN | P0 |
| 102 | Refund completed ▲ | `REFUNDED` | payer, FIN | ACCT | TXN | P0 |
| 103 | Razorpay webhook mismatch ▲ | reconciliation gap |- | ADMIN, ACCT | OPS | P1 |
| 104 | Prepaid balance low ▲ | below threshold | FIN, OWN, BOPS |- | OPS | P0 |
| 105 | Prepaid balance exhausted ▲ | balance ≤ 0, bookings blocked | FIN, OWN+ADM, BOPS | ACCT | TXN | P0 |
| 106 | Reservation expiring ▲ | `expireReservations` job | BOPS, FIN |- | OPS | P2 |

### 4.12 Support Tickets
| # | Event | Trigger | Client → | Staff → | Cat | Pri |
|---|---|---|---|---|---|---|
| 107 | Ticket created ★ | new ticket | requester | ADMIN, OPS | TXN | P0 |
| 108 | Ticket reply ★ | new message | other party | assigned staff | TXN | P0 |
| 109 | Ticket status updated ★ | status change | requester |- | TXN | P1 |
| 110 | Waiting for customer reminder ▲ | job, 48h idle | requester |- | OPS | P2 |
| 111 | Ticket resolved- feedback ask ▲ | `RESOLVED` | requester |- | OPS | P2 |
| 112 | SLA breach- urgent unanswered ▲ | job, priority-based |- | ADMIN, OPS | OPS | P1 |

### 4.13 Internal Operations & System Health (staff only)
| # | Event | Trigger | Staff → | Cat | Pri |
|---|---|---|---|---|---|
| 113 | Manifest closed / dispatched ▲ | manifest finalized | OPS, ADMIN | OPS | P2 |
| 114 | Scan session anomaly ▲ | missing/duplicate scans | OPS | OPS | P2 |
| 115 | DPD API failures spike ▲ | error-rate threshold | ADMIN, OPS | OPS | P1 |
| 116 | Rate card expiring ▲ | `countryRateCard` validity | ADMIN, ACCT | OPS | P2 |
| 117 | Job failure alert ▲ | any `job:*` script throws | ADMIN | OPS | **P0** |
| 118 | Email deliverability alert ▲ | bounce/complaint rate high | ADMIN | OPS | **P0** |
| 119 | Daily ops summary ▲ | job, morning | ADMIN, OPS | OPS | P2 |
| 120 | New client onboarded digest ▲ | job, weekly | ADMIN | OPS | P2 |

**Totals:** ~120 email touchpoints- 18 backed by existing in-app types (★), the rest new (▲). **~34 are P0.**

---

## 5. Preferences & Volume Control

Volume is the main product risk. A client booking 200 shipments/day would receive thousands of emails under a naive design.

**Rules:**
1. **Transactional (`TXN`) cannot be unsubscribed**- invoices, payments, security, legal agreements, account status. Regulatory and contractual necessity.
2. **Operational (`OPS`) is preference-controlled**- tracking milestones, reminders, digests. Per-user, per-type toggles in portal settings.
3. **Tracking milestones default to OFF for per-event email, ON for daily digest.** Explicit opt-in for real-time.
4. **Digest rollup** for high-volume types: batch by business account, one email per window.
5. **Throttle/coalesce**: if >N emails of one type queue for one recipient within a window, collapse into a summary. `EmailOutbox` supports this via a `coalesceKey`.
6. **Quiet hours** (IST) for non-urgent OPS mail; urgent TXN always sends immediately.
7. **`List-Unsubscribe` + `List-Unsubscribe-Post` headers** on all OPS mail (Gmail/Yahoo bulk-sender requirement) with a signed, no-login-required token URL.

---

## 6. Delivery, Reliability & Compliance

- **Retry**: exponential backoff (1m, 5m, 30m, 2h, 12h), max 5 attempts. Distinguish retryable (throttling, 5xx, network) from terminal (invalid address, suppressed)- never retry terminal.
- **Suppression enforcement**: check `EmailSuppression` before send; hard bounce → permanent suppress; complaint → permanent suppress + flag account for review; soft bounce → retry then suppress after 3.
- **Rate limiting**: respect the SES account send rate; token-bucket in the dispatcher. Concurrency cap on the drain worker.
- **Idempotency**: unique `idempotencyKey` on outbox is the single guard against duplicate sends across job reruns, retries, and concurrent workers.
- **Observability**: admin screen listing outbox rows (filter by status/type/account), per-template send/bounce/complaint rates, alert at 3% bounce / 0.08% complaint (below SES's 5%/0.1% suspension thresholds).
- **PII**: no full addresses, invoice line items, or document contents in email bodies- link into the portal instead. Attachments limited to documents the recipient is already authorized to see. Attachment cap 10 MB (SES limit); link to portal above that.
- **Data retention**: outbox `payload` purged after 90 days; status/metadata retained for audit.

---

## 7. Environment Safety

The single biggest operational hazard is **staging emailing real clients**.

- `MAIL_DRIVER=noop` in test; `smtp` (Mailhog) in local dev.
- In any non-production environment, the dispatcher **hard-filters** recipients against `MAIL_SAFELIST` and rewrites all others to a catch-all inbox. This is enforced in the dispatcher, not by configuration discipline.
- Separate SES identity + configuration set per environment so staging can never consume production reputation.
- Seed/backfill scripts must run with the outbox in `CANCELLED` mode- a backfill that enqueues 50k historical "invoice issued" emails is an unrecoverable reputation event.

---

## 8. Phased Delivery

| Phase | Scope | Outcome |
|---|---|---|
| **0- AWS setup** | Domain verification, DKIM/SPF/DMARC, config set, SNS topic, production access request | Can send from the domain; ~2-3 days of external latency, start immediately |
| **1- Foundation** | `EmailOutbox`/`EmailPreference`/`EmailSuppression` models, SES transport, template renderer + base layout, dispatcher with retry, `job:email:drain`, SNS webhook, env-safety guard | Infrastructure proven end-to-end with the 2 existing emails migrated off raw SMTP |
| **2- Wire existing events** | Extend `emitNotification` so all 18 current in-app types also email; ~20 templates | Immediate coverage with zero new domain logic- lowest risk, highest ratio |
| **3- P0 gaps** | Shipment booked/label/delivered/hold (§4.5, §4.6), amendments (§4.7), invoices (§4.9), payments (§4.11), onboarding (§4.2) | The events the business actually asked for |
| **4- Due dates & jobs** | `job:email:due-reminders` (T-7→T+30), digests, aging report, stuck-shipment and SLA jobs | Proactive collections; the largest single business value |
| **5- Preferences & UX** | Preference model + client/admin settings UI, unsubscribe endpoint, digest engine, quiet hours | Volume under control; unlocks tracking milestones safely |
| **6- Observability** | Admin email log screen, deliverability dashboard, bounce alerts, per-template metrics | Operable in production |

**Recommended sequencing note:** Phase 2 before Phase 3. Wiring email to the 18 existing notification types requires no new domain-event plumbing and validates the whole pipeline against real traffic before we touch 30 services.

---

## 9. Open Questions

1. **AWS region**- `ap-south-1` assumed for an India-centric portal. Confirm against where the app is hosted (cross-region adds latency, not correctness).
2. **Sending domain & from-address**- e.g. `no-reply@swiftline.in`; reply-to should point at support so replies become tickets. Is inbound-email-to-ticket in scope later?
3. **Existing SMTP retirement**- keep SMTP as a fallback driver, or SES-only in production?
4. **Attachment policy**- attach invoice/statement PDFs, or link-only? Attachments raise deliverability risk and size; links require login. Recommendation: attach for invoices/statements/agreements (clients expect it for accounting), link for everything else.
5. **Tracking milestone defaults**- confirm the opt-in default. This is the difference between a useful product and a spam complaint.
6. **Localization**- English-only initially? Any multi-language client base?
7. **Branding**- need the HTML email design/logo assets before Phase 1 templates.
8. **Do staff want individual emails or digests?** Recommendation: digests for volume events (new bookings, quotes), individual only for exceptions and approvals.

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Staging sends to real clients | Severe, irreversible | Dispatcher-level safelist enforcement (§7) |
| Backfill floods the outbox | SES suspension | Scripts default to `CANCELLED`; explicit flag to enable sending |
| Email sent for rolled-back transaction | Wrong data to client | Transactional outbox- enqueue in-session, send post-commit (§3) |
| Volume fatigue → complaints → SES suspension | Blocks all mail incl. password resets | Preferences, digests, coalescing (§5); alert below SES thresholds |
| Sending on the request path | Slow API, failed requests | Outbox is a write; dispatch is async |
| SES sandbox at launch | Only verified recipients receive mail | Request production access in Phase 0, not Phase 3 |
| Template drift vs. domain changes | Broken/incorrect emails | Denormalized `payload` snapshot at enqueue time; template unit tests |

---

## 11. Recommended Immediate Next Steps

1. Confirm the §9 open questions (region, from-address, attachment policy, tracking defaults).
2. Start **Phase 0** now- DNS propagation and SES production-access approval are external latency on the critical path.
3. Approve the Phase 1 model shapes (`EmailOutbox`, `EmailPreference`, `EmailSuppression`) before any code.
4. Confirm the P0 list in §4- 34 events is a large but achievable first release; trim if a smaller launch is preferred.
