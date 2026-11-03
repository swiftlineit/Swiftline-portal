import { expect, test, type Page, type Route } from "playwright/test";

const slug = "northstar-cargo";
const draftId = "507f1f77bcf86cd799439051";

function json(route: Route, body: unknown, status = 200) {
  const origin = route.request().headers().origin;
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : undefined,
    body: JSON.stringify(body)
  });
}

async function mockHome(page: Page, role: "OPERATOR_ADMIN" | "CLIENT") {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") {
      const origin = request.headers().origin ?? "http://127.0.0.1:3001";
      return route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "authorization,content-type",
        "access-control-allow-methods": request.headers()["access-control-request-method"] ?? "GET,POST,OPTIONS",
        vary: "Origin"
      } });
    }
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-home-test-token" });
    if (path === "/api/v1/auth/me") return json(route, { success: true, user: { name: "Asha Mehta", email: "asha@example.test", role: "client" } });
    if (path === `/api/v1/operators/${slug}/me`) return json(route, {
      success: true,
      operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
      membership: { role, assignedBranches: [] },
      access: { mode: "MEMBER", readOnly: false }
    });
    if (path === `/api/v1/operators/${slug}/home`) return json(route, {
      success: true,
      role,
      shipmentCount: role === "CLIENT" ? 3 : 8,
      bookedToday: role === "CLIENT" ? 1 : 2,
      bookedThisMonth: role === "CLIENT" ? 3 : 8,
      inTransit: 2,
      banners: [],
      trend: Array.from({ length: 14 }, (_, index) => ({ day: `2026-10-${String(index + 18).padStart(2, "0")}`, count: index % 3, ...(role === "CLIENT" ? {} : { amountMinor: index % 3 * 10000 }) })),
      recentShipments: [{ id: draftId, awb: "NSCDEL311026001", accountName: "Northstar Parts", consignee: "Asha Shah", destinationCountry: "United Kingdom", status: "IN_TRANSIT", parcelCount: 2, bookingAmountMinor: 120000, currency: "INR", bookedAt: "2026-10-31T09:00:00.000Z" }],
      ...(role === "CLIENT" ? { credit: { availableCapacityMinor: 80000, totalOwedMinor: 20000, usedCreditMinor: 20000, creditLimitMinor: 100000 } } : {
        accountStatuses: [{ status: "active", count: 4 }, { status: "pending_review", count: 2 }],
        operations: { pendingAccountReviews: 2, pendingChanges: 1, pendingAmendments: 1, pendingCancellations: 0, queriesThisWeek: 3,
          pendingAccounts: [{ id: "507f1f77bcf86cd799439021", name: "Northstar Parts", createdAt: "2026-10-31T09:00:00.000Z" }],
          latestQueries: [] }
      })
    });
    return json(route, { success: false, message: `No home fixture for ${request.method()} ${path}` }, 404);
  });
}

for (const role of ["OPERATOR_ADMIN", "CLIENT"] as const) {
  test(`${role} sees a responsive, role-specific workspace home`, async ({ page }) => {
    await mockHome(page, role);
    await page.goto(`/portal/${slug}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: role === "CLIENT" ? "My workspace" : "Workspace overview" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Booking activity" })).toBeVisible();
    await expect(page.getByRole("link", { name: "NSCDEL311026001" }).filter({ visible: true })).toBeVisible();
    if (role === "CLIENT") {
      await expect(page.getByText("Available to book")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Credit usage" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Needs attention" })).toHaveCount(0);
    } else {
      await expect(page.getByRole("heading", { name: "Business accounts" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Client queries" })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
