import { expect, test, type Page, type Route } from "playwright/test";

const operatorSlug = "northstar-cargo";
const branchId = "507f1f77bcf86cd799439031";
const staffMembershipId = "507f1f77bcf86cd799439041";
const clientMembershipId = "507f1f77bcf86cd799439043";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function branchFixture(status: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: branchId,
    name: "North Hub",
    code: "NORTH",
    ...payload,
    status,
    address: { countryCode: "IN", countryName: "India", city: "Mumbai", stateOrProvince: "Maharashtra", postalCode: "400001", address: "10 Market Road" },
    contact: { email: "north-hub@example.test", phone: "+919876543210" },
    operations: { supportedServices: ["EXPRESS_COURIER"], shipmentCoverage: ["DOMESTIC"], operatingCountries: ["IN"], workingDays: ["MONDAY"] },
    baseCurrency: "INR",
    gstin: "",
    invoiceSacCode: "",
    phoneNumbers: [],
    images: [],
    documents: [],
    openingDate: "2026-01-15T00:00:00.000Z",
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z"
  };
}

function businessAccountFixture(): Record<string, unknown> {
  return {
    _id: "507f1f77bcf86cd799439051",
    accountId: "BA-2026-100001",
    status: "approved",
    origin: "STAFF",
    contact: { title: "Ms", firstName: "Cleo", lastName: "Client", email: "cleo@example.test", mobileType: "mobile", countryCode: "+91", mobileNumber: "9876543210", jobTitle: "Warehouse manager", department: "Logistics", shipmentTypes: ["international_courier"] },
    company: { registrationCountry: "India", registrationIdType: "pan", registrationId: "", companyType: "Private limited", companyName: "Harbor Imports", registeredAddress: "10 Market Road", city: "Mumbai", stateOrProvince: "Maharashtra", postalCode: "400001", operatingCountries: ["India"], industry: "Logistics", monthlyShipmentVolume: "10-50", requestedCreditLimit: { currency: "INR", amount: 100000 } },
    documents: {},
    kycReview: { overallStatus: "verified", checks: {} },
    creditLimitStatus: "approved",
    depositStatus: "not_required",
    agreementStatus: "not_generated",
    assignedBranch: { _id: branchId, name: "North Hub", code: "NORTH", status: "ACTIVE" },
    createdBy: { email: "operator@example.test", name: "Operator Admin" },
    createdAt: "2026-10-22T10:00:00.000Z"
  };
}

async function mockOperatorBranchApi(
  page: Page,
  role: "OPERATOR_ADMIN" | "OPERATIONS" = "OPERATOR_ADMIN",
  initialStatus: string | null = null
) {
  let branch: Record<string, unknown> | null = initialStatus ? branchFixture(initialStatus) : null;
  const branchApiRequests: Array<{ method: string; path: string }> = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-branches-test-token" });
    if (path === `/api/v1/operators/${operatorSlug}/me` && method === "GET") {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439001", slug: operatorSlug, companyName: "Northstar Cargo" },
        membership: { role, assignedBranches: [] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }

    if (path.startsWith(`/api/v1/operators/${operatorSlug}/branches`)) {
      branchApiRequests.push({ method, path });
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}/documents/0` && method === "GET") {
      return route.fulfill({ status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF-1.7\n% operator branch document fixture\n" });
    }

    if (path === `/api/v1/operators/${operatorSlug}/branches` && method === "GET") {
      return json(route, {
        success: true,
        branches: branch ? [branch] : [],
        pagination: { page: 1, pageSize: 20, total: branch ? 1 : 0, totalPages: branch ? 1 : 0 }
      });
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}/details` && method === "GET") {
      return branch
        ? json(route, { success: true, branch: { ...branch, openingDate: "2026-01-15T00:00:00.000Z", description: "Main regional operating hub", gstin: "27ABCDE1234F1Z5", invoiceSacCode: "996812", activatedAt: "2026-02-01T00:00:00.000Z", phoneNumbers: [], documents: [{ type: "GST", title: "GST certificate", fileName: "gst-certificate.pdf", mimeType: "application/pdf", uploadedAt: "2026-10-20T10:00:00.000Z" }], updatedAt: "2026-10-26T10:30:00.000Z" } })
        : json(route, { success: false, message: "Branch not found" }, 404);
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}/users/${clientMembershipId}` && method === "GET") {
      return json(route, {
        success: true,
        branch: { _id: branchId, name: "North Hub" },
        user: { _id: clientMembershipId, role: "account_owner", membershipStatus: "active", createdAt: "2026-10-20T10:00:00.000Z", user: { _id: "507f1f77bcf86cd799439044", firstName: "Cleo", lastName: "Client", name: "Cleo Client", email: "cleo@example.test", phone: "+919876543210", designation: "Warehouse manager", userStatus: "active", lastLogin: "2026-10-25T10:00:00.000Z" }, account: { accountId: "BA-2026-100001", companyName: "Harbor Imports" } }
      });
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}/users` && method === "GET") {
      return json(route, {
        success: true,
        users: [
          { _id: staffMembershipId, role: "OPERATIONS", membershipStatus: "ACTIVE", createdAt: "2026-10-20T10:00:00.000Z", user: { _id: "507f1f77bcf86cd799439042", firstName: "Asha", lastName: "Shah", name: "Asha Shah", email: "asha@example.test", phone: "+919876543210", designation: "Manager", userStatus: "active", lastLogin: "2026-10-25T10:00:00.000Z" }, account: null },
          { _id: clientMembershipId, role: "account_owner", membershipStatus: "active", createdAt: "2026-10-20T10:00:00.000Z", user: { _id: "507f1f77bcf86cd799439044", firstName: "Cleo", lastName: "Client", name: "Cleo Client", email: "cleo@example.test", phone: "+919876543210", designation: "Warehouse manager", userStatus: "active", lastLogin: "2026-10-25T10:00:00.000Z" }, account: { accountId: "BA-2026-100001", companyName: "Harbor Imports" } }
        ],
        pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${operatorSlug}/business-accounts/BA-2026-100001` && method === "GET") {
      return json(route, { success: true, account: businessAccountFixture() });
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/validate-code` && method === "GET") {
      return json(route, { success: true, exists: false, valid: true });
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches` && method === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      branch = branchFixture(String(payload.status || "DRAFT"), payload);
      return json(route, { success: true, branch }, 201);
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}/status` && method === "PATCH") {
      if (!branch) return json(route, { success: false, message: "Branch not found" }, 404);
      const payload = request.postDataJSON() as { status?: string };
      branch = { ...branch, status: payload.status };
      return json(route, { success: true, branch });
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}` && method === "GET") {
      return branch
        ? json(route, { success: true, branch })
        : json(route, { success: false, message: "Branch not found" }, 404);
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}` && method === "PATCH") {
      if (!branch) return json(route, { success: false, message: "Branch not found" }, 404);
      branch = { ...branch, ...(request.postDataJSON() as Record<string, unknown>) };
      return json(route, { success: true, branch });
    }
    if (path === `/api/v1/operators/${operatorSlug}/branches/${branchId}` && method === "DELETE") {
      if (!branch || branch.status !== "DRAFT") return json(route, { success: false, message: "Draft branch not found" }, 404);
      branch = null;
      return json(route, { success: true, message: "Draft branch deleted" });
    }

    return json(route, { success: false, message: `No branch fixture for ${method} ${path}` }, 404);
  });

  return branchApiRequests;
}

test("operator admin creates and edits a branch through slug-scoped endpoints", async ({ page }) => {
  test.setTimeout(120_000);
  const branchApiRequests = await mockOperatorBranchApi(page);
  await page.goto(`/portal/${operatorSlug}/branches`);

  await expect(page.getByRole("heading", { name: "Branches", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Create branch" }).click();
  await page.waitForURL(new RegExp(`/portal/${operatorSlug}/branches/new$`), { timeout: 30_000 });
  await page.getByLabel("Branch Name").fill("North Hub");
  await page.getByLabel("Branch Code").fill("NORTH");
  const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/operators/${operatorSlug}/branches`);
  await page.getByRole("button", { name: "Save as Draft" }).click();
  expect((await createResponse).ok()).toBe(true);
  await page.waitForURL(new RegExp(`/portal/${operatorSlug}/branches$`), { timeout: 30_000 });
  await page.getByRole("link", { name: "Edit North Hub" }).click();
  await page.waitForURL(new RegExp(`/portal/${operatorSlug}/branches/${branchId}/edit$`), { timeout: 30_000 });
  await expect(page.getByLabel("Branch Name")).toHaveValue("North Hub");
  await page.getByLabel("Branch Name").fill("North Hub Updated");
  const updateResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/operators/${operatorSlug}/branches/${branchId}`);
  await page.getByRole("button", { name: "Save Draft" }).click();
  expect((await updateResponse).ok()).toBe(true);
  await page.waitForURL(new RegExp(`/portal/${operatorSlug}/branches$`), { timeout: 30_000 });

  await page.getByRole("link", { name: "View North Hub Updated details" }).click();
  await page.locator('select[aria-label="Change status for North Hub Updated"]:visible').selectOption("delete");
  await expect(page.getByRole("dialog", { name: "Delete draft branch?" })).toBeVisible();
  const deleteResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/v1/operators/${operatorSlug}/branches/${branchId}`);
  await page.getByRole("button", { name: "Delete draft", exact: true }).click();
  expect((await deleteResponse).ok()).toBe(true);
  await expect(page.getByText("No branches found", { exact: true })).toBeVisible();

  expect(branchApiRequests.length).toBeGreaterThan(0);
  expect(branchApiRequests.every((request) => request.path.startsWith(`/api/v1/operators/${operatorSlug}/branches`))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator admin can transition branch status through slug-scoped endpoints", async ({ page }) => {
  const branchApiRequests = await mockOperatorBranchApi(page, "OPERATOR_ADMIN", "ACTIVE");
  await page.goto(`/portal/${operatorSlug}/branches`);

  await expect(page.getByRole("heading", { name: "Branches", exact: true })).toBeVisible();
  await expect(page.locator("thead th")).toHaveText(["Branch", "Contact", "Status", "Opening date", "Actions"]);
  await expect(page.getByText("north-hub@example.test").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("+919876543210").filter({ visible: true })).toBeVisible();
  await expect(page.getByLabel("Change status for North Hub")).toHaveCount(0);
  await page.getByRole("link", { name: "View North Hub details" }).click();
  const statusResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/operators/${operatorSlug}/branches/${branchId}/status`);
  const statusControl = page.locator('select[aria-label="Change status for North Hub"]:visible');
  await statusControl.selectOption("status:INACTIVE");
  expect((await statusResponse).ok()).toBe(true);
  await expect(statusControl).toHaveValue("current:INACTIVE");
  await expect(page.getByRole("status")).toContainText("Branch inactive.");
  expect(branchApiRequests.some((request) => request.method === "PATCH" && request.path.endsWith(`/${branchId}/status`))).toBe(true);
});

test("operator operations role can view branches but cannot see create or edit controls", async ({ page }) => {
  await mockOperatorBranchApi(page, "OPERATIONS", "DRAFT");
  await page.goto(`/portal/${operatorSlug}/branches`);

  await expect(page.getByRole("heading", { name: "Branches", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create branch" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit North Hub" })).toHaveCount(0);
  await expect(page.getByLabel("Change status for North Hub")).toHaveCount(0);
});

test("branch details show named accounts and open read-only branch-user profiles", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const branchApiRequests = await mockOperatorBranchApi(page, "OPERATOR_ADMIN", "ACTIVE");
  await page.route(`**/api/v1/operators/${operatorSlug}/business-accounts?**`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("branchId")).toBe(branchId);
    return json(route, {
      success: true,
      accounts: [{ _id: "507f1f77bcf86cd799439051", accountId: "BA-2026-100001", accountKind: "BUSINESS", status: "approved", company: { companyName: "Harbor Imports" }, creditSummary: { availableCreditMinor: 750000, outstandingMinor: 250000 }, kycReview: { overallStatus: "verified" }, createdAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z" }],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }
    });
  });

  await page.goto(`/portal/${operatorSlug}/branches/${branchId}`);
  await expect(page.getByRole("heading", { name: "North Hub", exact: true })).toBeVisible();
  await expect(page.getByText("10 Market Road, Mumbai, Maharashtra, 400001, India")).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit branch" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "GST certificate" });
  await expect(preview).toBeVisible();
  await expect(preview.locator("iframe")).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: "Close document preview" }).click();
  await expect(preview).toBeHidden();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("gst-certificate.pdf");

  await page.getByRole("tab", { name: "Users" }).click();
  const visibleUserName = page.viewportSize() && page.viewportSize()!.width < 1024
    ? page.locator("#branch-panel-users ul").getByText("Cleo Client", { exact: true })
    : page.locator("#branch-panel-users table").getByText("Cleo Client", { exact: true });
  await expect(visibleUserName).toBeVisible();
  const userRow = page.locator("#branch-panel-users").locator(testInfo.project.name === "mobile-chromium" ? "li" : "tr").filter({ hasText: "Cleo Client" });
  await expect(userRow.getByText("Harbor Imports", { exact: true })).toBeVisible();
  await expect(userRow.getByText("Warehouse manager", { exact: true })).toBeVisible();
  await expect(userRow.getByText("Active", { exact: true })).toHaveClass(/emerald/);
  await expect(page.getByText("Access Active", { exact: true })).toHaveCount(0);
  await userRow.getByRole("link", { name: "View profile for Cleo Client" }).click();
  await page.waitForURL(new RegExp(`/portal/${operatorSlug}/branches/${branchId}/users/${clientMembershipId}$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Cleo Client", exact: true })).toBeVisible();
  await expect(page.getByText("Read-only details for a user assigned to this branch.", { exact: true })).toBeVisible();
  await expect(page.getByText("Harbor Imports", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/Harbor Imports.*Warehouse manager/).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to branch users" })).toHaveAttribute("href", `/portal/${operatorSlug}/branches/${branchId}?tab=users`);
  await page.getByRole("link", { name: "Back to branch users" }).click();
  await expect(page).toHaveURL(new RegExp(`/portal/${operatorSlug}/branches/${branchId}\\?tab=users$`));
  await expect(page.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("tab", { name: "Business accounts" }).click();
  await expect(page.getByText("Harbor Imports", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("₹7,500.00").filter({ visible: true })).toBeVisible();
  await page.locator('select[aria-label="Actions for Harbor Imports"]:visible').selectOption("details");
  await page.waitForURL(new RegExp(`/portal/${operatorSlug}/business-accounts/BA-2026-100001$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Harbor Imports", exact: true })).toBeVisible();
  expect(branchApiRequests.some((request) => request.path.endsWith(`/branches/${branchId}/details`))).toBe(true);
  expect(branchApiRequests.some((request) => request.path.endsWith(`/branches/${branchId}/users`))).toBe(true);
  expect(branchApiRequests.some((request) => request.path.endsWith(`/branches/${branchId}/users/${clientMembershipId}`))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
