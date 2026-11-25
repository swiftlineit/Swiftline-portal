# Wallet Removal Manual Test Guide

Date: 25 November 2026

Use this guide in an isolated staging environment with disposable users, business accounts, and Razorpay test mode. Disable real carrier booking unless a deliberate test booking is required. Do not use production credentials, customer data, or payment records.

## Preconditions

1. Confirm the frontend and backend point at staging, not production.
2. Prepare:
   - a business client login with a financial role;
   - an admin/operations staff login with branch access to that business;
   - a finance staff login for ledger checks;
   - a client login without a financial role;
   - a public booking route;
   - an operator workspace login if operator flows are in scope.
3. Use small test amounts and record the Razorpay test payment IDs for reconciliation.
4. For the legacy wallet case, seed or identify a historical booked shipment whose completed `ShipmentFunding.source` is `BUSINESS_WALLET`, whose active invoice is not voided, and which has a `SHIPMENT_BOOKED` event.

## 1. Confirm wallet entry points are gone

1. Sign in as the business client and open the dashboard, Payments, Shipments, rate card, and Document Centre.
2. Confirm there is no **Top up**, **Wallet total**, **Available to book**, **Held for bookings**, wallet balance card, wallet activity tab, or wallet column.
3. As staff, open Business Accounts, the account detail page, Amendments, Cancellations, and the sidebar.
4. Confirm there is no wallet ledger, wallet top-up action, or wallet balance column. The standalone **Cash Receipts** page remains under Operations.
5. Open the old prepaid-account and credit-ledger URLs. They should redirect to the staff payments ledger or business-account ledger, not a wallet screen.

## 2. Client DPD booking with direct Razorpay

1. As the business client, create a DPD shipment and reach payment/review.
2. Confirm the only supported payment action is direct Razorpay payment.
3. Cancel or fail Checkout and refresh. No shipment should be created and no invoice should be paid.
4. Complete a test payment. Confirm exactly one shipment, one paid invoice, and one `RAZORPAY_BOOKING_PAYMENT` row in the client ledger.
5. Replay the staging capture webhook. The ledger must not duplicate the payment or create any wallet credit.

## 3. Staff DPD booking

1. As admin/operations, open an unbooked business shipment.
2. Confirm the available funding options are direct Razorpay and **Cash received by Swiftline** only.
3. Complete a direct payment booking and verify one paid invoice.
4. Try to submit a booking with a wallet/top-up funding source through the API or by manipulating the request. The server must reject it; the UI must never offer it.

## 4. Staff cash receipt booking

1. On another unbooked business shipment, choose **Cash received by Swiftline**.
2. Confirm the form shows the business name, date, shipment amount, receipt details, shipment details, and the signed-in staff member as recorder.
3. Save the receipt draft only. Confirm no shipment, no DPD/ALS call, and no invoice are created.
4. Finalize and book without a carrier label. Confirm:
   - one shipment;
   - one paid invoice;
   - one finalized shipment-linked cash receipt;
   - one `SHIPMENT_CASH_RECEIPT` row in the client and staff ledgers;
   - no wallet debit or wallet balance change.
5. Open the receipt from shipment details and Document Centre. Confirm another business account cannot access it.
6. Check the staging outbox/notification queue for client and staff receipt notices. A queued record is not proof of inbox delivery.

## 5. Public booking

1. Open the public booking route and complete all required shipment and policy steps.
2. Confirm the only payment path is Razorpay and that cancelling Checkout creates no paid booking.
3. Complete a test payment and verify one paid public shipment with `PUBLIC_RAZORPAY` funding.
4. Confirm no wallet balance or wallet funding row is created anywhere.

## 6. Operator workspace

1. Sign in as an operator user and confirm the workspace still uses its existing credit/advance and counter-payment flows.
2. Book and cancel a test operator shipment using the normal operator workflow.
3. Confirm no Swiftline wallet control or wallet ledger appears in the operator portal.
4. Confirm operator balances and counter records are not written into the Swiftline payments ledger.

## 7. Amendments

### Increase

1. Start with a paid direct-booking shipment.
2. Request a price increase and confirm the exact difference is displayed.
3. Complete direct Razorpay payment before approval.
4. As staff, try to approve before payment is secured. Approval must be blocked.
5. Approve after payment and confirm the invoice increases once with one `RAZORPAY_AMENDMENT_PAYMENT` row.

### Reduction with gateway payment

1. Request a reduction on a shipment with a captured Razorpay payment.
2. Approve once and confirm the refund goes to the original payment source.
3. Retry approval and refresh the payment status. No second refund may be created.
4. If Razorpay reports the refund as pending, the portal must show pending status and only complete after the provider confirms it.

### Reduction without gateway payment

1. Use a cash-receipt-funded shipment or a direct payment already fully refunded.
2. Request a reduction.
3. Confirm approval is blocked with: **No captured online payment can cover this reduction. Record a manual refund before approval.**
4. Record the staff refund reference and approve once. Confirm the amendment shows `CASH_REFUND_RECORDED` and no wallet is credited.

## 8. Cancellations

### Direct or public Razorpay shipment

1. Request cancellation and review the fee/refund split.
2. Confirm approval starts or reuses a Razorpay refund, not a wallet credit.
3. If the provider refund is pending, approval must remain pending. After provider confirmation, retry and confirm no duplicate refund.
4. Confirm the cancellation shows **Refunded to original payment method** and a Razorpay refund reference.

### Cash-receipt or counter shipment

1. Request cancellation with a refundable amount.
2. Try approving without a payout. Approval must fail with: **Record how the refund was paid back to the customer before completing this cancellation.**
3. For a non-cash method, try approving without a reference. Approval must fail with: **Enter the bank, UPI, card, or cheque reference for this refund.**
4. Record method, reference, and note, then approve once.
5. Confirm the cancellation shows a manual/cash refund record and no wallet credit.

### Legacy wallet-funded shipment

1. Use the seeded historical `BUSINESS_WALLET` shipment from the preconditions.
2. Open the staff cancellation preview. Confirm it requires a manual refund when the reviewed fee leaves a refundable amount.
3. Try approving or directly cancelling without a payout. Approval must fail; the invoice must remain active and no `SHIPMENT_CANCELLED` event may be written.
4. Enter a real test payout, for example UPI with reference `UPI-LEGACY-STAGING-001`, and approve.
5. Confirm:
   - cancellation status is completed;
   - refund status is `MANUAL_REFUNDED` and the UI shows **Manual refund recorded**;
   - refund amount and reference match the recorded payout;
   - the completion audit contains `paymentRefundStatus: MANUAL_REFUNDED`, the method, and the note;
   - no wallet balance or wallet ledger entry is created or increased.
6. Repeat with a fee that leaves zero refundable amount. No payout should be required, and no refund status should be recorded.

## 9. Ledgers, export, and permissions

1. Client Payments must show only online payments, shipment cash receipts, and recorded cash refunds.
2. Staff Business Account ledger must show the same categories for that account and no wallet rows.
3. Export a date range and compare several rows with the on-screen ledger.
4. Confirm the CSV safely quotes formula-like values and includes only the selected range.
5. As a client without a financial role, open the ledger. Access must be denied.
6. As a client from another business, request another account's ledger with `businessAccountId`. Access must be denied.
7. As staff outside the assigned branch, open the ledger. Access must be denied.
8. As an operator user, request a Swiftline staff ledger. Access must be denied.

## 10. Final source/config sanity checks

1. Search active frontend source for wallet/top-up controls; only historical labels such as **Historical wallet credit recorded** should remain.
2. Search active backend routes/services for top-up and wallet-ledger endpoints; the standalone cash-receipt endpoints should remain active.
3. Confirm `frontend/tsconfig.json` has no `.next-playwright-*` includes after browser testing.
4. Confirm no generated `test-results` or Playwright trace artifacts remain in the working tree.

## Sign-off checklist

- [ ] No wallet balance, top-up, reservation, or wallet ledger UI/API in active flows.
- [ ] Client direct Razorpay booking works once and is idempotent.
- [ ] Staff direct Razorpay and finalized cash-receipt bookings work.
- [ ] Public Razorpay booking works.
- [ ] Operator credit/counter flow is unchanged and isolated.
- [ ] Amendment gateway refunds and manual fallback work.
- [ ] Direct, cash, counter, and legacy wallet cancellations reconcile correctly.
- [ ] Legacy wallet cancellations never credit a wallet.
- [ ] Client/staff ledgers show only direct, cash, and refund rows.
- [ ] Authorization and branch scoping deny cross-account access.
