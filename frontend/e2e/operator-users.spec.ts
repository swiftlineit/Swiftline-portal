import { expect, test, type Page, type Route, type TestInfo } from "playwright/test";

const operatorSlug = "northstar-cargo";
const teamMembershipId = "507f1f77bcf86cd799439041";
const clientMembershipId = "507f1f77bcf86cd799439043";

function json(route: Route, body: unknown, status = 200) {
  const origin = route.request().headers().origin;
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : undefined,
    body: JSON.stringify(body)
  });
}

async function mockOperatorUsers(page: Page, profileDelayMs = 0) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-users-test-token" });

    if (path === `/api/v1/operators/${operatorSlug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439001", slug: operatorSlug, companyName: "Northstar Cargo" },
        membership: { role: "OPERATOR_ADMIN", assignedBranches: [] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }
    if (path === "/api/v1/profile") {
      return json(route, { success: true, user: { name: "Olivia Admin", email: "admin@northstar.example", role: "client", hasProfileImage: false } });
    }
    if (path === `/api/v1/operators/${operatorSlug}/users`) {
      return json(route, {
        success: true,
        teamUsers: [{
          _id: teamMembershipId,
          role: "OPERATIONS",
          membershipStatus: "ACTIVE",
          createdAt: "2026-10-20T10:00:00.000Z",
          user: { _id: "507f1f77bcf86cd799439042", firstName: "Asha", lastName: "Shah", name: "Asha Shah", email: "asha@example.test", phone: "+919876543210", designation: "Hub supervisor", userStatus: "active", lastLogin: "2026-10-25T10:00:00.000Z" }
        }],
        teamPagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
        clientUsers: [{
          _id: clientMembershipId,
          role: "account_owner",
          membershipStatus: "active",
          createdAt: "2026-10-20T10:00:00.000Z",
          user: { _id: "507f1f77bcf86cd799439044", firstName: "Cleo", lastName: "Client", name: "Cleo Client", email: "cleo@example.test", phone: "+919876543211", designation: "Warehouse manager", userStatus: "active", lastLogin: "2026-10-25T10:00:00.000Z" },
          account: { accountId: "BA-2026-100001", companyName: "Harbor Imports" }
        }],
        clientPagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${operatorSlug}/users/team/${teamMembershipId}`) {
      if (profileDelayMs) await new Promise((resolve) => setTimeout(resolve, profileDelayMs));
      return json(route, {
        success: true,
        profile: {
          audience: "team",
          membership: { id: teamMembershipId, role: "OPERATIONS", status: "ACTIVE", createdAt: "2026-10-20T10:00:00.000Z" },
          user: { id: "507f1f77bcf86cd799439042", firstName: "Asha", lastName: "Shah", name: "Asha Shah", email: "asha@example.test", phone: "+919876543210", designation: "Hub supervisor", userStatus: "active", lastLogin: "2026-10-25T10:00:00.000Z" },
          account: null,
          branches: [{ id: "507f1f77bcf86cd799439031", name: "North Hub", code: "NORTH" }],
          allBranchesAccess: false
        }
      });
    }
    if (path === `/api/v1/operators/${operatorSlug}/users/clients/${clientMembershipId}`) {
      if (profileDelayMs) await new Promise((resolve) => setTimeout(resolve, profileDelayMs));
      return json(route, {
        success: true,
        profile: {
          audience: "clients",
          membership: { id: clientMembershipId, role: "account_owner", status: "active", createdAt: "2026-10-20T10:00:00.000Z" },
          user: { id: "507f1f77bcf86cd799439044", firstName: "Cleo", lastName: "Client", name: "Cleo Client", email: "cleo@example.test", phone: "+919876543211", designation: "Warehouse manager", userStatus: "active", lastLogin: "2026-10-25T10:00:00.000Z" },
          account: { accountId: "BA-2026-100001", companyName: "Harbor Imports" },
          branches: [{ id: "507f1f77bcf86cd799439031", name: "North Hub", code: "NORTH" }],
          allBranchesAccess: false
        }
      });
    }
    if (path === `/api/v1/operators/${operatorSlug}/notifications`) {
      return json(route, { success: true, notifications: [], unreadCount: 0, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    }
    return json(route, { success: false, message: "Not found" }, 404);
  });
}

test("operator users are tabular and both View actions open read-only profiles", async ({ page }, testInfo: TestInfo) => {
  await mockOperatorUsers(page);
  if (!testInfo.project.name.startsWith("mobile")) await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/portal/${operatorSlug}/users/team/${teamMembershipId}`);
  await expect(page.getByRole("heading", { name: "Asha Shah", exact: true })).toBeVisible();
  await page.goto(`/portal/${operatorSlug}/users/clients/${clientMembershipId}`);
  await expect(page.getByRole("heading", { name: "Cleo Client", exact: true })).toBeVisible();
  await page.goto(`/portal/${operatorSlug}/users`);

  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Workspace home", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /refresh/i })).toHaveCount(0);
  const teamSection = page.locator("#operator-team-users");
  const clientSection = page.locator("#operator-client-users");
  await expect(teamSection.getByRole("columnheader")).toHaveText(["User", "Role", "Company / designation", "Status", "Last login", "Action"]);
  await expect(teamSection.getByRole("row").nth(1)).toContainText("Asha Shah");
  await expect(clientSection.getByRole("row").nth(1)).toContainText("Harbor Imports");
  await expect(clientSection.getByText("Login: Active")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("operator-users-directory.png"), fullPage: true });

  const usersHeader = await page.locator("main > div > header").first().boundingBox();
  const workspaceLink = await page.getByRole("link", { name: "Workspace home", exact: true }).boundingBox();
  const headerContent = page.locator("[data-operator-header-content]");
  const headerLogoLink = await headerContent.locator("a").first().boundingBox();
  const teamSectionBox = await teamSection.boundingBox();
  const headerContentBox = await headerContent.boundingBox();
  const headerPadding = await headerContent.evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) };
  });
  expect(usersHeader && workspaceLink).not.toBeNull();
  expect(Math.abs(workspaceLink!.x + workspaceLink!.width - (usersHeader!.x + usersHeader!.width))).toBeLessThan(3);
  expect(headerLogoLink && teamSectionBox && headerContentBox).not.toBeNull();
  expect(Math.abs(teamSectionBox!.x - headerLogoLink!.x)).toBeLessThan(3);
  expect(Math.abs(teamSectionBox!.x + teamSectionBox!.width - (headerContentBox!.x + headerContentBox!.width - headerPadding.right))).toBeLessThan(3);

  await teamSection.getByRole("link", { name: "View profile for Asha Shah" }).click();
  await expect(page).toHaveURL(new RegExp(`/users/team/${teamMembershipId}$`));
  await expect(page.getByRole("heading", { name: "Asha Shah", exact: true })).toBeVisible();
  const profileHeader = await page.locator("main > div > header").first().boundingBox();
  const profileBackLink = await page.getByRole("link", { name: "Back to operator team", exact: true }).boundingBox();
  const profileCard = await page.locator("main > div > section").first().boundingBox();
  expect(profileHeader && profileBackLink).not.toBeNull();
  expect(Math.abs(profileBackLink!.x + profileBackLink!.width - (profileHeader!.x + profileHeader!.width))).toBeLessThan(3);
  expect(profileCard && headerLogoLink && headerContentBox).not.toBeNull();
  expect(Math.abs(profileCard!.x - headerLogoLink!.x)).toBeLessThan(3);
  expect(Math.abs(profileCard!.x + profileCard!.width - (headerContentBox!.x + headerContentBox!.width - headerPadding.right))).toBeLessThan(3);
  await expect(page.getByText("North Hub (NORTH)")).toBeVisible();
  await expect(page.getByRole("button", { name: /edit/i })).toHaveCount(0);

  await page.getByRole("link", { name: "Back to operator team" }).click();
  await expect(teamSection.getByRole("row").nth(1)).toContainText("Asha Shah");
  await page.goto(`/portal/${operatorSlug}/users`);
  const clientProfileLink = clientSection.getByRole("link", { name: "View profile for Cleo Client" });
  await expect(clientProfileLink).toHaveAttribute("href", `/portal/${operatorSlug}/users/clients/${clientMembershipId}`);
  await clientProfileLink.click();
  await expect(page).toHaveURL(new RegExp(`/users/clients/${clientMembershipId}$`), { timeout: 20000 });
  await expect(page.getByRole("heading", { name: "Cleo Client", exact: true })).toBeVisible();
  await expect(page.getByText("Harbor Imports").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /edit/i })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("operator-users-profile.png"), fullPage: true });
});

test("read-only user profile shows its loading indicator centered beneath the page heading", async ({ page }) => {
  await mockOperatorUsers(page, 800);
  await page.goto(`/portal/${operatorSlug}/users/team/${teamMembershipId}`);

  const loadingStatus = page.getByRole("status").filter({ hasText: "Loading user profile" });
  await expect(loadingStatus).toBeVisible();
  const statusBox = await loadingStatus.boundingBox();
  const pageHeading = await page.getByRole("heading", { name: "User profile", exact: true }).boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(statusBox).not.toBeNull();
  expect(Math.abs(statusBox!.x + statusBox!.width / 2 - viewport.width / 2)).toBeLessThan(6);
  expect(statusBox!.y + statusBox!.height / 2).toBeGreaterThan(pageHeading!.y + pageHeading!.height);
  await expect(page.getByRole("heading", { name: "Asha Shah", exact: true })).toBeVisible();
});
