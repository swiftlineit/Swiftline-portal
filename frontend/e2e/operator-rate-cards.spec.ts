import { expect, test, type Page, type Route } from "playwright/test";

const slug = "northstar-cargo";
const accountObjectId = "507f1f77bcf86cd799439021";
const accountCode = "BA-2026-123456";

function json(route: Route, body: unknown, status = 200) {
  const origin = route.request().headers().origin;
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      vary: "Origin"
    } : undefined,
    body: JSON.stringify(body)
  });
}

async function mockRateCardApi(
  page: Page,
  role: "OPERATOR_ADMIN" | "OPERATIONS" | "CLIENT",
  apiCalls: string[],
  savedRates: Array<Record<string, unknown>> = [],
  savedRouteCharges: Array<Record<string, unknown>> = []
) {
  let rateCardVersion = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    apiCalls.push(`${request.method()} ${path}`);
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
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-rate-card-test-token" });
    if (path === "/api/v1/auth/me") return json(route, { success: true, user: { name: "Operator User", email: "user@example.test", role: "client" } });
    if (path === `/api/v1/operators/${slug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
        membership: { role, assignedBranches: [] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts/${accountCode}`) {
      return json(route, { success: true, account: {
        _id: accountObjectId,
        accountId: accountCode,
        status: "active",
        contact: { firstName: "Asha", lastName: "Mehta", email: "asha@example.test" },
        company: { companyName: "Northstar Parts", registeredAddress: "10 Market Road", city: "Delhi" },
        createdAt: "2026-10-23T08:00:00.000Z"
      } });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts`) {
      return json(route, {
        success: true,
        accounts: [{
          _id: accountObjectId,
          accountId: accountCode,
          accountKind: "BUSINESS",
          status: "active",
          company: { companyName: "Northstar Parts" },
          createdAt: "2026-10-22T08:00:00.000Z",
          updatedAt: "2026-10-22T08:00:00.000Z"
        }],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${slug}/country-rate-cards/client`) {
      expect(url.searchParams.has("businessAccountId")).toBe(false);
      return json(route, {
        success: true,
        title: "Northstar Parts Rate Card",
        rateCardAssigned: true,
        rates: [{
          _id: "507f1f77bcf86cd799439081",
          countryCode: "DE",
          countryName: "Germany",
          service: "COURIER",
          fromKg: 0,
          toKg: 5,
          chargesPerKg: 420,
          maxBoxKg: 30,
          gstTreatment: "EXCLUDED",
          gstRatePercent: 0,
          gstApplyToAllRates: false,
          createdAt: "2026-10-22T08:00:00.000Z",
          updatedAt: "2026-10-22T08:00:00.000Z"
        }],
        routeCharges: []
      });
    }
    if (path === `/api/v1/operators/${slug}/country-rate-cards` && request.method() === "GET") {
      return json(route, { success: true, rates: savedRates, version: rateCardVersion, migrationRequired: false });
    }
    if (path === `/api/v1/operators/${slug}/country-rate-cards/route-charges` && request.method() === "GET") {
      return json(route, { success: true, routeCharges: savedRouteCharges, version: rateCardVersion });
    }
    if (path === `/api/v1/operators/${slug}/country-rate-cards` && request.method() === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      const rate = {
        ...payload,
        _id: "507f1f77bcf86cd799439081",
        createdAt: "2026-10-23T08:00:00.000Z",
        updatedAt: "2026-10-23T08:00:00.000Z"
      };
      savedRates.push(rate);
      rateCardVersion += 1;
      return json(route, { success: true, rate, version: rateCardVersion }, 201);
    }
    if (path === `/api/v1/operators/${slug}/country-rate-cards/route-charges` && request.method() === "PUT") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      const routeCharge = {
        ...payload,
        _id: "507f1f77bcf86cd799439091",
        remoteAreaPostcodes: [],
        createdAt: "2026-10-23T08:00:00.000Z",
        updatedAt: "2026-10-23T08:00:00.000Z"
      };
      savedRouteCharges.push(routeCharge);
      rateCardVersion += 1;
      return json(route, { success: true, routeCharge, routeCharges: [routeCharge], version: rateCardVersion });
    }
    return json(route, { success: false, message: `No rate-card test fixture for ${request.method()} ${path}` }, 404);
  });
}

test("operator administrator can open the private account rate-card editor", async ({ page }) => {
  const apiCalls: string[] = [];
  const savedRates: Array<Record<string, unknown>> = [];
  const savedRouteCharges: Array<Record<string, unknown>> = [];
  await mockRateCardApi(page, "OPERATOR_ADMIN", apiCalls, savedRates, savedRouteCharges);
  await page.goto(`/portal/${slug}/business-accounts/${accountCode}/rate-card`);

  await expect(page.getByRole("heading", { name: "Northstar Parts" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Rates" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Route Charges" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add rate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import Excel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Add rate" }).click();
  const rateCountry = page.getByRole("combobox", { name: "Country" });
  await rateCountry.fill("Germany");
  await page.getByRole("option", { name: /Germany/ }).getByRole("button").click();
  await page.getByLabel("From KG").fill("0");
  await page.getByLabel("To KG").fill("5");
  await page.getByLabel("Charges / KG").fill("420");
  await page.getByLabel("Max Box KG").fill("30");
  await page.getByRole("button", { name: "Add rate" }).click();
  await expect.poll(() => savedRates.length).toBe(1);
  expect(savedRates[0]).toMatchObject({
    businessAccountId: accountObjectId,
    expectedVersion: 0,
    countryCode: "DE",
    countryName: "Germany",
    service: "COURIER",
    fromKg: 0,
    toKg: 5,
    chargesPerKg: 420,
    maxBoxKg: 30
  });

  await page.getByRole("tab", { name: "Route Charges" }).click();
  const chargeCountry = page.getByRole("combobox", { name: "Country" });
  await chargeCountry.fill("Germany");
  await expect(page.getByRole("heading", { name: "Route charges for Germany" })).toBeVisible();
  await page.getByRole("button", { name: "Save Route Charges" }).click();
  await expect.poll(() => savedRouteCharges.length).toBe(1);
  expect(savedRouteCharges[0]).toMatchObject({
    businessAccountId: accountObjectId,
    expectedVersion: 1,
    countryCode: "DE",
    service: "COURIER",
    services: ["COURIER"]
  });
  expect(apiCalls).toContain(`GET /api/v1/operators/${slug}/country-rate-cards`);
  expect(apiCalls).toContain(`GET /api/v1/operators/${slug}/country-rate-cards/route-charges`);
  expect(apiCalls).toContain(`POST /api/v1/operators/${slug}/country-rate-cards`);
  expect(apiCalls).toContain(`PUT /api/v1/operators/${slug}/country-rate-cards/route-charges`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator staff cannot open the rate-card editor", async ({ page }) => {
  const apiCalls: string[] = [];
  await mockRateCardApi(page, "OPERATIONS", apiCalls);
  await page.goto(`/portal/${slug}/business-accounts/${accountCode}/rate-card`);

  await expect(page.locator("[role='alert']").filter({ hasText: "Only the operator administrator can manage rate cards." })).toBeVisible();
  expect(apiCalls.some((call) => call.includes("/country-rate-cards"))).toBe(false);
});

test("operator client sees only the account rate card selected by the server", async ({ page }) => {
  const apiCalls: string[] = [];
  await mockRateCardApi(page, "CLIENT", apiCalls);
  await page.goto(`/portal/${slug}/rate-card`);

  await expect(page.getByRole("heading", { name: "Northstar Parts Rate Card" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Business account" })).toHaveCount(0);
  await page.getByRole("button", { name: /Europe/ }).click();
  await page.getByRole("button", { name: /Germany/ }).click();
  await expect(page.getByText("0 - 5 kg")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add rate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import Excel" })).toHaveCount(0);
  expect(apiCalls).toContain(`GET /api/v1/operators/${slug}/country-rate-cards/client`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
