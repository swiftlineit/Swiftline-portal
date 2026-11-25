# Prepaid workflow verification and browser guide

> Historical release report. It describes the earlier wallet-based prepaid flow and is superseded by `WALLET_REMOVAL_FINAL_REPORT.md` and `WALLET_REMOVAL_MANUAL_TEST_GUIDE.md`.

Date: 23 November 2026

## Latest release verification and production audit

This section supersedes the earlier local check counts below. Deployment is manual and has not been performed.

| Release check | Latest result |
| --- | --- |
| Isolated backend prepaid, migration, receipt-index, pricing, cancellation/refund and label tests | 133 passed, 0 failed |
| Backend TypeScript build | Passed |
| Frontend production build | Passed with isolated `.next-prepaid-release` output |
| Frontend TypeScript check | Passed |
| Frontend unit checks for action menus, cancellation fees and dashboard destinations | 7 passed |
| Desktop and mobile browser checks for Payments, receipts, document unread badges, business ledger and volumetric discounts | 28 passed; mocked APIs, no provider calls |
| Focused frontend ESLint excluding the existing branch-detail baseline | Passed |
| Existing branch-detail lint baseline | Two pre-existing `react-hooks/set-state-in-effect` errors and two unused-symbol warnings; the affected loader calls are unchanged from the pre-release base |
| Read-only tenant schema audit | Passed: 142 models, 62 tenant-owner links, 202 reviewed parent links |
| Production database audit | Completed read-only; see release findings below |
| Source scan for credentialed non-example database URIs, private keys, live Razorpay keys and AWS access keys | No matches in release files |

Playwright completed all 28 cases successfully; its isolated Windows Next test server required process cleanup before the runner exited with status 0. The user's development server was preserved. No production data was written and no real Razorpay/DPD/ALS operation was made by these checks.

After management approved zero opening balances, the backend suite and TypeScript build were rerun for the migration change. The frontend and browser rows above retain the previous release checks; no frontend code changed in this follow-up. The 10 added migration cases exercise the explicit reset and its failure/rerun safeguards against a temporary local replica set, with external services blocked.

The production database has legacy wallets and top-ups without tenant ownership, missing prepaid indexes, pending amendment requests for one shipment, historical customer advances, and historical top-ups marked CAPTURED. Exact production identifiers, amounts, dates and counts are kept in private audit outputs rather than source control. Management has approved starting Swiftline wallets at zero and resetting old credit/advance summaries instead of transferring them. The explicit `--zero-opening-balances` cutover snapshots old balances, closes legacy credit accounts and preserves original payment amounts/statuses/provider references, documents and historical ledger entries. This reset does not issue gateway refunds. Pending amendments must still be resolved through their workflow before deployment, and any in-flight payments or held funds must be reconciled.

The broad tenant-initialization runner cannot be used because an operator tenant is already active. The new `audit:prepaid-release` / `migrate:prepaid-release` commands provide a separate maintenance-only path with ownership checks, duplicate/index preflight, guarded apply and postflight verification. Omitting the reset flag retains the original balance-preserving migration. The reset has a permanent completion marker, per-account audit snapshots and append-only adjustments for nonzero wallets; it cannot reset later deposits or newly created wallets on a rerun. Local migration coverage includes read-only preflight, active-operator isolation, preserved captured history/documents, held-fund and in-flight-payment blocks, invalid money/ownership checks, transactional rollback, zero-wallet behavior, orphaned-adjustment blocking and safe reruns. The audit map correctly accepts standalone receipts with no shipment reference. Root Swiftline credit billing, overdue and reconciliation scheduled jobs skip the retired facility; operator processing continues.

Follow [the production deployment guide](docs/prepaid-production-deployment-guide.md) for backups, maintenance, exact commands, acceptance and rollback limits. Detailed production audit logs are excluded from Git. The release has not been verified on the production server, against the live Razorpay account, or through real email inbox delivery.

## What changed

- Client Payments has one primary **Available to book** figure and two separate supporting balances for wallet total and funds held for bookings. Top-up uses Razorpay Checkout after the customer accepts the payment declaration; the portal does not collect card details.
- Concurrent first visits for a business wallet now recover from the unique-key creation race by reading the wallet created by the winning request, instead of returning the reported duplicate-key 500.
- Payment history separates **Wallet activity** from the full business **Account ledger**. The account ledger includes captured Razorpay booking payments, wallet top-ups and debits, cash receipts, and refunds. Wallet activity is paginated at 50 rows and shipment-related rows link to their shipment. Receipt history is capped at five visible rows per page, uses a compact two-line summary, and opens a receipt preview where download/print are available.
- The staff wallet ledger has a cleaner account header and includes Razorpay booking payments. Export opens a date-range popup. Admin quick-access links are deduplicated by destination, with a regression test for the business-account link.
- The booking cash-receipt modal now loads the logged-in staff name. Staff first save receipt details, then choose whether to book with a carrier label or without a DPD label. Saving the receipt draft alone does not create a shipment or contact DPD/ALS. Finalizing the booking creates one shipment-linked receipt.
- Standalone cash receipts have no destination field. Their compact PDF includes the amount in words, the history is paginated, and the form and history panels share a height on desktop. Standalone receipts remain staff-only and do not change a wallet or create a shipment.
- Standalone history fetches the selected page and date range; stale responses are ignored if a newer page/filter request replaces them.
- Business amendment approval no longer treats its own pending amendment as a conflicting request. A second pending amendment for the same shipment remains blocked. Business increases are secured from the business wallet after top-up; individual and public increases keep direct payment.
- Cancellation refund retries check the existing Razorpay refund status rather than starting another refund. A pending provider refund remains pending until Razorpay reports it processed. Cash-funded cancellations require staff to record an offline payout method and reference; the portal does not send that cash refund automatically.
- A stale unique index on the connected test database blocked standalone cash receipts. The reviewed migration corrected only the cash-receipt indexes on the authorized test database; the four existing receipt records were preserved.

## Verification evidence

| Check | Result |
| --- | --- |
| Backend prepaid workflow offline suite | 91 passed, 0 failed across 9 suites |
| Connected Atlas workflow cases | 13 passed; focused staff receipt-default case 1 passed |
| Cash receipt index migration preflight | 4 existing receipts retained; no duplicate active shipment receipts |
| Cash receipt index migration tests | 13 passed |
| Backend TypeScript build | Passed |
| Frontend TypeScript check and targeted ESLint | Passed after the pagination effect cleanup |
| Dashboard quick-access regression test | 1 passed |
| Prepaid Payments Playwright | 10 passed across desktop Chromium and Pixel 5; standalone pagination also passed again after the effect cleanup |
| Frontend production build | Passed using isolated `.next-prepaid-final` output; webpack emitted a non-fatal OneDrive cache-file rename warning |
| `git diff --check` | Passed; Git reports line-ending normalization notices only |

The local backend suite uses a temporary MongoDB replica set and blocks external services. The connected Atlas test run used scoped test records and removed those records after each case; it did not alter shipment or payment history. Browser tests mock application API responses and block provider requests. No production database, live Razorpay checkout/refund, customer email delivery, DPD/ALS booking, or deployment was tested.

## Manual browser acceptance guide

Run this guide in an isolated staging environment with disposable users and payment data. Confirm the frontend API target and database are staging before starting. Use Razorpay test mode and keep carrier booking disabled unless you specifically intend to create a test carrier booking. Never reuse production payment credentials or customer data.

### 1. Client wallet and top-up

1. Sign in as a business account user and open **Payments**.
2. Confirm **Available to book** is the prominent balance. Read the separate **Wallet total** and **Held for bookings** amounts; available should equal total minus held funds.
3. Accept the payment declaration, enter a small staging amount and select **Top up with Razorpay**. Confirm Razorpay Checkout opens. The portal itself must not ask for card number, CVV, or bank credentials.
4. Cancel Checkout and refresh. No funds should be added. Complete a test payment; the exact amount should appear once. Refresh and replay the same webhook event using the staging webhook procedure; the balance must not increase again.
5. Try to start a top-up without accepting the declaration. Checkout must remain closed.

### 2. Client wallet activity and account ledger

1. In Payments, review **Wallet activity**. It should show wallet credits, shipment debits, holds/releases and refunds, with up to 50 rows per page.
2. Follow a shipment link from a booking, amendment, or cancellation row and confirm it opens the matching shipment.
3. Review payment receipts. At desktop width, the receipt panel should match the top-up panel height and show five compact two-line rows per page. Each row has a **View** action; download and print are available from the receipt preview.
4. Switch to the full **Account ledger**. Confirm direct Razorpay shipment payments appear here, even though they do not credit or debit the wallet. Confirm a top-up is represented once as a wallet funding event and that exports use the selected date range.

### 3. Paid-before-booking rules

1. As a business client, try to book above the available wallet balance without paying. Booking must be blocked. Add funds or complete the supported payment flow, then verify exactly one shipment and one paid invoice.
2. Repeat as staff for a business client. Staff must not bypass the payment requirement.
3. As an individual client, cancel or leave direct Razorpay Checkout pending. No shipment should be created. Complete a test payment and confirm the shipment appears once.
4. Repeat in public booking. A cancelled, failed, or pending payment must not create a paid booking.

### 4. Cash receipt during a business booking

1. As admin or operations staff, open an unbooked business shipment and choose **Cash received by Swiftline**.
2. Confirm the modal pre-fills the business name, date, shipment price, payment details, shipment details, and **Recorded by** with the signed-in staff user's name. Edit the permitted recipient/date fields and enter a payment reference.
3. Save the receipt details. Confirm this saves the receipt form only: there is no shipment yet and no DPD/ALS request.
4. Choose the no-label booking action. Confirm one shipment, one finalized receipt and one paid invoice. The wallet must not be debited. In a separate isolated staging run, the label action may be tested only if a carrier test booking is explicitly intended.
5. Open the receipt from staff and client shipment details. Check the logo, receipt ID, date, amount, payment reference, staff name, shipment details, and **System generated receipt** footer. Confirm the business client sees it in Documents and that another business account cannot access it.
6. Check the client/admin/operations staging inboxes. A queued email or outbox record is not proof of delivery.

### 5. Standalone staff cash receipt

1. As admin or operations, open **Operations → Cash receipts** and create a standalone receipt with the business account, amount, reference, and shipment details.
2. Confirm the receipt form and history panels have matching desktop height; history shows five rows per page. Confirm the preview is compact, has no destination address, and spells out the amount in words.
3. Confirm no shipment or wallet balance changes. The receipt must remain staff-only and must not appear in the client's Document Centre.

### 6. Low-wallet alert

1. Use a fresh business wallet. Add ₹3,000 and note the funding baseline.
2. Make internal test bookings until the remaining available funds reach ₹600 or below.
3. Confirm the business account users and relevant staff receive one alert. Check the staging email inbox as well as portal notifications.
4. Retry or refresh and confirm the same threshold alert is not duplicated. Add funds and confirm the next funding cycle can alert once at its own threshold.

### 7. Amendments

1. Start with a paid business shipment. Request a price increase. Confirm a success toast and the pending request; try submitting another request and confirm it is blocked.
2. With insufficient wallet funds, confirm the client is directed to top up and no Razorpay fallback is offered for a business amendment. Top up, reopen the saved amendment and secure the exact increase from the wallet.
3. As staff, try to approve before payment is secured; approval must be blocked. After wallet payment, approve once. Rejecting a secured amendment should release its reservation once.
4. Request a price reduction. Confirm only the difference is credited once, including when approval is retried.
5. Repeat with individual/public shipments and confirm direct Razorpay payment remains required before approval.

### 8. Cancellations and refunds

1. Cancel a wallet-funded business shipment. Confirm the refundable amount after the fee returns to that business wallet once.
2. Cancel a Razorpay-paid shipment. Confirm the refund goes through the original payment source. If Razorpay shows it as pending, the portal should show a pending status and a **Check refund status** action. Retry after the provider updates; it must check the existing refund and must not create a second one.
3. Cancel a cash-receipt shipment. Staff must record the actual offline payout method and reference. Confirm the cancellation does not falsely claim an automatic Razorpay or wallet refund.

### 9. Staff ledger, navigation, and permissions

1. In **Business Accounts**, use the ledger action and confirm it opens that business's wallet/account ledger.
2. Confirm the account ledger includes Razorpay booking payments and cash receipts. Export a selected date range and compare a few entries with the history shown on-screen.
3. Test client financial access, another business account, and a staff user outside the assigned branch. Each must be denied access to another account's ledger, receipt, payment or shipment.
4. Open legacy credit URLs and confirm they route to the prepaid experience. Existing shipment invoices must remain available.

## Production handoff boundary

The index repair was applied only to the authorized Atlas test database. Production requires a read-only duplicate/index/reset preflight and an explicitly scheduled migration after backup; the migration is not automatic. The legacy credit UI routes to prepaid screens. For the approved fresh start, use the dedicated release procedure with `--zero-opening-balances`; do not use the older advance-transfer migration. Swiftline opening wallet balances and legacy credit/advance summaries become zero once. Existing shipments, invoices, statements, receipts and payment/ledger history remain intact, and operator accounts are unchanged. No production reset or physical deletion has been run.

Production acceptance still requires staging checkout/webhook replay, real staging email delivery, the no-label booking flow, provider refund status checks and the reviewed production index/cutover procedures. This report does not claim those external or production checks have passed.
