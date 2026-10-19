# Private business rate cards

This migration copies each existing business account's assigned legacy tariff
into rows owned by that account. It copies the selected band's weight slabs,
GST treatment, and Courier/Cargo route charges. It keeps the legacy rows and the
account's original band field for audit and rollback investigation. New
business accounts receive an empty private card and cannot book until staff
configure at least one rate.

Individual Client pricing remains on Band D. Existing shipment, quote, and
invoice snapshots are not rewritten. The first new price calculation after a
copy records the private account and card version in its pricing basis, so any
open quote lock priced before the copy may need to be refreshed and accepted.

## Before the production run

1. Take and verify a restorable database backup. Confirm the production database
   supports transactions.
2. Deploy the API and frontend that understand private cards to every serving
   instance. Do not leave an older API instance accepting rate-card writes.
3. Pause rate-card edits and imports while the migration runs. Existing
   bookings can continue: each account switches in one transaction, after its
   rates and route charges have been copied and verified.
4. From `backend`, run the default read-only audit:

   ```powershell
   npm run migrate:private-rate-cards
   ```

   It connects with automatic index creation disabled and writes no data. Review
   every account in the report. `COPY` should name the expected source band and
   counts. `EMPTY` is expected only for an account with no assigned band.
   Investigate and correct every audit error before applying. The audit rejects
   missing tariffs, overlapping slabs, duplicate route charges, invalid GST,
   invalid route values, and accounts that already have unmarked private rows.

## Pilot and full migration

Run a pilot against one agreed business account. First capture its dry-run
checksum, then apply that account using the ID of an active admin as the audit
actor:

```powershell
npm run migrate:private-rate-cards -- --account-id=BA-2026-123456
npm run migrate:private-rate-cards -- --apply --account-id=BA-2026-123456 "--actor-id=<active-admin-user-id>"
```

Review the `Verified private rate card` log, then check the account's Rates and
Route Charges tabs and compare a fresh quote against the pre-migration
commercial totals and GST behavior. Have the account owner review its card
before continuing.

Repeat the read-only audit for all accounts. Resolve any changed checksums by
reviewing the affected rates and running the audit again. Then migrate all
accounts:

```powershell
npm run migrate:private-rate-cards
npm run migrate:private-rate-cards -- --apply "--actor-id=<active-admin-user-id>"
```

The apply command audits every selected account before changing indexes or
rows. It creates the owner-aware route-charge uniqueness index, removes only
the exact old `(band, countryCode, service)` unique index, builds the declared
rate, route-charge and share indexes, then copies each account in a transaction.
It checks the copied commercial-data checksum before marking the card ready and
records the migration actor, source band, row counts and checksum in the audit
log. Already migrated accounts are checked and skipped, so rerunning is safe and
does not overwrite their later edits.

## After the run

- Confirm every account reports `ALREADY_PRIVATE` on a fresh read-only audit and
  that the readiness flag matches whether the account has rates.
- Check a sample from each source band, an approved no-GST account, the
  individual Band D card, and business cards with route charges.
- Confirm a new business account has an empty private card and booking remains
  paused until a rate is added.
- Re-enable rate-card edits and inspect API, booking, quote and invoice logs.

Do not restore a legacy API while staff are editing private cards: it reads the
retained legacy band and cannot see those edits. If an issue appears, pause
rate-card changes and resolve it forward using the audit report and preserved
source rows. The migration does not alter old invoices, payments, shipment
snapshots or the Band D tariff.
