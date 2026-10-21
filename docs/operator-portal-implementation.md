# Operator portal implementation

This branch builds a tenant-aware operator portal while preserving Swiftline's existing booking, tracking and billing behavior. The operator feature flag is off by default. No operator may be activated until the isolation and regression gates below pass.

## Confirmed first release

- Swiftline is the platform owner and an operational tenant. An operator is a separate business, not a Swiftline business account.
- An operator's staff and business-account clients create shipments. Bookings use only that operator's internal label, with no ALS, DPD or Razorpay integration.
- Bookings create the operator's GST tax invoice for charges and a separate shipment/customs invoice for goods and declared value. Only the tax invoice affects credit.
- The operator approves credit limits and terms for its clients. Clients book first and pay later. Payments received outside the portal are verified by operator finance staff before balances change.
- Confirmed operator booking finalizes the charge for its credit statement. Swiftline keeps its current operational charge-finalization trigger.
- Operator staff create combined and account-level manifests; a client can create manifests only for its own business account.
- Operator staff enter tracking events manually. An operator client sees only customer-visible events for its account. Swiftline retains its current tracking sources.
- Operators use `/portal/{operatorSlug}/...` on Swiftline's domain. A slug is a routing identifier, never an authorization credential. Old slugs remain reserved and redirect to the current slug after access checks.
- Cancellation review accepts an editable fee for each case. Financial changes remain auditable; Swiftline's existing cancellation rules stay unchanged.

## Authorization invariants

1. A signed-in identity has no operator authority from its global `User.role`. Operator access requires an active `TenantMembership` in the URL tenant, checked on every request.
2. Platform administrators are Swiftline staff. Operator administrators must never receive the legacy global `admin` role.
3. A client additionally needs an active business-account membership in the same tenant and any required branch permission. Object IDs, slugs, labels and tracking numbers supplied by the browser cannot select another tenant's records.
4. Tenant checks must cover list, detail, write, export, download, notification, job, webhook and public routes. Storage access must follow the owning record's authorization.
5. Swiftline's legacy API routes remain Swiftline-only. Operator records must never be inserted into collections reached by those routes until the routes enforce that boundary.

## Implementation sequence and release gates

1. **Registry (started):** tenant and slug records, draft-only onboarding, active membership guard and explicit unique-index migration. These routes are behind `OPERATOR_PORTAL_ENABLED=false`. There is no operator activation endpoint.
2. **Inventory and migration:** classify every model as tenant-owned, Swiftline-only, platform-owned or shared reference data. Add required tenant IDs and compound indexes to each owned collection. Create the Swiftline tenant and run a dry-run backfill with counts and orphan checks before applying it. Preserve existing IDs, tracking references, documents and invoice numbers. Production indexes use reviewed explicit migrations.
3. **Access boundary:** scope every existing Swiftline route and job to the Swiftline tenant, including public tracking and background carrier sync. Add operator staff and client APIs with mandatory tenant and account scope. Prove denials for changed slugs, IDs, downloads and exports.
4. **Operator transactions:** implement operator rate cards, credit, booking, internal labels, two invoices, amendments and cancellations. Booking, charge conversion, invoice creation and manual tracking must be idempotent and auditable. Operator invoice and tracking counters are tenant-scoped.
5. **Manifests and UI:** add operator account and combined manifests with the current account/branch permission model, then responsive operator dashboards and configuration screens. Read the installed Next.js guide and reuse existing components before changing frontend routes.
6. **Pilot:** run focused and regression suites plus a cross-tenant test matrix on an isolated Atlas test database. Keep the feature flag off in production until the migration and all gates pass. Enable one operator first with monitoring and a rollback path.

## Scope boundary for the current branch state

The registry can create only `DRAFT` operators. No business account, shipment or client account for an operator can yet be created. `OPERATOR_PORTAL_ENABLED` must remain false outside controlled testing while legacy routes and data are being tenantized. The current registry test uses a uniquely named temporary Atlas database and drops only that database.
