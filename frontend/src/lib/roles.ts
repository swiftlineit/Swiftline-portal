// Single source of truth for portal roles and who may reach each area.
//
// The bundles below are consumed twice: the sidebar filters its links with them
// and each page passes the same constant to `useAdminUser`. Sharing the constant
// is what keeps a link from appearing for a role the page itself would bounce.
// They mirror the `requireRole` guards on the matching backend routers- the
// server remains the authority, this only decides what the UI offers.

export const portalRoles = ["admin", "operations", "finance", "delivery", "hr", "client"] as const;
export type PortalRole = (typeof portalRoles)[number];

/** Internal roles below admin. Clients are onboarded elsewhere. */
export const staffRoles = ["operations", "finance", "delivery", "hr"] as const;
export type StaffRole = (typeof staffRoles)[number];

/**
 * Every internal role a staff record may hold. Only an admin may grant `admin`,
 * so the forms offer this list to admins and `staffRoles` to HR- the server
 * enforces the same rule regardless of what the UI sends.
 */
export const internalRoles = ["admin", ...staffRoles] as const;
export type InternalRole = (typeof internalRoles)[number];

/** Admins reach every branch, so they carry no branch assignment. */
export function isBranchScopedRole(role: string) {
  return role !== "admin" && role !== "client";
}

export const roleLabels: Record<PortalRole, string> = {
  admin: "Administrator",
  operations: "Operations",
  finance: "Finance",
  delivery: "Delivery",
  hr: "Human Resources",
  client: "Client"
};

export function describeRole(role?: string) {
  return roleLabels[role as PortalRole] ?? "Team member";
}

// ── access bundles ────────────────────────────────────────────────────────────
// Each lists the roles allowed *in addition to* admin, which reaches everything.

/** Booking, manifests, amendments, cancellations, quotes, and tickets. */
export const OPERATIONS_AREA: readonly PortalRole[] = ["operations"];

/**
 * Business accounts: onboarding, KYC review, branch assignment, and client
 * access. Operations holds the same actions as admin here, but the server scopes
 * what it lists to the branches that member is assigned to.
 */
export const BUSINESS_ACCOUNT_AREA: readonly PortalRole[] = ["operations"];

/**
 * Reading the branch network. Operations needs it for the booking flow and the
 * business account branch picker; creating and editing branches stays admin-only,
 * so pages here check `role === "admin"` before offering a write control.
 */
export const BRANCH_VIEW_AREA: readonly PortalRole[] = ["operations", "finance", "hr"];

/** Credit and tax invoices. Rate cards moved to `RATE_CARD_AREA`. */
export const FINANCE_AREA: readonly PortalRole[] = ["finance"];

/**
 * Country rate cards, route charges, and the client share links built from them.
 * Operations holds the same actions as finance here: it quotes and books against
 * these lanes, so it maintains the pricing it sells rather than routing every
 * slab change through finance.
 */
export const RATE_CARD_AREA: readonly PortalRole[] = ["finance", "operations"];

/**
 * Credit accounts, statements, payments, and the ledger. Operations reads these
 * to answer client questions; approvals, payments, and write-offs stay with
 * finance, so pages here gate write controls on the role.
 */
export const CREDIT_VIEW_AREA: readonly PortalRole[] = ["finance", "operations"];

/** Read-only business wallet balances and ledger activity. */
export const PREPAID_LEDGER_AREA: readonly PortalRole[] = ["finance", "operations"];

/**
 * Counter sales: what individual (walk-in) customers paid and were refunded.
 * Operations books and settles them; finance reconciles them, since they never
 * reach the credit statements finance normally works from.
 */
export const COUNTER_SALES_AREA: readonly PortalRole[] = ["operations", "finance"];

/** Shipment lists, shipment detail, and tracking. */
export const SHIPMENT_VIEW_AREA: readonly PortalRole[] = ["operations", "delivery"];

/** The GST invoice on a shipment: operational context plus the money side. */
export const SHIPMENT_BILLING_AREA: readonly PortalRole[] = ["operations", "finance"];

/**
 * Compensation claims. Operations runs them, finance pays and reconciles, and
 * delivery reads its own branches. HR is deliberately absent- the server's
 * permission matrix grants it nothing here, so offering the link would only
 * lead to a page that refuses.
 */
export const CLAIMS_AREA: readonly PortalRole[] = ["operations", "finance", "delivery"];

/** The staff directory. HR may read it and add staff; only admin edits access. */
export const STAFF_DIRECTORY_AREA: readonly PortalRole[] = ["hr"];

/** Pages every internal role owns, such as their own profile. */
export const ALL_STAFF_AREA: readonly PortalRole[] = staffRoles;

/** Sidebar/nav helper: the bundle plus admin, which sees everything. */
export function withAdmin(area: readonly PortalRole[]): string[] {
  return ["admin", ...area];
}
