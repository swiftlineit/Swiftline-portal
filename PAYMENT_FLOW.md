# Payment Flow Reference

This document describes the portal's prepaid booking, wallet, cash receipt, amendment, and refund paths. Money is stored in integer INR paise. Provider confirmation and balance changes are idempotent and auditable.

## Booking payment rules

| Booking type | Accepted funding | Shipment creation gate |
| --- | --- | --- |
| Individual or public booking | Full Razorpay payment | Razorpay capture must be confirmed before booking |
| Business account | Full available wallet balance or full Razorpay payment | Wallet funds are reserved or Razorpay capture is confirmed before booking |
| Business cash exception | Staff finalized cash receipt | An admin or operations user records offline cash already received; the full receipt must be allocated before booking |
| Operator workspace | Existing operator billing and counter flow | Kept separate from Swiftline prepaid rules |

Client and staff requests cannot supply a trusted amount, funding source, or payment status. The server recalculates the current charge and checks the payment intent, account, branch, price, and shipment before creating the carrier booking. A cash receipt cannot be created by a business client or used for an individual shipment.

If the carrier response is uncertain after funds are secured, booking stays in review and the funds are not silently released or charged again. Reconciliation must resolve the original attempt first.

## Razorpay booking and wallet flow

Shipment payments, public bookings, and wallet top-ups use the existing Razorpay integration. Checkout signature verification is followed by server-side payment reconciliation; the Razorpay webhook also processes capture, failure, and refund events. Replayed provider events and client retries use stable idempotency keys.

For direct shipment payments, the captured intent is allocated to one shipment and cannot be reused. Business wallet top-ups are credited only after provider capture is confirmed. Wallet balances, reservations, ledger entries, and shipment funding records are updated together in MongoDB transactions. External Razorpay calls are made outside database transactions and have stable refund idempotency keys for reconciliation.

## Business cash receipts

1. A business shipment is priced and its full amount is checked against the staff-recorded receipt.
2. Admin or operations records the offline payment and confirms the cash custody reference.
3. Swiftline issues the compact receipt with receipt number, date, amount, booking details, and staff creator identity.
4. The receipt is attached to shipment funding and the full amount is allocated before booking.
5. The business client receives the receipt in Document Centre and by email. Admin and operations receive the operational email copy. The Document Centre sidebar shows unread receipt count.

Receipt allocations and reversals are recorded as append-only cash allocation events. Draft receipts do not authorize booking.

## Amendments

An amendment that increases a root Swiftline shipment's charge must secure the difference before approval. A business amendment uses wallet funds only; when the wallet is short, the client must top it up before paying the saved amendment. Individual and public amendments continue to use Razorpay. The payment intent is tied to the amendment and shipment, and approval atomically settles the secured funds with the revised invoice. Operator amendments retain their existing counter settlement.

An individual amendment reduction requires staff to record the refund before approval. A business prepaid reduction is credited to the business wallet. Rejected wallet-funded amendments release their reservation. Rejected Razorpay-funded amendments are not finalized until the matching full provider refund is confirmed. Pending amendments block cancellation settlement.

## Cancellations and refunds

Cancellation approval checks the active invoice, shipment status, carrier confirmation, pending amendments, and refund amount before making financial changes. Wallet-funded shipments are refunded to the business wallet. Cash receipts and legacy counter sales require a recorded staff payout. Razorpay-funded shipments are refunded to their captured payment sources. If an approved amendment added a separate Razorpay capture, cancellation stores an immutable allocation plan and refunds the approved captures in sequence. Approval completes only when every planned provider refund is confirmed. A changed fee cannot alter a refund after that plan has started.

## Legacy Swiftline credit

The Swiftline prepaid booking path does not consult old credit balances or statements: historical credit does not block a new booking or fund one. Retired Swiftline credit pages and booking-waiver code are removed; the client-facing ledger is wallet activity in Payments, and staff use the prepaid wallet ledger. Existing shipment invoices and prepaid payment history are preserved. Scheduled credit billing, overdue and reconciliation jobs skip Swiftline and continue for operator tenants.

For the release into an already active tenant installation, use `audit:prepaid-release` and `migrate:prepaid-release`. Management has approved zero opening balances: pass `--zero-opening-balances` to both commands. After verifying ownership and the absence of unresolved requests, held funds or in-flight prepaid payments, this one-time cutover snapshots prior balances, zeroes Swiftline wallets and legacy credit/advance summaries, closes old credit accounts and resets alert-cycle metadata. A nonzero wallet reset appends an ADMIN_DEBIT; prior ledger entries, captured payment amounts/statuses/provider IDs, receipts, shipments, invoices and statements remain intact. The durable completion marker prevents reruns from erasing subsequent deposits or new wallets. Operator balances remain unchanged. Omitting the flag preserves balances and only repairs ownership/metadata/indexes. Never transfer legacy advances or replay historical captures into opening wallets. The older tenant-initialization runner and its automatic advance-transfer step are not the release procedure for an installation with active operator tenants. See `docs/prepaid-production-deployment-guide.md`.

## Low wallet balance alerts

Each successful funding cycle records its own baseline amount. When that cycle's remaining wallet cash reaches 20% of the baseline, the portal sends an alert to business account financial members and staff. A cycle is alerted once; a later top-up starts a new baseline and alert cycle.

## Verification and release limits

- Use integer paise for payment, invoice, refund, wallet, and ledger amounts.
- Do not test against production MongoDB, live Razorpay, or live carrier credentials.
- Integration tests must use an explicitly configured test database. Never infer a test URI from application or migration environment variables.
- Indexes for tenant-owned prepaid collections are handled by the reviewed tenant migration sequence because production disables automatic index creation.
- A successful local build or unit suite does not prove Razorpay dashboard configuration, email delivery, carrier behavior, or deployment readiness.
