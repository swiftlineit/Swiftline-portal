import { expect, test, type Page, type Route, type TestInfo } from "playwright/test";

const slug = "northstar-cargo";
const historicalSlug = "northstar-express";

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

function captureBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function expectWithBrowserDiagnostics(page: Page, errors: string[], assertion: () => Promise<void>) {
  try {
    await assertion();
  } catch (cause) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${message}\nBrowser errors: ${errors.join("\n") || "none"}\nVisible page: ${bodyText.slice(0, 1200)}`);
  }
}

async function mockOperatorDirectory(
  page: Page,
  accountSearches: string[],
  apiCalls: string[],
  createdAccountIds: string[] = [],
  draftSaveFlags: boolean[] = []
) {
  let currentSlug = slug;
  let draftCreated = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const url = new URL(request.url());
    apiCalls.push(`${request.method()} ${path}`);
    if (request.method() === "OPTIONS") {
      const origin = request.headers().origin ?? "http://127.0.0.1:3000";
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "authorization,content-type",
          "access-control-allow-methods": request.headers()["access-control-request-method"] ?? "GET,POST,OPTIONS",
          vary: "Origin"
        }
      });
    }
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-directory-test-token" });
    if (path.startsWith(`/api/v1/operators/${historicalSlug}/`)) {
      return json(route, {
        success: false,
        message: "Operator URL has changed.",
        canonicalSlug: currentSlug
      }, 409);
    }
    if (path === `/api/v1/operators/${currentSlug}/settings/slug` && request.method() === "PATCH") {
      const payload = request.postDataJSON() as { slug?: string };
      currentSlug = payload.slug ?? currentSlug;
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439011", slug: currentSlug, companyName: "Northstar Cargo" }
      });
    }
    if (path === `/api/v1/operators/${currentSlug}/business-accounts/validate-unique`) {
      return json(route, {
        success: true,
        conflicts: { email: false, mobileNumber: false, registrationId: false }
      });
    }
    if (path === `/api/v1/operators/${currentSlug}/business-accounts` && request.method() === "POST") {
      const body = request.postData() ?? "";
      draftSaveFlags.push(body.includes('name="saveAsDraft"') && body.includes("\r\n\r\ntrue"));
      draftCreated = true;
      createdAccountIds.push("BA-2026-765432");
      return json(route, {
        success: true,
        account: {
          _id: "507f1f77bcf86cd799439041",
          accountId: "BA-2026-765432",
          status: "draft",
          contact: { firstName: "Nora", lastName: "Shah", email: "nora@example.test" },
          company: { companyName: "Nora Parts" },
          createdAt: "2026-10-23T08:00:00.000Z"
        }
      }, 201);
    }
    if (path === `/api/v1/operators/${currentSlug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439011", slug: currentSlug, companyName: "Northstar Cargo" },
        membership: { role: "OPERATOR_ADMIN", assignedBranches: [] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }
    if (path === `/api/v1/operators/${currentSlug}/home`) {
      return json(route, {
        success: true,
        role: "OPERATOR_ADMIN",
        shipmentCount: 0,
        bookedToday: 0,
        bookedThisMonth: 0,
        inTransit: 0,
        trend: [],
        banners: [],
        recentShipments: [],
        accountStatuses: [],
        operations: { pendingAccountReviews: 0, pendingChanges: 0, pendingAmendments: 0, pendingCancellations: 0, queriesThisWeek: 0, pendingAccounts: [], latestQueries: [] }
      });
    }
    if (path === `/api/v1/operators/${currentSlug}/settings` && request.method() === "GET") {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439011", slug: currentSlug, companyName: "Northstar Cargo", logo: null },
        banners: [],
        branches: [],
        pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${currentSlug}/business-accounts`) {
      accountSearches.push(url.searchParams.get("search") ?? "");
      return json(route, {
        success: true,
        accounts: [...(draftCreated ? [{
          _id: "507f1f77bcf86cd799439041",
          accountId: "BA-2026-765432",
          accountKind: "BUSINESS",
          status: "draft",
          contact: { firstName: "Nora", lastName: "Shah", email: "nora@example.test" },
          company: { companyName: "Nora Parts" },
          createdAt: "2026-10-23T08:00:00.000Z",
          updatedAt: "2026-10-23T08:00:00.000Z"
        }] : []), {
          _id: "507f1f77bcf86cd799439021",
          accountId: "BA-2026-123456",
          accountKind: "BUSINESS",
          status: "active",
          contact: { firstName: "Asha", lastName: "Mehta", email: "asha@example.test" },
          company: { companyName: "Northstar Parts" },
          assignedBranch: { _id: "507f1f77bcf86cd799439031", name: "North Hub", code: "NORTH", status: "ACTIVE" },
          createdAt: "2026-10-22T08:00:00.000Z",
          updatedAt: "2026-10-22T08:00:00.000Z"
        }],
        pagination: { page: 1, pageSize: 10, total: draftCreated ? 2 : 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${currentSlug}/branches`) {
      return json(route, {
        success: true,
        branches: [{
          _id: "507f1f77bcf86cd799439031",
          name: "North Hub",
          code: "NORTH",
          labelCode: "NTH",
          address: { countryCode: "IN", countryName: "India", city: "Delhi", stateOrProvince: "Delhi" },
          status: "ACTIVE",
          operations: { supportedServices: ["INTERNATIONAL_COURIER"] }
        }],
        pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 }
      });
    }
    return json(route, { success: false, message: `No test fixture for ${request.method()} ${path}` }, 404);
  });
}

test("operator directory loads at its slug and stays usable on desktop and mobile", async ({ page }, testInfo: TestInfo) => {
  const accountSearches: string[] = [];
  const apiCalls: string[] = [];
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("requestfailed", (request) => browserErrors.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`));
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/")) browserErrors.push(`request started: ${request.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  await mockOperatorDirectory(page, accountSearches, apiCalls);
  await page.goto(`/portal/${historicalSlug}`);
  try {
    await expect(page).toHaveURL(new RegExp(`/portal/${slug}$`));
  } catch (error) {
    const messages = await page.locator("body").innerText();
    throw new Error(`${String(error)}\nMocked API calls: ${apiCalls.join(", ") || "none"}\nVisible form text: ${messages.slice(-1000)}\nBrowser errors: ${browserErrors.join("; ") || "none"}`);
  }

  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
  await page.goto(`/portal/${slug}/business-accounts`);
  await expect(page.getByRole("heading", { name: "Business accounts", exact: true })).toBeVisible();
  await expect(page.getByText("Northstar Parts", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/Asha Mehta/).filter({ visible: true })).toBeVisible();

  const searchbox = page.getByRole("searchbox", { name: "Search business accounts" });
  await searchbox.fill("temporary");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await searchbox.fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Northstar Parts", { exact: true }).filter({ visible: true })).toBeVisible();

  await searchbox.fill("Northstar");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => accountSearches.filter((search) => search === "Northstar").length).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto(`/portal/${slug}/settings`);
  const slugInput = page.getByRole("textbox", { name: "Workspace URL" });
  await expect(slugInput).toHaveValue(slug);
  await slugInput.fill("northstar-logistics");
  const slugUpdateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/operators/${slug}/settings/slug` && response.request().method() === "PATCH",
    { timeout: 8_000 }
  );
  await page.getByRole("button", { name: "Save URL" }).click();
  const updated = await slugUpdateResponse;
  expect(updated.status()).toBe(200);
  expect((await updated.json()).operator.slug).toBe("northstar-logistics");
  await expect(page).toHaveURL(/\/portal\/northstar-logistics\/settings$/);
  expect(apiCalls.some((call) => call === `PATCH /api/v1/operators/${slug}/settings/slug`)).toBe(true);

  await page.screenshot({ path: testInfo.outputPath("operator-directory.png"), fullPage: true });
});

test("operator administrators can save a client business account as a tenant draft", async ({ page }, testInfo: TestInfo) => {
  const browserErrors = captureBrowserErrors(page);
  const accountSearches: string[] = [];
  const apiCalls: string[] = [];
  const createdAccountIds: string[] = [];
  const draftSaveFlags: boolean[] = [];
  await mockOperatorDirectory(page, accountSearches, apiCalls, createdAccountIds, draftSaveFlags);
  await page.goto(`/portal/${slug}/business-accounts/new`);
  await expectWithBrowserDiagnostics(page, browserErrors, () =>
    expect(page.getByRole("heading", { name: "Let's Get Started" })).toBeVisible()
  );

  await page.getByLabel(/First Name/).fill("Nora");
  await page.getByLabel(/Last Name/).fill("Shah");
  await page.getByLabel(/Email Address/).fill("nora@example.test");
  await page.getByLabel(/Mobile Number/).fill("9876543210");
  const saveAsDraftButton = page.getByRole("button", { name: "Save as Draft" });
  const draftSaveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/operators/${slug}/business-accounts`
      && response.request().method() === "POST",
    { timeout: 30_000 }
  );
  if (testInfo.project.name === "mobile-chromium") await saveAsDraftButton.tap();
  else await saveAsDraftButton.click();

  expect((await draftSaveResponse).status()).toBe(201);
  // On a cold Next dev server, compiling the destination list route can take
  // longer than the default assertion timeout after the API has already saved.
  await expect(page).toHaveURL(new RegExp(`/portal/${slug}/business-accounts$`), { timeout: 30_000 });
  await expect(page.locator("p:visible").filter({ hasText: /^BA-2026-765432$/ }).last()).toBeVisible();
  expect(createdAccountIds).toEqual(["BA-2026-765432"]);
  expect(draftSaveFlags).toEqual([true]);
  expect(apiCalls).toContain(`POST /api/v1/operators/${slug}/business-accounts`);
  expect(apiCalls.some((call) => call.includes("/business-accounts/validate-unique"))).toBe(true);
  expect(apiCalls.some((call) => call.includes("/business-accounts/") && call.endsWith("/submit"))).toBe(false);
});
