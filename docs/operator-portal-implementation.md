# Operator workspace module

Updated: 3 November 2026

This document is the current implementation and release reference for operator workspaces. It replaces the earlier chronological implementation notes.

## Purpose and boundaries

An operator is a tenant that runs its own client accounts, branches, pricing, credit, bookings, documents, manifests, tracking, queries, users, and workspace branding. Operator records remain separate from Swiftline records.

Operator workspace pages live under `/portal/{operatorSlug}` and operator APIs under `/api/v1/operators/{operatorSlug}`. The slug selects a workspace; it does not grant access. Every request must resolve an active tenant and an active membership for the authenticated user.

Swiftline staff and client routes keep their existing behavior. Shared services or controllers may be used only through the operator tenant context and operator-specific authorization wrappers.

## First release scope

The first release contains:

- operator onboarding, activation, suspension, reactivation, slug history, and workspace discovery;
- operator administrator, operations, finance, and client memberships;
- operator business accounts, KYC review, activation, deactivation, branch assignment, and client invitations;
- branch, user, profile, settings, logo, and home-banner management;
- private operator rate cards and client-visible rate-card access;
- operator-managed credit, statements, and verified offline payments;
- internal-label shipment booking without a carrier booking;
- tax invoices, shipment invoices, labels, KYC documents, and protected downloads;
- shipment lists, details, amendments, reviewed cancellations, manifests, manual tracking, and AWB lookup;
- tenant-routed booking notifications and email for the booking client and the operator's administrator or operations recipients;
- a simple client Contact Us form and an operator query inbox; and
- role-specific home metrics, charts, banners, and recent shipments.

Pickup requests, claims, a full ticketing system, operator online payments, and automated carrier integrations are outside this release.

## Workspace entry behavior

Login routing is based on active memberships rather than the global user role:

- one active operator workspace and no Swiftline client access: open that operator workspace directly;
- Swiftline client access only: open `/client/dashboard`;
- more than one available workspace: open `/workspaces` for selection;
- an approved safe return path: honor it only when the user belongs to that workspace; and
- no active workspace: open `/workspaces` with no unauthorized fallback.

Operator clients do not need to paste a workspace URL. A direct operator URL remains useful for bookmarks and denial testing, but the server still verifies membership.

## Roles

| Role | First-release responsibilities |
| --- | --- |
| Swiftline platform administrator | Create, activate, suspend, and reactivate operator tenants. Review audit history. |
| Operator administrator | Manage the operator company, accounts, branches, users, pricing, credit, bookings, queries, and settings. |
| Operations | Work with shipments, manifests, tracking, amendments, cancellations, queries, and permitted settings. |
| Finance | Review permitted credit, statement, payment, shipment, and branch information. |
| Client | Use only the linked business account and assigned branch data for booking, documents, tracking, credit visibility, manifests, profile, and Contact Us. |

Route guards remain the source of truth when a page is not available to every role.

## Isolation and security invariants

1. An operator permission comes from an active `TenantMembership`, never from `User.role` alone.
2. The URL tenant, business account, branch, shipment, invoice, document, notification, query, and manifest must belong to the same tenant context.
3. Client membership checks must also enforce the linked business account and assigned branches.
4. List, detail, write, export, download, storage, webhook, notification, and background-job paths must preserve tenant ownership.
5. Operator booking messages go only to the booking client and eligible staff in that operator. Swiftline booking recipients remain unchanged for Swiftline bookings.
6. Suspending an operator blocks new operator and client access and prevents new operator notices from being queued. Already queued transactional messages may finish delivery.
7. Signed or stored document access is authorized from the owning database record before storage is read.
8. Production index and ownership changes use reviewed explicit migrations; automatic production index creation is not a migration strategy.

## Transaction rules

- Operator bookings use the operator's internal AWB and label. They do not call ALS, DPD, another carrier, or Razorpay.
- Booking charges use the operator account's rate card and credit terms.
- A tax invoice records service charges. A shipment invoice records the goods and declared value. Only the tax invoice affects credit.
- A no-company account uses the approved account/contact identity and account billing address for Bill To data.
- Operator staff choose the business account when booking. Its assigned branch is resolved automatically. An operator client uses its authenticated account and branch without selecting another account.
- Amendments and cancellations follow the operator review flow. Financial and status changes remain auditable.
- Operator tracking events are entered manually and client visibility is limited to customer-visible events.

## Implemented operational controls

Swiftline platform staff can suspend or reactivate one operator without stopping other tenants. Suspension closes operator access, closes support sessions, is audited, and stops new notices. The global feature flags remain the emergency stop for the whole module:

- backend: `OPERATOR_PORTAL_ENABLED`;
- frontend: `NEXT_PUBLIC_OPERATOR_PORTAL_ENABLED`.

Turning the flags off removes operator entry points while keeping tenant data. Do not delete tenant records, reverse ownership tags, or drop scoped indexes as an incident response.

## Verified test evidence

The following focused Atlas integration results were supplied from the approved test environment during this implementation:

| Suite | Result | Coverage |
| --- | --- | --- |
| `operatorShipmentBooking.integration.test.ts` | 1/1 passed | Booking, idempotent reuse, amendment, reviewed cancellation, manifest, tenant-local notices. |
| `tenantScope.integration.test.ts` | 16/16 passed | Tenant-owned models, API and document denial, jobs, callbacks, invoices, labels, manifests, and KYC scope. |
| `tenantRegistry.integration.test.ts` | 4/4 passed | Slugs, onboarding, membership access, suspension, reactivation, audit, and notice blocking. |
| `operatorContact.integration.test.ts` | 1/1 passed | Client query ownership and operator-only staff/email recipients. |
| `operatorHome.integration.test.ts` | 1/1 passed | Tenant, branch, client, and credit scope for home metrics. |
| `operatorBranchDirectory.integration.test.ts` | 1/1 passed | Branch detail and assigned-user tenant isolation. |

Development email safelisting may block physical delivery to synthetic addresses while still verifying outbox recipient creation. Live-email acceptance remains a staging check.

## Release gates

Complete these gates before enabling an operator in production:

1. Review and split the coordinated change set into component-based commits without mixing generated output.
2. Run backend build and focused operator integration tests against the approved test Atlas database.
3. Run frontend lint/type checking, production build, and the focused browser suite.
4. Complete the real-identity staging walkthrough in [the manual acceptance guide](./operator-portal-manual-test-guide.md).
5. Confirm existing Swiftline staff and client login, booking, documents, tracking, credit, and notification workflows are unchanged.
6. Run a read-only production ownership and data audit, then review any required explicit migration before writing production data.
7. Verify staging email delivery and recipients with approved addresses.
8. Confirm monitoring for access denials, booking failures, outbox failures, and tenant suspension.
9. Rehearse per-operator suspension and the global feature-flag rollback.

Keep both operator feature flags disabled in production until these gates are signed off.

## Reviewable commit boundaries

Keep the release coordinated, but review it in dependency order:

1. tenant ownership models, scope middleware, audits, and explicit migrations;
2. operator registry, memberships, invitations, discovery, suspension, and support access;
3. business accounts, KYC, branches, users, and profiles;
4. rate cards, credit, statements, and offline payments;
5. booking, AWBs, labels, invoices, documents, and booking notices;
6. amendments, cancellations, manifests, tracking, and queries;
7. operator workspace shell, home, settings, and role-specific pages;
8. integration and browser tests; and
9. release documentation and environment examples.

Each commit must build against the commits before it. Keep generated Next.js directories, local reports, screenshots, credentials, and test database output outside every commit.

## Deployment order

1. Prepare reviewable backend, frontend, test, migration, and documentation commits.
2. Deploy backend and frontend with both operator flags disabled.
3. Apply only reviewed production migrations against the named production database.
4. Smoke-test existing Swiftline workflows.
5. Enable the backend flag and frontend flag for the approved staging or pilot release.
6. Run the acceptance guide with real test identities and synthetic records.
7. Monitor access, transactions, notifications, email outbox, and audit events.
8. Expand beyond the pilot only after the release gates remain green.
