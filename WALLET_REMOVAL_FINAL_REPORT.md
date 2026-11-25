# Wallet Removal Final Safety Report

Date: 25 November 2026

## Scope

This report covers every active shipment money path in the portal: client DPD booking, staff DPD booking, public booking, operator workspace, amendments, cancellations, receipts, and client/staff ledgers. It confirms that the wallet/top-up feature is no longer an active funding mechanism and that staff-recorded shipment cash receipts remain supported.

All amounts are integer INR paise. No production database, live Razorpay account, live carrier, or live email delivery was used for verification.

## Conclusion

Yes: all active wallet/top-up funding paths are removed, and the one remaining safety gap has been fixed.

The audit found a legacy gap where cancelling a shipment originally funded from `BUSINESS_WALLET` could void the active invoice without either refunding the customer or recording a manual payout. That path now requires a staff-recorded offline refund before approval and stores the result as `MANUAL_REFUNDED` with method, reference, note, and audit metadata. No wallet is credited.

## What changed

### Removed active code

- Wallet/top-up, reservation, ledger, and daily-limit services, controllers, routes, and package scripts.
- Phase 2/3 prepaid test scripts and the obsolete daily-limit integration test.
- Client wallet UI, top-up UI, wallet balance summary, and receipt-history/preview components.
- Active top-up APIs. Standalone `/api/v1/cash-receipts` and the staff Cash Receipts page are retained.

### Retained only for historical compatibility

- Legacy enums such as `BUSINESS_WALLET`, `CREDITED_TO_WALLET`, and `receiptType: "STANDALONE"` remain only where older records must still display or migrate safely.
- Legacy wallet/top-up Mongo collections and reviewed migration/audit scripts remain intact. They are not written by active shipment flows.
- `prepaidLedger.ts` keeps its filename for import compatibility, but its types and APIs are now the direct-payment/cash-receipt ledger.

## Active workflow matrix

| Workflow | Accepted funding | Enforcement |
| --- | --- | --- |
| Client DPD booking | `DIRECT_RAZORPAY` only | `backend/src/controllers/client.controller.ts:1573` |
| Staff DPD booking | `DIRECT_RAZORPAY` or `CASH_RECEIPT` | `backend/src/controllers/dpdShipment.controller.ts:174` |
| Public booking | `PUBLIC_RAZORPAY` only | `backend/src/services/publicShipmentBooking.service.ts:422` |
| Operator workspace | Existing operator credit/counter flow | Unchanged; not a Swiftline wallet path |
| Legacy wallet reservation attempt | Rejected | `backend/src/services/shipmentBookingBilling.service.ts:65` |

Client and staff requests cannot supply a trusted amount, wallet balance, or payment status. The server recalculates the price and checks the captured payment or finalized receipt before creating the carrier booking.

## Staff cash receipts

A finalized, shipment-linked cash receipt is a first-class booking source. A draft receipt does not authorize booking. The service verifies the receipt, business account, branch, pricing hash, and allocation, then attaches it to `ShipmentFunding` as `CASH_RECEIPT`.

Receipts appear in the payments ledger as `SHIPMENT_CASH_RECEIPT`; standalone receipts remain staff-only and are excluded from that ledger. Client Document Centre access to a receipt PDF remains available for shipment-linked receipts only.

## Amendments and refunds

- Increase: secured by direct Razorpay before approval. Public amendments use the public payment source.
- Reduction: refunded to the captured Razorpay payment where possible, with cumulative and idempotent provider refunds.
- Manual fallback: when no captured online payment can cover a reduction, `prepareAmendmentRefund` blocks approval until a staff manual refund is recorded (`backend/src/services/prepaid/amendmentFunding.service.ts:170`).

## Cancellations

- Direct/public Razorpay shipments: cancellation stores an immutable refund plan and completes only after every planned provider refund is confirmed. A pending provider refund blocks approval; retry checks the existing refund instead of creating a second one.
- Cash-receipt and walk-in/counter shipments: staff must record the offline payout method and reference before approval. The portal does not send the money itself.
- Legacy `BUSINESS_WALLET` shipments: the preview now marks a manual refund as required (`backend/src/services/shipmentCancellation.service.ts:398`). Approval rejects a request without payout (`shipmentCancellation.service.ts:627`), records `MANUAL_REFUNDED` instead of any wallet credit (`shipmentCancellation.service.ts:737`), and writes method/reference/note to the completion audit (`shipmentCancellation.service.ts:978`).
- If the reviewed fee leaves no refundable amount, no payout is required; only the cancellation documents are issued.

## Ledger and authorization

- Client ledger: `GET /api/v1/client/account-ledger`, mounted behind `requireRole("client")` (`backend/src/routes/client.routes.ts:129`, `:175`). The controller requires an active financial membership and rejects security-locked or unsupported accounts (`backend/src/controllers/prepaid.controller.ts:14`).
- Staff ledger: `GET /api/v1/business-accounts/:businessAccountId/payments-ledger` and `/export`, restricted to `admin`, `finance`, and `operations` (`backend/src/routes/adminPrepaid.routes.ts:7`) plus assigned-branch checks (`backend/src/controllers/adminPrepaid.controller.ts:25`).
- Ledger rows are only verified Razorpay bookings/amendments, shipment cash receipts, and recorded cash refunds (`backend/src/services/prepaid/accountLedger.service.ts:33`, `:40`, `:44`). No wallet balance or wallet top-up rows are emitted.
- Dashboard quick-access, old prepaid-account URLs, and old credit-ledger URLs route to the payments ledger without exposing wallet controls.

## Verification evidence

| Check | Result |
| --- | --- |
| `npm run build` in `portal/backend` | Passed |
| `npm run test:prepaid:offline` | 100 passed, 0 failed |
| `npm run build` in `portal/frontend` | Passed |
| Targeted ESLint on all changed frontend `.ts`/`.tsx` files | Clean |
| `npx playwright test e2e/prepaid-payments.spec.ts e2e/private-rate-cards.spec.ts --workers=1` | 24 passed, 0 failed across desktop and mobile |
| Full 216-test project E2E run | Not used as acceptance: unrelated specs failed on their own mocked-data assumptions and the run timed out; none of the targeted payment specs failed |

The offline backend suite uses a temporary local replica set with external services blocked. The targeted browser suite mocks application API responses and makes no provider calls.

### Full-lint caveat

`npm run lint` in `frontend` still reports 8 pre-existing errors in untouched files: `client/quotes/page.tsx`, `dashboard/branches/[branchId]/page.tsx`, `dashboard/flight-linehauls/page.tsx`, `OperationsMarquee.tsx`, `BookingPausedNotice.tsx`, `BranchFileView.tsx`, and `ParcelScanner.tsx`. These were not introduced by this work. All changed frontend files lint clean.

## Residual risk and production boundary

- Staging Razorpay Checkout/webhook replay, real staging email delivery, carrier test booking, and provider refund dashboard checks still require the manual guide in `WALLET_REMOVAL_MANUAL_TEST_GUIDE.md`.
- Historical wallet/cash/credit records remain readable. They must not be migrated into active balances or replayed as new payments.
- Deployment is manual and has not been performed as part of this work.
- Playwright-generated `.next-playwright-*` entries and failure artifacts were removed after testing; `frontend/eslint.config.mjs` ignores `.next-*/**`.

## Acceptance decision

The code is safe to hand off for staging acceptance: no active shipment flow can create, debit, credit, reserve, or top up a wallet. The legacy wallet cancellation path now fails closed until an offline refund is explicitly recorded.
