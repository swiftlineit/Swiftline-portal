# Shipment payment release guide

This guide covers the shipment booking UI, booking emails, and the DPD/ALS availability preflight. Automated payment checks use a temporary local MongoDB replica set and mocked Razorpay responses. They do not create real shipments, charge a provider account, send email, or contact ALS/DPD.

## 1. Run isolated checks

From `portal/backend`:

```bash
npm run build
npm run test:shipment:direct-payment:offline
npm run test:operator:shipment-booking:offline
npx tsx --test src/tests/emailTemplates.test.ts src/tests/shipmentBookedAttachments.test.ts
```

The payment-only test command uses synthetic provider responses and selects tests that do not book shipments. It verifies:

- ALS-disabled DPD-required payment orders are rejected before checkout.
- An explicit no-DPD selection passes that preflight.
- An authorized payment is not captured if ALS becomes unavailable before verification.
- A mocked Razorpay order/payment can be verified and captured without creating a shipment.
- A captured but unallocated payment can be refunded without creating a shipment.
- DPD readiness and payment retry state rules.

The operator integration command uses its own temporary local database, blocks external service access, and verifies the internal-label booking/email workflow without a DPD/ALS booking.

From `portal/frontend`:

```bash
npx tsc --noEmit
npx eslint src/lib/shipmentPayments.ts src/components/shipments/ClientDpdDraftReview.tsx "src/app/dashboard/dpd-labels/[draftId]/page.tsx"
npm run build
```

Run commands in an isolated CI/staging checkout with dependencies installed. Do not point the offline runner at a shared or production MongoDB; it creates and removes its own temporary database.

## 2. Staging payment-only acceptance

Use a staging deployment, disposable account, and Razorpay test credentials. Do not use production customer or payment data.

1. Disable ALS in staging and leave DPD booking enabled in the admin setting.
2. For a UK shipment requiring a DPD label, start the normal payment action. Confirm the server responds with `DPD_BOOKING_DISABLED` before a Razorpay order or checkout is opened.
3. Choose **Book Without DPD Label** and confirm the explicit no-DPD selection can create a test-mode order. Cancel checkout before authorizing a payment. Confirm no payment is captured and no shipment, funding allocation, DPD docket, or carrier request is created.
4. Do not complete a successful staging checkout for this payment-only acceptance: checkout verification captures the test payment before booking continues. The automated offline suite covers successful capture, unallocated-payment refund, and the ALS-disabled authorization case without leaving captured test money in the staging ledger.
5. Re-enable ALS only when its staging credentials/configuration are valid. Confirm the client availability response reflects the effective setting. Do not perform a DPD label booking as part of this acceptance.
6. Check the email outbox/template rendering in staging or test fixtures. Do not send test messages to real consignors.

The server-side preflight is authoritative. A UI-disabled button is not a substitute for these API checks.

## 3. Deploy safely

1. Back up the current release reference and confirm a tested database restore path.
2. Deploy the backend and frontend as one release, with the backend route changes available before enabling the updated frontend. Keep bookings in maintenance mode during the rollout so old frontend instances cannot offer stale payment behavior.
3. Preserve the existing Razorpay credentials and webhook configuration. Keep secrets server-side; never add them to `NEXT_PUBLIC_*` variables.
4. Verify the deployed `ALS_ENABLED`, required `ALS_*` configuration, and global DPD booking setting without printing secrets. If ALS is disabled or misconfigured, DPD-required checkout must remain blocked while the explicit no-DPD option remains available.
5. Verify health checks, login, shipment draft access, and payment status pages. Review backend logs for DPD availability and payment reconciliation errors.
6. Resume booking traffic only after both frontend and backend report the new release and staging acceptance is complete.
7. Monitor Razorpay captured/unallocated payments, `REFUND_PENDING` payments, failed verification requests, DPD-disabled responses, email outbox failures, and consignor delivery reports.

Do not use a production payment or carrier booking as a deployment smoke test. If availability changes after a provider has already captured a payment, the application starts the unallocated-payment refund flow; reconcile the provider status before asking the customer to retry.

## 4. Release gate

Automated/offline tests cannot establish production Razorpay configuration, webhook delivery, ALS credentials, or inbox delivery. Confirm those operational settings separately. Do not mark the release fully verified if a relevant booking/email integration test is failing; investigate its fixture or environment and record the result before rollout.
