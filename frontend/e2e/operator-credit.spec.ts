import { expect, test, type Page, type Route } from "playwright/test";

const slug = "northstar-cargo";
const businessAccountId = "507f1f77bcf86cd799439021";
const businessAccountCode = "BA-2026-123456";
const statementId = "507f1f77bcf86cd799439051";

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

const summary = (status: string, withFinancialAccess = true) => ({
  success: true,
  permissions: withFinancialAccess ? ["requestCredit", "viewCreditBalance", "viewCreditDetails"] : ["requestCredit", "viewCreditBalance"],
  financialAccess: withFinancialAccess,
  creditAccount: {
    id: "507f1f77bcf86cd799439031",
    businessAccountId,
    status,
    currency: "INR",
    requestedCreditLimitMinor: 125000,
    approvedCreditLimitMinor: status === "ACTIVE" ? 10000000 : 0,
    usedCreditMinor: status === "ACTIVE" ? 2000000 : 0,
    reservedCreditMinor: 0,
    unbilledCreditMinor: 0,
    invoicedOutstandingMinor: status === "ACTIVE" ? 2000000 : 0,
    totalOwedMinor: status === "ACTIVE" ? 2000000 : 0,
    availableCreditMinor: status === "ACTIVE" ? 8000000 : 0,
    availableAdvanceMinor: 0,
    availableBookingCapacityMinor: status === "ACTIVE" ? 8000000 : 0,
    paymentTermsDays: 30,
    billingCycle: "MONTHLY",
    requestReason: status === "PENDING_REVIEW" ? "Seasonal shipment volume requires additional working credit." : undefined,
    restriction: { level: "NONE" },
    billing: {
      overdueAmountMinor: 0,
      overdueStatementCount: 0,
      nextDueAt: "2026-11-15T00:00:00.000Z",
      nextDueAmountMinor: status === "ACTIVE" ? 2000000 : 0,
      lastPayment: null
    },
    businessAccount: { id: businessAccountId, accountId: businessAccountCode, companyName: "Northstar Parts", status: "active" }
  }
});

const statements = [{
  id: statementId,
  statementNumber: "CBS/2026/00001",
  businessAccountId,
  issuedAt: "2026-10-20T00:00:00.000Z",
  dueAt: "2026-11-15T00:00:00.000Z",
  totalAmountMinor: 2000000,
  paidAmountMinor: 0,
  outstandingAmountMinor: 2000000,
  status: "ISSUED"
}];

async function mockCommon(page: Page, role: "CLIENT" | "FINANCE", calls: string[], initialCreditStatus = "ACTIVE") {
  let creditStatus = initialCreditStatus;
  let lastRequest: Record<string, unknown> | null = null;
  const accountSearches: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    calls.push(`${request.method()} ${path}`);
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
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-credit-test-token" });
    if (path === "/api/v1/auth/me") return json(route, { success: true, user: { name: "Operator User", email: "user@example.test", role: "client" } });
    if (path === `/api/v1/operators/${slug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
        membership: { role, assignedBranches: [] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts`) {
      return json(route, {
        success: true,
        accounts: [{
          _id: businessAccountId,
          accountId: businessAccountCode,
          accountKind: "BUSINESS",
          status: "active",
          company: { companyName: "Northstar Parts" },
          createdAt: "2026-10-20T00:00:00.000Z",
          updatedAt: "2026-10-20T00:00:00.000Z"
        }],
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${slug}/credit/client/summary`) {
      return json(route, summary(creditStatus, creditStatus === "ACTIVE"));
    }
    if (path === `/api/v1/operators/${slug}/credit/client/requests` && request.method() === "POST") {
      lastRequest = request.postDataJSON() as Record<string, unknown>;
      creditStatus = "PENDING_REVIEW";
      return json(route, { success: true, message: "Credit request submitted for review." }, 201);
    }
    if (path === `/api/v1/operators/${slug}/credit/client/statements`) {
      return json(route, { success: true, statements, pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } });
    }
    if (path === `/api/v1/operators/${slug}/credit/client/statements/${statementId}/pdf`) {
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 test" });
    }
    if (path === `/api/v1/operators/${slug}/credit/client/ledger`) {
      return json(route, { success: true, entries: [{ id: "ledger-1", type: "BOOKING_CONVERTED", reference: "BOOKING-1", description: "Shipment charge booked", amountMinor: 2000000, currency: "INR", availableCreditAfterMinor: 8000000, availableAdvanceAfterMinor: 0, createdAt: "2026-10-20T00:00:00.000Z" }], pagination: { page: 1, limit: 500, total: 1, totalPages: 1 } });
    }
    if (path === `/api/v1/operators/${slug}/credit/client/payments`) {
      return json(route, { success: true, payments: [{ id: "payment-1", amountMinor: 2000000, currency: "INR", method: "BANK_TRANSFER", status: "VERIFIED", internalReference: "OFFLINE-PAY-1", externalReference: "UTR-1", verifiedAt: "2026-10-21T00:00:00.000Z", createdAt: "2026-10-21T00:00:00.000Z" }], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } });
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts`) {
      accountSearches.push(url.searchParams.get("search") ?? "");
      return json(route, {
        success: true,
        creditAccounts: [{
          businessAccount: { id: businessAccountId, accountId: businessAccountCode, companyName: "Northstar Parts", status: "active", branchId: "507f1f77bcf86cd799439041" },
          creditAccount: { ...summary(creditStatus).creditAccount, businessAccountId }
        }],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 }
      });
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts/${businessAccountId}`) {
      return json(route, { success: true, creditAccount: summary(creditStatus).creditAccount, businessAccount: summary(creditStatus).creditAccount.businessAccount });
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts/${businessAccountId}/approve` && request.method() === "POST") {
      lastRequest = request.postDataJSON() as Record<string, unknown>;
      creditStatus = "ACTIVE";
      return json(route, { success: true, message: "Credit facility approved and activated." });
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts/${businessAccountId}/statements`) {
      return json(route, { success: true, statements, pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } });
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts/${businessAccountId}/statements/${statementId}/pdf`) {
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 test" });
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts/${businessAccountId}/ledger`) {
      return json(route, { success: true, entries: [], pagination: { page: 1, limit: 500, total: 0, totalPages: 1 } });
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts/${businessAccountId}/payments/offline` && request.method() === "POST") {
      lastRequest = request.postDataJSON() as Record<string, unknown>;
      return json(route, { success: true, message: "Offline payment recorded and applied.", payment: { id: "payment-2", ...lastRequest, status: "VERIFIED" } }, 201);
    }
    if (role === "FINANCE" && path === `/api/v1/operators/${slug}/credit/accounts/${businessAccountId}/payments` && request.method() === "GET") {
      return json(route, { success: true, payments: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 1 } });
    }
    return json(route, { success: false, message: `No credit test fixture for ${request.method()} ${path}` }, 404);
  });
  return { getLastRequest: () => lastRequest, getAccountSearches: () => accountSearches };
}

test("operator client can view balances and statements and download the statement PDF", async ({ page }) => {
  const calls: string[] = [];
  await mockCommon(page, "CLIENT", calls);
  await page.goto(`/portal/${slug}/credit`);

  await expect(page.getByRole("heading", { name: "Credit and statements" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Northstar Parts" })).toBeVisible();
  await expect(page.getByLabel("Business account", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Approved credit")).toBeVisible();
  await expect(page.getByText("CBS/2026/00001")).toBeVisible();
  await expect(page.getByText("Shipment charge booked")).toBeVisible();
  await expect(page.getByText("UTR-1")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("CBS-2026-00001.pdf");
  expect(calls.some((call) => call.includes("/payments/online"))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator client can request a credit facility and sees its review state", async ({ page }) => {
  const calls: string[] = [];
  const api = await mockCommon(page, "CLIENT", calls, "NOT_REQUESTED");
  await page.goto(`/portal/${slug}/credit`);
  await expect(page.getByRole("heading", { name: "Request a credit facility" })).toBeVisible();
  await page.getByLabel("Requested limit (INR)").fill("1250");
  await page.getByLabel("Reason").fill("Seasonal shipment volume requires a credit facility.");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Credit request submitted for review.")).toBeVisible();
  expect(api.getLastRequest()).toMatchObject({ businessAccountId, requestedCreditLimitMinor: 125000 });
  expect(calls).toContain(`POST /api/v1/operators/${slug}/credit/client/requests`);
});

test("operator finance staff can inspect a branch-scoped credit account", async ({ page }) => {
  const calls: string[] = [];
  const api = await mockCommon(page, "FINANCE", calls);
  await page.goto(`/portal/${slug}/credit`);

  await expect(page.getByRole("heading", { name: "Credit and statements" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Northstar Parts" })).toBeVisible();
  const accountPicker = page.getByRole("combobox", { name: "Business account" });
  await expect(accountPicker).toBeVisible();
  await expect(accountPicker).toHaveValue("Northstar Parts");
  await accountPicker.fill("Northstar");
  const accountOption = page.getByRole("option", { name: /Northstar Parts/ });
  await expect(accountOption).toBeVisible();
  await accountOption.click();
  await expect(accountPicker).toHaveValue("Northstar Parts");
  await expect.poll(() => api.getAccountSearches()).toContain("Northstar");
  await expect(page.getByText("Find an account")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(page.getByText("CBS/2026/00001")).toBeVisible();
  const paymentMethod = page.getByLabel("Payment method");
  const paymentMethodPadding = await paymentMethod.evaluate((element) => getComputedStyle(element).paddingRight);
  expect(Number.parseFloat(paymentMethodPadding)).toBeGreaterThanOrEqual(44);
  expect(calls).toContain(`GET /api/v1/operators/${slug}/credit/accounts/${businessAccountId}`);
  expect(calls.some((call) => call.includes("/client/"))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator finance can approve a client request without a Swiftline credit route", async ({ page }) => {
  const calls: string[] = [];
  const api = await mockCommon(page, "FINANCE", calls, "PENDING_REVIEW");
  await page.goto(`/portal/${slug}/credit`);
  await page.getByRole("button", { name: "Review and approve" }).click();
  await expect(page.getByRole("dialog").getByText("Seasonal shipment volume requires additional working credit.")).toBeVisible();
  await expect(page.getByLabel("Internal Remarks")).toHaveCount(0);
  await page.getByLabel("Approved Limit (INR)").fill("5000");
  await page.getByLabel("Decision Reason").fill("Approved after operator review.");
  await page.getByRole("button", { name: "Approve Credit" }).click();
  await expect(page.getByText("Credit facility approved and activated.")).toBeVisible();
  expect(api.getLastRequest()).toMatchObject({ approvedCreditLimitMinor: 500000, reason: "Approved after operator review." });
  expect(api.getLastRequest()).not.toHaveProperty("internalRemarks");
  expect(calls).toContain(`POST /api/v1/operators/${slug}/credit/accounts/${businessAccountId}/approve`);
  expect(calls.some((call) => call.includes("/api/v1/credit-accounts/"))).toBe(false);
});

test("operator finance can record an offline payment without Razorpay", async ({ page }) => {
  const calls: string[] = [];
  const api = await mockCommon(page, "FINANCE", calls);
  await page.goto(`/portal/${slug}/credit`);
  await page.getByLabel("Amount received (INR)").fill("2500");
  await page.getByLabel("Payment method").selectOption("UPI");
  await page.getByLabel("Payment reference").fill("UPI-TEST-1001");
  await page.getByLabel("Notes (optional)").fill("Received outside the portal.");
  await page.getByRole("button", { name: "Record and apply payment" }).click();
  await expect(page.getByText("Offline payment recorded and applied.")).toBeVisible();
  expect(api.getLastRequest()).toMatchObject({ amountMinor: 250000, method: "UPI", externalReference: "UPI-TEST-1001" });
  expect(calls).toContain(`POST /api/v1/operators/${slug}/credit/accounts/${businessAccountId}/payments/offline`);
  expect(calls.some((call) => call.includes("razorpay"))).toBe(false);
});
