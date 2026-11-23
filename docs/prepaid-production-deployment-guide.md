# Swiftline prepaid release deployment

This guide deploys the prepaid release into the existing production installation. Pushing `main` does not deploy it; deployment is manual. Production was inspected on 23 November 2026 using read-only database credentials. No production records, indexes, provider payments, or carrier bookings were changed during that inspection.

## Findings that must be resolved before deployment

| Production finding | Required action |
| --- | --- |
| Existing wallets have no tenant owner | The release migration assigns ownership only after verifying their business accounts belong to Swiftline. The explicitly selected zero-opening cutover below resets their opening balances once. |
| Historical top-ups have no tenant owner | The release migration assigns the verified ownership and preserves payment statuses, references, and amounts. |
| Old amendment requests are pending for the same shipment | Resolve these in the existing staff amendment workflow before cutover. Review the shipment and approve the intended request or reject obsolete duplicates with a recorded reason. Do not directly change request status in MongoDB. The release preflight blocks until none remain. |
| Legacy credit and customer advances remain recorded | Management has approved discarding these old operational balances and starting Swiftline business wallets at zero. Use `--zero-opening-balances` for this release; it snapshots the old balances, zeroes legacy limits/outstanding/advances and closes the old facilities. It does not transfer advances into wallets. |
| Historical top-ups are marked CAPTURED | Preserve original captured amounts, payment statuses and provider references as history. Do not add their total to wallets or replay captures to create opening funds. The approved opening balance is zero; the reset does not refund or void an external payment. |
| Required prepaid indexes are missing, and an old top-up order index conflicts with the current partial index | Run the dedicated release migration below. Production disables automatic index creation. |
| An operator tenant is already active | Use the dedicated prepaid release migration. Do not rerun tenant initialization or its automatic advance-transfer step. |

The read-only relationship audit found no unresolved orphan references, no cross-tenant parent references, and no shipment account/branch mismatches. Accepted historical reference exceptions remain covered by the existing reviewed exception rules. The initialization-runner blockers describe the already-active tenant installation; they do not authorize bypassing that runner's safety checks.

The detailed audit logs stay outside version control. They contain production host details, account identifiers, balances, dates and counts and should be kept with the private release records, not copied into public issues or source files.

## Existing data after release

- Existing shipments, tracking identifiers, invoices, issued tax adjustment documents and payment history remain intact. The release does not retrospectively reprice shipments.
- Every existing Swiftline wallet starts at zero under the approved one-time cutover. Held funds must first be released/reconciled through their workflow; the script refuses to erase reservations. It resets the funding-cycle baseline so the next genuine top-up starts a new low-balance alert cycle.
- Legacy Swiftline credit limits, unbilled/outstanding summaries and customer-advance balances become zero, and credit accounts become CLOSED. Statements, credit ledger history, security-deposit settings and issued financial documents remain archived; they are not rewritten or deleted. New bookings use prepaid payment only.
- Per-account audit snapshots preserve the previous balances. A nonzero wallet reset appends an `ADMIN_DEBIT` adjustment; an already-zero wallet gets no fictitious debit. A durable completion marker prevents all later reruns from resetting new deposits or subsequently created wallets. Operator records remain unchanged.
- The cash-receipt, receipt-read, cash-allocation, direct-payment and shipment-funding collections acquire their required indexes. New workflow records are created as users perform the corresponding actions.
- Existing business accounts without a volumetric discount continue with the default zero discount. Staff can set a discount through the account's rate-card controls; it is used when calculating new booking prices.

## 1. Prepare and record the release

1. Resolve the pending amendments through the existing workflow. Record management's approved zero-opening policy in the change record; no old credit, advance or captured-payment total becomes an opening wallet credit. Review all pending provider activity before pausing writers.
2. Take an Atlas snapshot or confirm point-in-time recovery and record its reference. Verify that the backup can be restored. Preserve the current server environment and scheduled-job configuration in the existing secure backup location.
3. Record the current deployed Git SHA, Node version, frontend/backend PM2 process names, job locations, and current Razorpay mode. The local database audit does not verify the server's running SHA or environment.
4. Set a maintenance window. Both the frontend and backend change; avoid running the old backend alongside the new backend against the same financial collections.

Use the existing checkout path. The checked-in job configuration refers to `/var/www/Swiftline-portal`; verify that this matches the server before running commands.

```bash
cd /var/www/Swiftline-portal
git status --porcelain
git rev-parse HEAD
node --version
pm2 list
git fetch origin
```

The checkout must be clean. Save any server changes before proceeding; do not discard them with a hard reset or `git clean`. Record the previous SHA and the release SHA returned after the push:

```bash
PREVIOUS_SHA=$(git rev-parse HEAD)
RELEASE_SHA=$(git rev-parse origin/main)
printf '%s\n' "$PREVIOUS_SHA" "$RELEASE_SHA"
```

## 2. Pause writers and install the pinned release

1. Enable the existing maintenance response for customer and staff booking, payment, amendment, and cancellation entry points. Allow in-flight requests to finish and reconcile uncertain carrier outcomes before stopping services.
2. Pause all scheduled database writers and email workers using the existing job setup. Include root crontabs, `/etc/cron.d/swiftline-jobs`, PM2 workers, and any systemd timers actually installed. Save the exact configuration so it can be restored. Pausing the frontend alone is insufficient.
3. Stop the existing frontend and backend PM2 processes by their verified names. Do not stop unrelated PM2 applications.
4. During maintenance, return a temporary failure such as HTTP 503 for Razorpay webhook delivery so the provider can retry. Do not return a fake success response or route the webhook to a maintenance HTML page returning 200. Keep the window short and check provider delivery history afterward.

Razorpay documents retries after unsuccessful delivery and duplicate event IDs; see the official [webhook guidance](https://razorpay.com/docs/webhooks/best-practices/).

```bash
# Set these to the two names recorded from pm2 list.
pm2 stop "$FRONTEND_PM2_NAME" "$BACKEND_PM2_NAME"
git merge --ff-only "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
cd backend
npm ci --include=dev
npm run build
cd ../frontend
npm ci --include=dev
npm run build
cd ..
git status --porcelain
```

Keep the existing production API URL for the frontend build. `NEXT_PUBLIC_*` variables are embedded during build. Retain the existing operator flags and parcel-number format; this prepaid release does not require changing either. Stop on a failed command. Never build into the same `.next` directory while a frontend process is serving it.

## 3. Check production settings without printing secrets

Verify the existing secure server environment contains:

- `NODE_ENV=production` and the normal production application database user in `MONGODB_URI`.
- Matching live-mode `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. Preserve the existing webhook secret so delayed deliveries remain verifiable.
- The existing webhook URL ending `/api/v1/webhooks/razorpay`, with `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, and `refund.failed` enabled. The proxy must forward the original raw request body and Razorpay signature/event-ID headers.
- Valid public-booking branch, production client URL, HTTPS/CORS, reCAPTCHA, existing storage permissions and email settings. Retain `TAX_ID_ENCRYPTION_KEY` and all existing unrelated encryption/signing secrets.
- The intended top-up limits in paise. No Razorpay key belongs in a `NEXT_PUBLIC_*` variable.

The migration uses separate temporary credentials provided through the server's secure environment mechanism. Do not paste credentials into shell history, commit them, print `.env`, or reuse the read-only audit account as the application/write user:

```bash
export NODE_ENV=production
export TENANT_MIGRATION_ALLOWED_CLUSTER_HOST='<approved-production-atlas-host>'
# Securely supply TENANT_AUDIT_MONGODB_URI (read only).
# Securely supply TENANT_MIGRATION_MONGODB_URI (temporary migration user).
```

Both migration URIs must target the named `swiftline` database on the approved host. Use separate audit and migration database users. The migration user needs only the reviewed collection-update, transaction and index privileges, including inserts into `auditlogs` and `prepaidtransactions`; remove or revoke it after the release.

## 4. Run the dedicated release preflight and migration

```bash
cd /var/www/Swiftline-portal/backend
npm run audit:prepaid-release -- \
  --database swiftline \
  --zero-opening-balances \
  --cluster-host "$TENANT_MIGRATION_ALLOWED_CLUSTER_HOST"
```

This command reads only. `blockers` must be empty. `ownership`, `walletsMissingCycleMetadata`, `missingIndexes`, and the known old top-up index replacement describe the proposed work. `zeroOpening` shows balances to remove and accounts to close; review it against the private backup/audit. Existing valid operator records are preserved. An unknown incompatible index, duplicate financial key, invalid balance, ownership mismatch, held funds, unresolved prepaid payment or pending Swiftline request stops the release.

With all writers still paused, use the recorded release/backup values. Create the private log directory outside the repository first. The log filename must be new for every run.

```bash
npm run migrate:prepaid-release -- \
  --database swiftline \
  --zero-opening-balances \
  --cluster-host "$TENANT_MIGRATION_ALLOWED_CLUSTER_HOST" \
  --writers-paused \
  --change-id "$CHANGE_ID" \
  --backup-ref "$BACKUP_REFERENCE" \
  --run-id "$MIGRATION_RUN_ID" \
  --artifact-sha "$RELEASE_SHA" \
  --log-file "$MIGRATION_LOG_ABSOLUTE_PATH" \
  --confirm 'APPLY SWIFTLINE TENANT MIGRATION swiftline'
```

The script checks the clean checkout and release SHA, named database and host, separate credentials, change/backup/run references, and explicit maintenance declaration. It repeats preflight using the writer before changing anything.

With `--zero-opening-balances`, verified ownership assignment, balance snapshots, zero resets, legacy closure, wallet adjustments and the completion marker commit in one database transaction. Index changes follow while writers remain paused. Payment amounts/statuses/provider IDs, existing operator documents, receipt history, shipments, invoices, statements and previous ledger entries remain intact. The script does not delete collections, replay captures, transfer advances, refund payments or create shipments. Without this explicit flag the migration only repairs ownership/metadata/indexes and preserves all balances. The legacy unique wallet lookup index is retained. Only explicitly recognized obsolete cash-receipt indexes and the old top-up order index may be replaced.

Index changes are not transactional. If any step fails, keep maintenance active, inspect the log, resolve the named issue, and rerun the same release with a new run ID and log filename. The migration is tested for safe reruns.

Rerun `audit:prepaid-release` with `--zero-opening-balances`. Expect `zeroOpening.alreadyApplied: true`, zero ownership changes, zero missing metadata, zero missing/replacement indexes, and zero blockers. Before accepting new payments, verify every Swiftline wallet has zero cash/held balance and old credit summaries are zero/CLOSED. Keep the migration log and snapshots. Existing modeled record counts remain unchanged except for the explicitly reported wallet debit adjustments; audit snapshots/marker are additional records. Do not remove the completion marker or change its key to rerun the reset. Do not run `tenant:migrate:production`/`runProductionSwiftlineTenantMigration`, `credit:migration:prepaid-wallet-cutover`, `syncIndexes`, demo creation scripts, database cleanup scripts, or test suites against production.

## 5. Start the release and run controlled acceptance

1. Start the existing backend process with the production environment; verify its log reports a connected database.
2. Check `http://127.0.0.1:5000/api/v1/health` or the configured backend port. HTTP 200 alone is insufficient: `services.mongodb` must be `connected`. Check the public HTTPS health URL too.
3. Start the existing frontend process. Keep general booking access restricted while a release operator checks the UI. Confirm both processes are serving the recorded release.
4. Check a staff and business-client login, business available balances, account ledger, historical shipment/invoice access, document center, and the active operator workspace. All existing Swiftline wallets must show zero before new payments resume. A later rerun must preserve legitimate new deposits.
5. Restore the webhook receiver and verify the existing Razorpay webhook stays enabled. Review deliveries during maintenance and reconcile every captured payment/refund that arrived during the window. Never resubmit a paid shipment merely because its browser request failed.
6. If authorized for the release, use one controlled small real top-up, verify exactly one wallet credit and receipt, then one internal-label-only wallet booking. Check debit, paid invoice and ledger, and the cash-receipt path with approved test data. Production live payments/carrier bookings are not part of the local automated tests and must be separately recorded as release acceptance.
7. Check direct-pay, amendment and cancellation/refund acceptance using the manual guide in `PREPAID_WORKFLOW_TEST_REPORT.md`. A gateway refund may remain processing until provider confirmation. Confirm pending/replayed events never double credit or refund. Use existing approved operational cases rather than creating carrier bookings for testing.
8. Restore the saved scheduled-job setup and email worker. The updated credit billing, overdue and reconciliation scripts skip Swiftline and continue operator credit maintenance. Keep the reservation-expiry job for operator/legacy reservations; it does not automatically resolve uncertain prepaid funding. Keep email drain, public unpaid-draft cleanup and unrelated existing jobs.
9. Remove maintenance when acceptance succeeds. Verify client/admin/operations cash-receipt email delivery and low-wallet notifications as controlled qualifying events occur; a queue entry alone is not proof of inbox delivery.

## 6. Monitor and recover

Monitor wallet/capture totals, duplicate-key errors, unexpected 4xx/5xx responses, failed webhook events, direct payments stuck captured/unallocated, funding in REVIEW_REQUIRED, pending refunds and email failures. Compare a representative account ledger with payment and booking records.

Before financial writes resume, rolling back application code is possible while writers remain paused, but retained index/ownership changes still require review before starting the old application. After the first prepaid top-up, booking or refund, do not simply roll back to the credit-based application: it can post money to the old ledger or allow unpaid shipments. Freeze financial writes and reconcile those events, then fix forward or run a separately reviewed rollback. Never restore an old database snapshot over payments accepted afterward without reconciling those external payments.

Remove the temporary migration credentials from the shell and revoke them. Rotate the read-only credential shared in chat after the audit. Preserve backups, the release SHA, audit output and migration log in the secure release record.

## Verification evidence and limits

The release checks use an isolated local replica set with external service requests blocked, isolated frontend build output, and mocked browser API traffic. These checks do not make production payments or DPD/ALS bookings. The production review is read-only; server configuration, deployed processes, actual Razorpay mode/capture validity and inbox delivery remain deployment checks. The latest local check results are recorded in `PREPAID_WORKFLOW_TEST_REPORT.md`.
