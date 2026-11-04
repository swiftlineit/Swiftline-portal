# Operator workspace production deployment guide

Updated: 4 November 2026

This runbook covers the first operator workspace release, its database tenant
ownership backfill, tenant-scoped indexes, production rollout, verification,
and rollback. It does not authorize a production database write by itself.

Related references:

- [Operator workspace implementation and release reference](./operator-portal-implementation.md)
- [Operator workspace staging acceptance guide](./operator-portal-manual-test-guide.md)
- [Tenant ownership and data audit notes](./tenant-data-ownership-audit.md)

## Current release position

- The current `main` release observed while preparing this guide was `afb373b`.
  Re-fetch `origin/main` and record the exact deployed SHA at release time.
- The operator-focused Atlas integration tests and the focused Playwright
  tests previously reported by the project owner passed in the test environment.
  Those results are not a production data audit or a live production email test.
- The 4 November read-only production inspection reported database `swiftline`,
  zero active Swiftline root tenants, and sample legacy records without
  `tenantId`. This is enough to block deployment, but it is not a complete
  ownership or index audit.
- **Do not deploy the tenant-aware backend until the protected audit and
  migration process in this runbook passes.** Standalone migration commands
  still reject `NODE_ENV=production`. Production access is available only
  through the dedicated read-only audit and manual migration runner described
  below. Never work around the guard by setting `NODE_ENV=development` while
  pointing any URI at production.
- No production migration has been run by preparing this workflow. Operator
  features remain disabled until the database cutover and Swiftline regression
  gates are complete.

This is a Swiftline compatibility gate as well as an operator gate. The
`establishSwiftlineTenantContext` middleware is mounted for legacy `/api/v1`
routes regardless of `OPERATOR_PORTAL_ENABLED`. It calls
`getSwiftlineTenantId()`, which requires exactly one active `SWIFTLINE` tenant;
without one, legacy API requests reach the error handler and return HTTP 500.
Tenant-owned model reads also filter records by that root tenant ID, so a root
record without the matching ownership backfill can make existing Swiftline
records disappear from scoped queries. The scheduled credit jobs now use
`runOperationalTenantJob()`, which also fails unless exactly one active
Swiftline tenant exists. Turning the operator flags off does not bypass these
paths.

Therefore, before deploying this backend version, confirm in production that
the active Swiftline root exists, all reviewed legacy records have its
`tenantId`, and the required explicit indexes are present. If that is not yet
verified, do not deploy the backend change; use a tested compatibility release
or wait for the approved production audit/migration path. Keep operator flags
off until the same migration and isolation gates pass.

## Release invariants

1. The operator URL and authenticated active membership determine workspace
   access; a slug alone grants no access.
2. Operator and Swiftline records, documents, notifications, mail recipients,
   and billing remain tenant-scoped. Existing Swiftline recipients and carrier
   workflows must keep their current behavior.
3. Operator clients can use only their linked business account and assigned
   branch. Operator staff can choose an account; its branch is resolved by the
   server.
4. Operator booking creates an internal label and AWB. It must not make a
   carrier booking or use Swiftline's carrier credentials.
5. Production MongoDB automatic index creation is disabled. The release must
   explicitly verify and create the required indexes before enabling traffic.
6. All ownership backfills are pre-activation cutover migrations. Operator
   tenants must still be `DRAFT`; do not activate an operator before migration
   completion.

## Phase 1: prepare the release

1. Confirm the intended release SHA is on `main` and matches the tested commit.
   Keep generated `.next-*` output, local reports, secrets, and test database
   dumps out of the release artifact.
2. Build and test the exact release artifact. Record backend/frontend build
   results, the focused operator integration results, and browser acceptance
   results against staging.
3. Complete the [staging acceptance guide](./operator-portal-manual-test-guide.md)
   with real staging identities and synthetic records. Include booking email
   recipient checks and Swiftline regression checks.
4. Confirm no operator is active or suspended in the target database before
   ownership migrations. Keep operator activation and invitations paused through
   cutover.
5. Schedule a database maintenance window. Pause writes that touch collections
   being migrated, including old application instances and any non-tenant-aware
   scheduled workers. Drain or deliberately hold the email outbox before the
   `EmailOutbox` ownership/index changes. Resume only after post-migration
   checks pass.
6. Take a consistent database backup or point-in-time recovery marker and
   rehearse restoring it to an isolated database. Record the backup reference
   in the change record, not in logs or this document.

## Phase 2: rehearse tenant migrations on a restored copy

Run these commands only from `portal/backend` with `MONGODB_URI` pointing at an
isolated staging database restored from production. The scripts default to
read-only preflight unless `--apply` is supplied. The `--database` value must
exactly match the restored database name. Never point a development environment
at production. Run the rehearsal from an isolated migration shell with
`NODE_ENV=development` or `NODE_ENV=test`; do not reuse the production URI or
production credentials in that shell.

```powershell
npm run audit:tenant-data -- --schema-only
npm run audit:tenant-data -- --database "<RESTORED_DB_NAME>" --orphan-summary

npm run migrate:swiftline-root-ownership -- --database "<RESTORED_DB_NAME>"
npm run migrate:account-credit-tenant-ownership -- --database "<RESTORED_DB_NAME>"
npm run migrate:operational-tenant-ownership -- --database "<RESTORED_DB_NAME>"
npm run migrate:shipment-tenant-ownership -- --database "<RESTORED_DB_NAME>"
npm run migrate:business-account-tenant-indexes -- --database "<RESTORED_DB_NAME>"
npm run audit:tenant-registry-indexes -- --database "<RESTORED_DB_NAME>"
npm run audit:operator-support-indexes -- --database "<RESTORED_DB_NAME>"
```

Review each result before applying anything. If the restored-copy preflight is
clean, rehearse the apply sequence against that restored copy only:

```powershell
npm run migrate:swiftline-root-ownership -- --database "<RESTORED_DB_NAME>" --apply
npm run migrate:account-credit-tenant-ownership -- --database "<RESTORED_DB_NAME>" --apply
npm run migrate:operational-tenant-ownership -- --database "<RESTORED_DB_NAME>" --apply
npm run migrate:shipment-tenant-ownership -- --database "<RESTORED_DB_NAME>" --apply
npm run migrate:business-account-tenant-indexes -- --database "<RESTORED_DB_NAME>" --apply
npm run migrate:tenant-registry-indexes -- --database "<RESTORED_DB_NAME>" --apply
npm run migrate:operator-support-indexes -- --database "<RESTORED_DB_NAME>" --apply
```

Then rerun the tenant data audit, each ownership/index preflight, and the two
index audits. Require zero missing or conflicting owners, zero duplicate
tenant-scoped unique keys, no unexpected legacy indexes, and no missing required
indexes. Review all dangling parent references and cross-tenant links; repair or
formally accept each relevant exception with a documented rationale before
operator activation. Historical orphan exceptions recorded for the test Atlas
database apply only to that test dataset; they are not production acceptance
criteria. Do not delete or reassign financial, shipment, audit, or document
history based only on aggregate counts.

The operational ownership and shipment ownership migrations process multiple
collections sequentially rather than as one transaction. The account and
operational index migrations replace legacy global uniqueness with tenant-local
uniqueness. Plan for migration time, index build impact, partial progress, and
the documented rerun/recovery behavior. Do not proceed if any migration stops
with conflicts, duplicates, an unexpected operator state, or a failed
post-migration verification.

### Rehearse the protected runner itself

After the individual restored-copy scripts pass, create a fresh isolated restore
whose database name is `swiftline`. Use a separate Atlas project or cluster so
there is no route to production. Create one read-only database user and one
temporary migration user for this restored cluster, then run the exact protected
production command below with the restored cluster host on its allowlist. Set
`--artifact-sha` to the exact candidate commit that contains the migration
runner. Store the JSONL log outside the repository.

This rehearsal must use `NODE_ENV=production` because it verifies the runner's
production gates. The runner requires a clean Git checkout and verifies
`--artifact-sha` against the checked-out commit before opening the database. It
is safe only because both dedicated URIs and the host allowlist point to the
isolated restored cluster. Use a new restore for every
full rehearsal; the runner is idempotent for recovery, but a fresh restore is
required to measure the complete cutover and index-build duration.

```powershell
$env:NODE_ENV = "production"
$env:TENANT_AUDIT_MONGODB_URI = "<READ_ONLY_RESTORED_CLUSTER_SRV_URI_WITH_/swiftline>"
$env:TENANT_MIGRATION_MONGODB_URI = "<TEMPORARY_RESTORED_CLUSTER_MIGRATION_SRV_URI_WITH_/swiftline>"
$env:TENANT_MIGRATION_ALLOWED_CLUSTER_HOST = "<RESTORED_CLUSTER_HOST>"

npm run migrate:tenant-ownership:production -- `
  --database swiftline `
  --cluster-host "<RESTORED_CLUSTER_HOST>" `
  --change-id "REHEARSAL-<CHANGE_ID>" `
  --backup-ref "<RESTORE_REFERENCE>" `
  --run-id "tenant-rehearsal-<UTC_TIMESTAMP>" `
  --artifact-sha "<CANDIDATE_GIT_SHA>" `
  --log-file "C:\secure-migration-logs\tenant-rehearsal-<UTC_TIMESTAMP>.jsonl" `
  --confirm "APPLY SWIFTLINE TENANT MIGRATION swiftline" `
  --apply
```

The log file must not already exist; the runner creates it with exclusive
access. Review its step start/completion records, the console preflight, the
postflight audit, duration, Atlas performance, and the restored Swiftline smoke
tests. Destroy or expire the temporary migration credential after rehearsal.

## Phase 3: production database cutover

This phase remains blocked until the protected runner has passed the
restored-copy rehearsal and a reviewer has accepted the full read-only
production audit.

1. Confirm the production cluster, database name, backup/PITR point, migration
   artifact SHA, expected operator states, and maintenance window with a second
   reviewer. Use a dedicated read-only audit user. Use a separate temporary
   migration user limited to reads, inserts for the root registry, tenant-owner
   updates, and required index create/drop operations on database `swiftline`.
   Do not grant document deletion, collection/database drop, user management,
   or access to another database. Do not give the application runtime account
   migration privileges.
2. Before the write freeze, run the production audit with the read-only user.
   It validates the exact SRV cluster host and database against the explicit
   command and `TENANT_MIGRATION_ALLOWED_CLUSTER_HOST`. It disables automatic
   collection/index creation and rejects `--apply` and detailed production
   orphan output.

   ```powershell
   $env:NODE_ENV = "production"
   $env:TENANT_AUDIT_MONGODB_URI = "<READ_ONLY_PRODUCTION_SRV_URI_WITH_/swiftline>"
   $env:TENANT_MIGRATION_ALLOWED_CLUSTER_HOST = "<PRODUCTION_CLUSTER_HOST>"

   npm run audit:tenant-data:production -- `
     --database swiftline `
     --cluster-host "<PRODUCTION_CLUSTER_HOST>" `
     --orphan-summary
   ```

   A non-zero exit before migration is expected for planned missing ownership or
   indexes. Review every line. Stop for a conflicting root/slug, existing owner
   outside the intended Swiftline root, duplicate tenant-local keys, malformed
   or dangling business references, cross-tenant links, account/branch identity
   mismatches, or any operator outside `DRAFT`. Missing root ownership and
   missing reviewed indexes are the planned changes, not permission to ignore
   other findings.
3. Reconfirm the backup and write freeze. Apply the same reviewed sequence as
   the restored-copy rehearsal: Swiftline root ownership; account/credit
   ownership; operational ownership; shipment ownership; business-account
   tenant indexes; tenant registry indexes; operator support session indexes.
   Stop all application instances and all workers that can write to MongoDB,
   including email drain, credit jobs, tracking, claims, flight, pickup, public
   booking, and reminder jobs. Confirm active writes are zero. Then run:

   ```powershell
   $env:NODE_ENV = "production"
   $env:TENANT_AUDIT_MONGODB_URI = "<READ_ONLY_PRODUCTION_SRV_URI_WITH_/swiftline>"
   $env:TENANT_MIGRATION_MONGODB_URI = "<TEMPORARY_PRODUCTION_MIGRATION_SRV_URI_WITH_/swiftline>"
   $env:TENANT_MIGRATION_ALLOWED_CLUSTER_HOST = "<PRODUCTION_CLUSTER_HOST>"

   npm run migrate:tenant-ownership:production -- `
     --database swiftline `
     --cluster-host "<PRODUCTION_CLUSTER_HOST>" `
     --change-id "<APPROVED_CHANGE_ID>" `
     --backup-ref "<BACKUP_OR_PITR_REFERENCE>" `
     --run-id "tenant-production-<UTC_TIMESTAMP>" `
     --artifact-sha "<REVIEWED_GIT_SHA>" `
     --log-file "C:\secure-migration-logs\tenant-production-<UTC_TIMESTAMP>.jsonl" `
     --confirm "APPLY SWIFTLINE TENANT MIGRATION swiftline" `
     --apply
   ```

   The runner performs a read-only structural preflight, dry-runs each step,
   applies it in the fixed order, verifies each step, and finishes with a
   read-only full audit. Its authorization token is process-local; importing or
   running an individual migration script in production without this runner is
   rejected. Do not improvise order, reuse an old run ID/log path, or skip a
   migration based on test data.

   The structural preflight has three reviewed reference exceptions. The exact
   reserved `SYSTEM_ACTOR_ID` is valid only in `CreditLedgerEntry.createdBy`
   and `CreditBillingStatement.createdBy`. It also preserves one historical
   email event set: exactly two `SENT` `BUSINESS_ACCOUNT_SUBMITTED` outbox rows
   created at `2026-10-19T09:48:03.667Z`, both pointing to the same missing
   business account. These terminal, denormalized email records are retained as
   delivery history; this does not establish that the account deletion was
   valid. The audit reports accepted counts separately and blocks if the email
   count, timestamp, status, type, or distinct missing-account count differs.
   Every other dangling, malformed, cross-tenant, or identity-mismatched
   reference remains a migration blocker.
4. Run the post-migration audit and all dry-run/index audits. Confirm every
   tenant-owned record has a valid owner, no cross-tenant or account/branch
   mismatches remain, scoped unique indexes exist, and no required index is
   missing. Keep operator tenants in `DRAFT`.
5. If any check fails, keep the write freeze and operator flags off. Follow the
   migration's reviewed recovery procedure; do not remove `tenantId`, drop
   scoped indexes, or retry with a different database connection blindly.
6. After a clean postflight, revoke the temporary migration credential before
   starting application traffic. Retain the read-only audit credential only if
   approved monitoring needs it; otherwise revoke it too. Store the JSONL log
   with the change record. It contains operational metadata and counts, never
   URIs, credentials, document content, or customer data.

### Interrupted-run recovery

The root/account/branch initialization is transactional. The later ownership
and index stages are intentionally idempotent and may have partial progress if
the process or connection stops. Keep the write freeze in place, record the
failed step from the JSONL log, and rerun the read-only audit. If there are no
new structural blockers and the approved backup remains valid, use a new run ID
and log path to rerun the full protected sequence; completed steps verify and
become no-ops. If ownership conflicts, duplicate keys, or unexpected indexes
appear, do not repair ad hoc. Escalate to the database reviewer and choose
between a reviewed corrective migration and restoring the isolated production
backup under the incident plan. A restore rewinds all writes after its recovery
point, which is why application and worker writes remain frozen until the final
audit passes.

## Phase 4: deploy with the operator feature disabled

Use the existing hosting pipeline; this repository does not define the
production application hosting/deployment provider.

1. Set production backend configuration in the existing secret/config store:
   - `NODE_ENV=production`
   - `OPERATOR_PORTAL_ENABLED=false`
   - production `MONGODB_URI` for the application runtime identity
   - `CLIENT_URL`, `CORS_ORIGINS`, and cookie settings for the deployed HTTPS
     origins
   - `MAIL_DRIVER=ses`, verified sender/reply-to, AWS region and SES permissions
   - `STORAGE_DRIVER=s3`, the production bucket/prefix, and an instance/task
     role limited to the required object operations
2. Keep `NEXT_PUBLIC_OPERATOR_PORTAL_ENABLED=false` in the frontend build
   environment. This is a build-time flag; changing it requires a new frontend
   build and deployment.
3. Deploy the backend and frontend from the recorded SHA. Verify health checks,
   startup logs, database connection, and that production did not attempt
   automatic index creation.
4. With both flags off, smoke-test Swiftline staff and client sign-in, booking,
   carrier behavior, invoices, labels, documents, credit, notifications, and
   tracking. Keep Swiftline carrier configuration unchanged; operator policy
   must prevent carrier booking without disabling Swiftline integrations.
5. Confirm the existing scheduled jobs are installed and healthy, especially
   `job:email:drain`, credit reservation expiry/reconciliation, statement
   closing, and overdue processing. The operator release adds no separate
   scheduler requirement, but tenant-aware email delivery still depends on the
   existing drain job. Use [the jobs runbook](../backend/deploy/jobs/README.md).

Production storage must be durable before accepting uploads. Verify logo,
banner, KYC, invoice, and label uploads/downloads against the production bucket
with a non-customer test identity. Verify SES delivery and outbox processing
with approved internal recipients; do not use customer addresses for the first
smoke test.

## Phase 5: enable a controlled operator pilot

Only after database, regression, storage, email, and staging acceptance gates
are signed off:

1. Enable `OPERATOR_PORTAL_ENABLED=true` on the backend and deploy/restart it.
   Confirm operator API health and tenant access denial for an unrelated slug.
2. Build and deploy the frontend with
   `NEXT_PUBLIC_OPERATOR_PORTAL_ENABLED=true`.
3. Activate one approved pilot operator only. Confirm staff and client login,
   account/branch scope, booking with internal AWB/label, invoices, tracking,
   contact queries, and the expected operator-only email/in-app recipients.
   Confirm Swiftline staff receive no operator booking or contact alert.
4. Confirm the operator suspension screen is customer-friendly and hides the
   workspace header; suspension must block new operator access and new notices.
   Previously queued transactional email may finish delivery.
5. Review tenant audit events, access denials, booking/idempotency results,
   invoice/credit entries, email outbox delivery, SES events, storage errors,
   API/frontend errors, latency, and job logs throughout the pilot.
6. Expand activation gradually only after the pilot reconciles and monitoring
   stays healthy. Do not bulk-activate draft operators as part of deployment.

## Environment and access checks

- Store production secrets in the hosting secret manager. Never commit or paste
  connection strings, JWT secrets, SES credentials, webhook secrets, or signed
  document URLs into deployment notes.
- Keep the production app's MongoDB user separate from the migration identity.
  Restrict application network access to the approved database and storage
  resources.
- Use HTTPS for both origins. Set `CROSS_SITE_COOKIES=true` only when the
  frontend and API are on different HTTPS origins; otherwise retain the
  same-site cookie configuration.
- Use a dedicated production S3 bucket when possible. If a bucket is shared,
  ensure `S3_KEY_PREFIX` separates production objects and does not overlap
  development or staging. Test signed URLs and authorization before download.
- Confirm `MAIL_DRIVER=ses`; `noop` is not valid for live transactional email.
  Verify sending identity, reply-to, configuration set, IAM permissions,
  delivery/bounce/complaint visibility, and the tenant-aware outbox drain.
- No frontend flag is a security boundary. Backend route guards and active
  tenant membership checks must remain authoritative.

## Rollback

For a single operator problem, suspend that operator through the platform
control and verify access and new notices stop. For a module-wide problem:

1. Set `NEXT_PUBLIC_OPERATOR_PORTAL_ENABLED=false`, rebuild/deploy the frontend,
   then set `OPERATOR_PORTAL_ENABLED=false` and restart/deploy the backend.
2. Keep tenant records, ownership tags, and scoped indexes in place. Do not
   reverse ownership or drop tenant indexes as a routine rollback.
3. Allow already queued transactional notices to follow the existing delivery
   policy; the suspension/feature controls stop new operator notices.
4. Revert application code only after confirming it is compatible with the
   migrated schema. Restore the database only under the incident plan and with
   an explicit recovery decision, since restore would also rewind valid
   Swiftline transactions made after the backup.
5. Reconcile bookings, credit, invoices, labels, and outbox rows created during
   the pilot before re-enabling the module.

## Deployment record

Record the deployment date, `main` SHA, backend/frontend artifact IDs, database
name and cluster identifier (no URI), backup/PITR reference, migration runner
version and results, index audit results, feature flag values, pilot operator,
Swiftline regression tester, email/storage smoke-test results, monitoring owner,
and rollback decision owner. Redact personal information and never attach
production KYC documents.
