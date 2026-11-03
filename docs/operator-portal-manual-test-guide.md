# Operator workspace staging acceptance guide

Use this guide only in an approved local or staging environment with synthetic accounts, documents, shipments, invoices, and payments.

## Test identities and setup

Prepare these active test identities:

- one Swiftline platform administrator;
- one operator administrator;
- one operator operations user;
- one operator finance user when finance access is included in the pilot;
- one client owner linked to an approved operator business account and assigned branch; and
- one existing Swiftline client for regression checks.

Confirm the backend uses the approved test Atlas database. Enable `OPERATOR_PORTAL_ENABLED` and `NEXT_PUBLIC_OPERATOR_PORTAL_ENABLED`, then restart the applications. Record the operator slug for denial and bookmark checks; normal entry must work without manually pasting it.

## 1. Registry and suspension

1. Sign in as the Swiftline platform administrator and open the operator registry.
2. Confirm the test operator is active and its current company name and slug are correct.
3. Suspend the operator with a test reason.
4. Confirm an existing operator staff or client session can no longer use the workspace and no new operator notice is queued.
5. Confirm the suspension audit entry and closed support sessions.
6. Reactivate the operator and confirm access returns.

## 2. Login and workspace discovery

1. Sign in as the operator-only administrator without entering a portal URL. Confirm login opens its sole active operator workspace.
2. Sign in as the operator-only client. Confirm login opens the client workspace directly and does not expose the Swiftline client dashboard.
3. For an identity with multiple memberships, confirm login opens the workspace chooser and each listed workspace is valid.
4. Confirm the operator client header has no workspace switch action when there is no other accessible workspace.
5. Attempt a direct URL for another operator. Confirm access is denied without revealing tenant data.

## 3. Operator setup

1. As operator administrator, review company details, slug, logo, banners, invoice branches, branches, users, and profiles.
2. Create a synthetic business account, complete KYC review, approve it, deactivate it, and reactivate it.
3. Confirm the account name is used in selectors and tables and the assigned branch is correct.
4. Invite a synthetic client owner. Accept the invitation once and confirm the same token cannot be reused.
5. Confirm operations and finance users see only actions allowed by their route permissions.

## 4. Pricing and credit

1. Configure a synthetic operator rate card and verify the client sees only its resolved account rate card without an account selector.
2. Request or approve test credit according to the role under test.
3. Record a synthetic offline payment and verify it with eligible operator staff.
4. Confirm balances, ledger entries, statements, and payment history belong only to the operator account.
5. Confirm no operator payment uses Swiftline Razorpay configuration.

## 5. Booking and documents

1. As the client, choose Create shipment. Confirm the authenticated business account and branch are resolved automatically.
2. Book a synthetic shipment. Confirm an operator AWB, internal label, tax invoice, and shipment invoice are created without a carrier request.
3. Confirm the tax invoice Bill To name and address use the business account or approved contact fallback.
4. Confirm current operator logo and invoice branch data appear on newly generated documents.
5. Preview permitted KYC documents and download labels and invoices according to role.
6. Confirm booking notices and email outbox recipients include the booking client and eligible administrator or operations users in the same operator, with no Swiftline staff recipient.
7. Retry the booking request and confirm it reuses the booking without duplicate financial entries or notices.

## 6. Operator staff booking

1. As operator administrator or operations staff, start a shipment.
2. Confirm the business-account selector shows account names.
3. Select an account and confirm its branch is selected automatically.
4. Book the shipment and repeat the document, credit, notification, and tenant checks from the client booking.

## 7. Shipment operations

1. Confirm the operator shipment list, filters, pagination, parcel hover details, and select-all control work at desktop and narrow widths.
2. Open shipment details and verify consignor, consignee, KYC, documents, parcel data, goods, weight, amount, and tracking timeline.
3. Submit an amendment as the client and review it as eligible operator staff.
4. Submit a cancellation as the client and review it with a synthetic fee. Verify the financial and audit result.
5. Create an account manifest and a combined operator manifest where permitted.
6. Add a manual tracking event. Confirm the current event and prior milestones render correctly and the client sees only customer-visible events.
7. Track by AWB and permitted sender or recipient search, then open the shipment detail link.

## 8. Contact Us and home pages

1. As the client, submit Contact Us with contact details, reason, message, and an AWB when relevant.
2. Confirm the query appears only in that operator's query page.
3. Confirm email recipients are the operator's eligible administrator and operations users, not Swiftline staff.
4. Check the operator and client home pages for role-appropriate KPIs, charts, banners, and recent shipments.
5. Confirm client metrics and recent shipments include only its own account and assigned branch data.

## 9. Swiftline regression boundary

Using separate Swiftline test identities, verify existing:

- client and staff login destinations;
- business account and branch access;
- shipment booking and carrier behavior;
- invoices, labels, KYC documents, and downloads;
- credit, payments, ledger, amendments, cancellations, manifests, and tracking; and
- Swiftline notifications and email recipients.

Operator records must not appear in Swiftline pages, and Swiftline records must not appear in operator pages.

## 10. Responsive and failure checks

Repeat workspace home, settings, account, branch, users, shipment list/detail, booking, credit, manifests, tracking, queries, and profiles at phone, tablet, and desktop widths. Confirm keyboard focus, dialogs, dropdowns, tables, scroll containers, loading states, errors, and empty states remain usable without page-level horizontal overflow.

Also confirm invalid IDs, a foreign slug, a suspended tenant, an inactive membership, and a foreign document return safe errors without tenant details.

## Record the result

For every section, record tester, role, environment, build identifier, pass/fail, and evidence. For failures, include the page or API path, expected behavior, actual behavior, and a redacted screenshot or response. Never record passwords, invitation tokens, signed document URLs, production customer data, or unredacted KYC documents.
