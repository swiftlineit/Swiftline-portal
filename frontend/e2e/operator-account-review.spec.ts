import { expect, test, type Route, type TestInfo } from "playwright/test";

const slug = "northstar-cargo";
const accountId = "BA-2026-123456";
const accountKey = "507f1f77bcf86cd799439021";
const branchId = "507f1f77bcf86cd799439031";

function json(route: Route, body: unknown, status = 200) {
  const origin = route.request().headers().origin;
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : undefined,
    body: JSON.stringify(body)
  });
}

function accountFixture() {
  return {
    _id: accountKey,
    accountId,
    status: "pending_review",
    contact: {
      title: "ms.", firstName: "Asha", lastName: "Mehta", email: "asha@example.test",
      mobileType: "mobile", countryCode: "+91", mobileNumber: "9876543210",
      jobTitle: "Owner", department: "Operations", shipmentTypes: ["international_courier"]
    },
    company: {
      companyName: "Northstar Parts", registeredAddress: "10 Market Road", city: "Delhi",
      gstExempt: false, requestedCreditLimit: { currency: "INR", amount: 0 }
    },
    documents: {
      aadhaarCard: { type: "aadhaarCard", originalName: "aadhaar.pdf", storedName: "aadhaar.pdf", mimeType: "application/pdf", size: 100, uploadedAt: "2026-10-22T00:00:00.000Z" },
      panCard: { type: "panCard", originalName: "pan.pdf", storedName: "pan.pdf", mimeType: "application/pdf", size: 100, uploadedAt: "2026-10-22T00:00:00.000Z" }
    },
    kycReview: { overallStatus: "submitted", checks: {} },
    assignedBranch: { _id: branchId, name: "North Hub", code: "NORTH", status: "ACTIVE" },
    createdAt: "2026-10-22T08:00:00.000Z",
    submittedAt: "2026-10-22T08:00:00.000Z"
  };
}

test("operator admin reviews KYC, approves locally, and creates access in the operator route", async ({ page }) => {
  const account = accountFixture();
  const apiCalls: string[] = [];
  let createdMemberEmail = "";

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    apiCalls.push(`${request.method()} ${path}`);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/api/v1/auth/refresh") return json(route, { success: true, accessToken: "operator-admin-test-token" });
    if (path === `/api/v1/operators/${slug}/me`) return json(route, {
      success: true,
      operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
      membership: { role: "OPERATOR_ADMIN", assignedBranches: [] },
      access: { mode: "MEMBER", readOnly: false }
    });
    if (path === `/api/v1/operators/${slug}/branches`) return json(route, {
      success: true,
      branches: [{ _id: branchId, name: "North Hub", code: "NORTH", status: "ACTIVE" }],
      pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 }
    });
    if (path === `/api/v1/operators/${slug}/business-accounts/${accountId}` && request.method() === "GET") {
      return json(route, { success: true, account });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts/${accountId}/kyc-review` && request.method() === "PATCH") {
      const payload = request.postDataJSON() as { checks?: Record<string, { status: string }> };
      Object.assign(account.kycReview.checks, payload.checks ?? {});
      const requiredChecks = ["contactDetails", "companyDetails", "aadhaarCard", "panCard"];
      const checks = account.kycReview.checks as Record<string, { status: string }>;
      account.kycReview.overallStatus = requiredChecks.every((key) => checks[key]?.status === "verified") ? "verified" : "under_review";
      return json(route, { success: true, account });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts/${accountId}/status` && request.method() === "PATCH") {
      const payload = request.postDataJSON() as { status: string };
      account.status = payload.status;
      return json(route, { success: true, account, message: `Business account ${payload.status}.` });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts/${accountId}/members` && request.method() === "GET") {
      return json(route, { success: true, members: [] });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts/${accountId}/client-access` && request.method() === "POST") {
      const payload = request.postDataJSON() as { email: string; assignedBranches: string[]; role: string };
      createdMemberEmail = payload.email;
      expect(payload.assignedBranches).toEqual([branchId]);
      expect(payload.role).toBe("account_owner");
      return json(route, {
        success: true,
        member: {
          _id: "507f1f77bcf86cd799439099", role: payload.role, status: "invited", createdAt: "2026-10-23T08:00:00.000Z",
          user: { _id: "507f1f77bcf86cd799439098", firstName: "Nora", lastName: "Shah", name: "Nora Shah", email: payload.email, phone: "+919876543210", userStatus: "invited" },
          assignedBranches: [{ _id: branchId, name: "North Hub", code: "NORTH" }], invitation: { expiresAt: "2026-10-24T08:00:00.000Z" }
        },
        emailSent: true,
        emailSkipped: false,
        requiresSignIn: false
      }, 201);
    }
    return json(route, { success: false, message: `No fixture for ${request.method()} ${path}` }, 404);
  });

  await page.goto(`/portal/${slug}/business-accounts/${accountId}`);
  await expect(page.getByRole("heading", { name: "Local KYC review" })).toBeVisible();

  for (const label of ["Contact details", "Company details", "Aadhaar Card", "PAN Card Copy"]) {
    const response = page.waitForResponse((item) =>
      new URL(item.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/kyc-review`
      && item.request().method() === "PATCH"
    );
    await page.getByRole("combobox", { name: `${label} review status` }).selectOption("verified");
    expect((await response).status()).toBe(200);
  }

  await expect(page.getByText("verified", { exact: true }).first()).toBeVisible();
  const approval = page.waitForResponse((item) =>
    new URL(item.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/status`
    && item.request().method() === "PATCH"
  );
  await page.getByRole("button", { name: "Approve account" }).click();
  expect((await approval).status()).toBe(200);
  await expect(page.getByText("Business account approved locally.")).toBeVisible();

  await page.getByRole("button", { name: "Deactivate account" }).click();
  const deactivateDialog = page.getByRole("dialog", { name: "Deactivate business account?" });
  const suspendResponse = page.waitForResponse((item) =>
    new URL(item.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/status`
    && item.request().method() === "PATCH"
  );
  await deactivateDialog.getByRole("button", { name: "Deactivate account" }).click();
  expect((await suspendResponse).status()).toBe(200);
  await expect(page.getByText("Business account deactivated. New shipment bookings are blocked.")).toBeVisible();

  await page.getByRole("button", { name: "Activate account" }).click();
  const activateDialog = page.getByRole("dialog", { name: "Activate business account?" });
  const reactivateResponse = page.waitForResponse((item) =>
    new URL(item.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/status`
    && item.request().method() === "PATCH"
  );
  await activateDialog.getByRole("button", { name: "Activate account" }).click();
  expect((await reactivateResponse).status()).toBe(200);
  await expect(page.getByText("Business account activated and ready for bookings.")).toBeVisible();

  await page.getByRole("tab", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Create Client Login" }).click();
  const dialog = page.getByRole("dialog", { name: "Create client login" });
  await dialog.getByLabel("First Name").fill("Nora");
  await dialog.getByLabel("Last Name").fill("Shah");
  await dialog.locator('input[type="email"]').fill("nora@example.test");
  await dialog.getByLabel("Phone Number").fill("+919876543210");
  const creation = page.waitForResponse((item) =>
    new URL(item.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/client-access`
    && item.request().method() === "POST"
  );
  await dialog.getByRole("button", { name: "Create Login" }).click();
  expect((await creation).status()).toBe(201);
  await expect(page.getByText("nora@example.test", { exact: true })).toBeVisible();
  expect(createdMemberEmail).toBe("nora@example.test");
  expect(apiCalls.some((call) => call.includes("/api/v1/business-accounts/"))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator administrators approve verified accounts and deactivate active accounts from the directory", async ({ page }, testInfo: TestInfo) => {
  const accounts = [
    {
      _id: accountKey,
      accountId,
      accountKind: "BUSINESS",
      status: "pending_review",
      contact: { firstName: "Asha", lastName: "Mehta", email: "asha@example.test" },
      company: { companyName: "Northstar Parts" },
      kycReview: { overallStatus: "verified" },
      assignedBranch: { _id: branchId, name: "North Hub", code: "NORTH", status: "ACTIVE" },
      createdAt: "2026-10-22T08:00:00.000Z",
      updatedAt: "2026-10-22T08:00:00.000Z"
    },
    {
      _id: "507f1f77bcf86cd799439022",
      accountId: "BA-2026-654321",
      accountKind: "BUSINESS",
      status: "active",
      contact: { firstName: "Ravi", lastName: "Kapoor", email: "ravi@example.test" },
      company: { companyName: "Harbor Trading" },
      kycReview: { overallStatus: "verified" },
      assignedBranch: { _id: branchId, name: "North Hub", code: "NORTH", status: "ACTIVE" },
      createdAt: "2026-10-21T08:00:00.000Z",
      updatedAt: "2026-10-21T08:00:00.000Z"
    }
  ];
  const statusUpdates: Array<{ accountId: string; status: string }> = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/api/v1/auth/refresh") return json(route, { success: true, accessToken: "operator-admin-test-token" });
    if (path === `/api/v1/operators/${slug}/me`) return json(route, {
      success: true,
      operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
      membership: { role: "OPERATOR_ADMIN", assignedBranches: [] },
      access: { mode: "MEMBER", readOnly: false }
    });
    if (path === `/api/v1/operators/${slug}/business-accounts` && request.method() === "GET") return json(route, {
      success: true,
      accounts,
      pagination: { page: 1, pageSize: 10, total: accounts.length, totalPages: 1 }
    });
    const statusMatch = path.match(new RegExp(`^/api/v1/operators/${slug}/business-accounts/([^/]+)/status$`));
    if (statusMatch && request.method() === "PATCH") {
      const target = accounts.find((item) => item.accountId === statusMatch[1]);
      if (!target) return json(route, { success: false, message: "Account not found" }, 404);
      const payload = request.postDataJSON() as { status: string };
      target.status = payload.status;
      statusUpdates.push({ accountId: target.accountId, status: payload.status });
      return json(route, { success: true, account: target, message: `Business account ${payload.status}.` });
    }
    return json(route, { success: false, message: `No fixture for ${request.method()} ${path}` }, 404);
  });

  await page.goto(`/portal/${slug}/business-accounts`);
  await expect(page.getByRole("heading", { name: "Business accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Workspace home", exact: true })).toHaveAttribute("href", `/portal/${slug}`);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);

  const headerBounds = await page.locator("header").first().locator(":scope > div").boundingBox();
  const accountPageBounds = await page.locator("main > div").first().boundingBox();
  expect(headerBounds).not.toBeNull();
  expect(accountPageBounds).not.toBeNull();
  expect(Math.abs(headerBounds!.x - accountPageBounds!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(headerBounds!.width - accountPageBounds!.width)).toBeLessThanOrEqual(1);

  const pendingRow = (testInfo.project.name === "mobile-chromium" ? page.getByRole("listitem") : page.getByRole("row")).filter({ hasText: "Northstar Parts" });
  const approveResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/status`
    && response.request().method() === "PATCH"
  );
  await pendingRow.getByRole("button", { name: "Approve Northstar Parts" }).click();
  expect((await approveResponse).status()).toBe(200);
  await expect(pendingRow.getByText("Approved", { exact: true })).toBeVisible();

  await pendingRow.getByRole("button", { name: "Deactivate Northstar Parts" }).click();
  const approvedAccountDialog = page.getByRole("dialog", { name: "Deactivate business account?" });
  const suspendApprovedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/status`
    && response.request().method() === "PATCH"
  );
  await approvedAccountDialog.getByRole("button", { name: "Deactivate account" }).click();
  expect((await suspendApprovedResponse).status()).toBe(200);
  await expect(pendingRow.getByText("Suspended", { exact: true })).toBeVisible();

  await pendingRow.getByRole("button", { name: "Activate Northstar Parts" }).click();
  const activateApprovedDialog = page.getByRole("dialog", { name: "Activate business account?" });
  const reactivateApprovedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/operators/${slug}/business-accounts/${accountId}/status`
    && response.request().method() === "PATCH"
  );
  await activateApprovedDialog.getByRole("button", { name: "Activate account" }).click();
  expect((await reactivateApprovedResponse).status()).toBe(200);
  await expect(pendingRow.getByText("Active", { exact: true })).toBeVisible();

  const activeRow = (testInfo.project.name === "mobile-chromium" ? page.getByRole("listitem") : page.getByRole("row")).filter({ hasText: "Harbor Trading" });
  await activeRow.getByRole("button", { name: "Deactivate Harbor Trading" }).click();
  const dialog = page.getByRole("dialog", { name: "Deactivate business account?" });
  await expect(dialog).toContainText("block new shipment bookings");
  const deactivateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/operators/${slug}/business-accounts/BA-2026-654321/status`
    && response.request().method() === "PATCH"
  );
  await dialog.getByRole("button", { name: "Deactivate account" }).click();
  expect((await deactivateResponse).status()).toBe(200);
  await expect(activeRow.getByText("Suspended", { exact: true })).toBeVisible();

  await activeRow.getByRole("button", { name: "Activate Harbor Trading" }).click();
  const activateHarborDialog = page.getByRole("dialog", { name: "Activate business account?" });
  const activateHarborResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/operators/${slug}/business-accounts/BA-2026-654321/status`
    && response.request().method() === "PATCH"
  );
  await activateHarborDialog.getByRole("button", { name: "Activate account" }).click();
  expect((await activateHarborResponse).status()).toBe(200);
  await expect(activeRow.getByText("Active", { exact: true })).toBeVisible();
  expect(statusUpdates).toEqual([
    { accountId, status: "approved" },
    { accountId, status: "suspended" },
    { accountId, status: "active" },
    { accountId: "BA-2026-654321", status: "suspended" },
    { accountId: "BA-2026-654321", status: "active" }
  ]);

  if (testInfo.project.name === "mobile-chromium") {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("existing client accepts an operator account invitation without changing its shared login", async ({ page }) => {
  const apiCalls: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    apiCalls.push(`${request.method()} ${path}`);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/api/v1/auth/refresh") return json(route, { success: true, accessToken: "existing-client-test-token" });
    if (path === "/api/v1/auth/invitations/client-operator-token") return json(route, {
      success: true,
      invitation: {
        kind: "BUSINESS", email: "asha@example.test", name: "Asha Mehta", companyName: "Northstar Parts",
        businessAccountId: accountId, operatorSlug: slug, requiresSignIn: true, expiresAt: "2026-10-24T08:00:00.000Z"
      }
    });
    if (path === "/api/v1/auth/accept-operator-client-invitation" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ token: "client-operator-token" });
      return json(route, { success: true, message: "Client access is active for this operator portal.", operator: { slug } });
    }
    if (path === `/api/v1/operators/${slug}/me`) return json(route, {
      success: true, operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
      membership: { role: "CLIENT", assignedBranches: [branchId] },
      access: { mode: "MEMBER", readOnly: false }
    });
    if (path === `/api/v1/operators/${slug}/business-accounts`) return json(route, {
      success: true, accounts: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 }
    });
    if (path === `/api/v1/operators/${slug}/branches`) return json(route, {
      success: true, branches: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 }
    });
    return json(route, { success: false, message: `No fixture for ${request.method()} ${path}` }, 404);
  });

  await page.goto("/auth/activate?token=client-operator-token");
  await expect(page.getByText("Operator portal: /portal/northstar-cargo", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept client access" })).toBeVisible();
  const acceptance = page.waitForResponse((item) =>
    new URL(item.url()).pathname === "/api/v1/auth/accept-operator-client-invitation"
    && item.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Accept client access" }).click();
  expect((await acceptance).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/portal/${slug}$`), { timeout: 30_000 });
  expect(apiCalls).toContain("POST /api/v1/auth/accept-operator-client-invitation");
});
