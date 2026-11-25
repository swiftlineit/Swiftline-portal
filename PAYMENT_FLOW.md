# Payment Flow Reference

This document describes the portal's active shipment payment paths. Money is stored in integer INR paise. Provider confirmation and ledger events are idempotent and auditable.

## Wallet/top-up removal

Wallet balance, wallet top-up, wallet reservation, and wallet ledger APIs and UI are removed from active workflows. Standalone cash receipts remain a separate staff-only Operations feature and do not fund bookings. Legacy values such as `BUSINESS_WALLET` and `CREDITED_TO_WALLET` remain only to read and display historical records and to support reviewed migration/audit scripts. They are not active funding sources.

A legacy wallet-funded shipment can still be cancelled, but its refund must be recorded as an offline payout before approval. It is stored as `MANUAL_REFUNDED`; no wallet is credited.

## Booking payment rules

| Booking type | Accepted funding | Shipment creation gate |
| --- | --- | --- |
| Client DPD booking | Direct Razorpay only | Server-verified capture before booking |
| Staff DPD booking | Direct Razorpay or finalized shipment cash receipt | Server-verified capture/receipt before booking |
| Individual/public booking | Public Razorpay capture | Provider capture confirmed before booking |
| Operator workspace | Existing operator credit/counter flow | Unchanged and isolated from Swiftline wallet removal |

Client and staff requests cannot supply a trusted amount, payment status, or wallet balance. The server recalculates the current charge and checks the payment intent or finalized receipt, account, branch, price, and shipment before creating the carrier booking.

If a carrier response is uncertain after funds are secured, booking stays in review and funds are not silently released or charged again.

## Razorpay payments

Direct and public bookings use Razorpay Checkout. Signature verification is followed by server-side payment reconciliation; the webhook processes capture, failure, and refund events. Replayed provider events and client retries use stable idempotency keys. A captured intent is allocated to one shipment and cannot be reused.

## Staff shipment cash receipts

1. A business shipment is priced and its full amount is checked against the staff-recorded receipt.
2. Admin or operations staff save receipt details and a cash custody reference.
3. The portal issues the shipment-linked receipt with receipt number, date, amount, booking details, and recorder identity.
4. Finalizing the booking allocates the full receipt to shipment funding before booking.
5. The business client receives the receipt in Document Centre and by email; staff receive the operational copy.

A saved draft does not authorize booking. Standalone receipts are separate staff records and do not affect a booking balance or payments ledger.

## Amendments

- An increase must be secured by direct Razorpay before approval. Individual and public amendments use their own payment sources.
- A reduction is refunded to the captured Razorpay payment where possible. Refunds are cumulative and idempotent; over-refunds are rejected.
- If no captured online payment can cover a reduction, approval is blocked until staff record a manual refund.
- Pending amendments block cancellation settlement.

## Cancellations

Cancellation approval checks the active invoice, shipment status, carrier confirmation, pending amendments, and refund amount before financial changes.

- Direct/public Razorpay shipments are refunded through captured payment sources using a stored allocation plan. Approval completes only after every planned provider refund is confirmed.
- Cash-receipt and walk-in/counter shipments require staff to record the offline payout method and reference.
- Legacy wallet-funded shipments require an offline payout record and are stored as `MANUAL_REFUNDED`, never as a wallet credit.
- If the reviewed fee leaves no refundable amount, no payout is required.

## Client and staff ledgers

- Client: `GET /api/v1/client/account-ledger`.
- Staff: `GET /api/v1/business-accounts/:businessAccountId/payments-ledger` and `/export`.

The ledger includes verified Razorpay booking/amendment payments, shipment cash receipts, and recorded cash refunds. It excludes wallet rows, public payments, individual sentinel/counter payments, and historical standalone receipts. Client access requires an active financial membership; staff access requires role and assigned-branch checks.

## Legacy credit and operator tenants

Swiftline prepaid booking does not consult old credit balances or statements. Historical credit pages and booking-waiver code are removed. Operator credit, counter payments, billing jobs, and portal workspaces are unchanged and remain isolated.

## Verification and release limits

- Use integer paise for all payment, invoice, refund, and ledger amounts.
- Never test against production MongoDB, live Razorpay, or live carrier credentials.
- Integration tests use an explicitly configured test database.
- A successful local build or test suite does not prove provider configuration, email delivery, carrier behavior, or deployment readiness.

See `WALLET_REMOVAL_FINAL_REPORT.md` for verification evidence and `WALLET_REMOVAL_MANUAL_TEST_GUIDE.md` for staging acceptance steps.
