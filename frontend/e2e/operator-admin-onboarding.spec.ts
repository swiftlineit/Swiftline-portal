import { expect, test, type Page, type Route } from "playwright/test";

const operatorId = "507f1f77bcf86cd799439011";
const administratorId = "507f1f77bcf86cd799439012";
const invitationToken = "operator-invitation-test-token";

function json(route: Route, body: unknown, status = 200) {
  const origin = route.request().headers().origin;
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "authorization,content-type",
      "access-control-allow-methods": route.request().headers()["access-control-request-method"] ?? "GET,POST,OPTIONS",
      vary: "Origin"
    } : undefined,
    body: JSON.stringify(body)
  });
}

async function mockPlatformAdmin(page: Page) {
  let administratorInvited = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": request.headers().origin ?? "http://127.0.0.1:3001",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "authorization,content-type",
      "access-control-allow-methods": request.headers()["access-control-request-method"] ?? "GET,POST,OPTIONS",
      vary: "Origin"
    } });
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-ui-test-token" });
    if (path.endsWith("/auth/me")) {
      return json(route, { success: true, user: { id: "507f1f77bcf86cd799439010", email: "platform@example.test", role: "admin" } });
    }
    if (path === "/api/v1/platform/operators" && request.method() === "GET") {
      return json(route, {
        success: true,
        operators: [{
          id: operatorId,
          companyName: "Northstar Cargo",
          slug: "northstar-cargo",
          status: "DRAFT",
          createdAt: "2026-10-21T10:00:00.000Z",
          administrators: administratorInvited ? [{
            userId: administratorId,
            firstName: "Priya",
            lastName: "Sharma",
            name: "Priya Sharma",
            email: "priya@example.test",
            status: "INVITED",
            requiresSignIn: false
          }] : []
        }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/platform/operators/${operatorId}/admin-invitations` && request.method() === "POST") {
      administratorInvited = true;
      return json(route, {
        success: true,
        administrator: { userId: administratorId, email: "priya@example.test", role: "OPERATOR_ADMIN", status: "INVITED", requiresSignIn: false },
        expiresAt: "2026-10-22T10:00:00.000Z",
        emailSent: false,
        emailSkipped: true,
        emailFailed: false
      }, 201);
    }
    if (path === `/api/v1/platform/operators/${operatorId}/admin-invitations/${administratorId}/link` && request.method() === "POST") {
      return json(route, {
        success: true,
        activationUrl: `http://localhost:3000/auth/activate?token=${invitationToken}`,
        expiresAt: "2026-10-22T10:00:00.000Z"
      });
    }
    return json(route, { success: false, message: `No test fixture for ${request.method()} ${path}` }, 404);
  });
}

test("platform staff can invite the initial administrator and recover a copy link", async ({ page }) => {
  await mockPlatformAdmin(page);
  await page.goto("/dashboard/operators", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Operators", exact: true })).toBeVisible();
  await expect(page.getByText("Initial administrator", { exact: true })).toBeVisible();
  await page.getByLabel("First name").fill("Priya");
  await page.getByLabel("Last name").fill("Sharma");
  await page.getByLabel("Email address").fill("priya@example.test");
  await page.getByRole("button", { name: "Invite administrator", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("email delivery is disabled");
  await expect(page.getByText("priya@example.test", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reissue and copy link" }).click();
  await expect(page.getByLabel("Administrator activation link")).toHaveValue(new RegExp(invitationToken));

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("platform staff activate an operator only after its initial administrator accepts", async ({ page }) => {
  let operatorStatus: "DRAFT" | "ACTIVE" = "DRAFT";
  let activationCalls = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": request.headers().origin ?? "http://127.0.0.1:3001",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "authorization,content-type",
      "access-control-allow-methods": request.headers()["access-control-request-method"] ?? "GET,POST,OPTIONS",
      vary: "Origin"
    } });
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-ui-test-token" });
    if (path.endsWith("/auth/me")) {
      return json(route, { success: true, user: { id: "507f1f77bcf86cd799439010", email: "platform@example.test", role: "admin" } });
    }
    if (path === "/api/v1/platform/operators" && request.method() === "GET") {
      return json(route, {
        success: true,
        operators: [{
          id: operatorId,
          companyName: "Northstar Cargo",
          slug: "northstar-cargo",
          status: operatorStatus,
          createdAt: "2026-10-21T10:00:00.000Z",
          administrators: [{
            userId: administratorId,
            firstName: "Priya",
            lastName: "Sharma",
            name: "Priya Sharma",
            email: "priya@example.test",
            status: "ACTIVE",
            requiresSignIn: false
          }]
        }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/platform/operators/${operatorId}/activate` && request.method() === "POST") {
      activationCalls += 1;
      operatorStatus = "ACTIVE";
      return json(route, {
        success: true,
        operator: { id: operatorId, companyName: "Northstar Cargo", slug: "northstar-cargo", status: operatorStatus, createdAt: "2026-10-21T10:00:00.000Z" }
      });
    }
    return json(route, { success: false, message: `No test fixture for ${request.method()} ${path}` }, 404);
  });

  await page.goto("/dashboard/operators", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("INVITE ACCEPTED", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activate portal" }).click();
  await expect(page.getByRole("group", { name: "Confirm activation for Northstar Cargo" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm portal activation" }).click();
  await expect(page.getByText("ACTIVE", { exact: true })).toBeVisible();
  expect(activationCalls).toBe(1);
});

test("an existing invited client returns to the invitation after sign-in and accepts without a password reset", async ({ page }) => {
  let acceptedToken = "";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": request.headers().origin ?? "http://127.0.0.1:3001",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "authorization,content-type",
      "access-control-allow-methods": request.headers()["access-control-request-method"] ?? "GET,POST,OPTIONS",
      vary: "Origin"
    } });
    if (path.endsWith(`/auth/invitations/${invitationToken}`)) {
      return json(route, {
        success: true,
        invitation: {
          kind: "OPERATOR",
          email: "priya@example.test",
          name: "Priya Sharma",
          companyName: "Northstar Cargo",
          operatorSlug: "northstar-cargo",
          role: "OPERATOR_ADMIN",
          requiresSignIn: true,
          expiresAt: "2026-10-22T10:00:00.000Z"
        }
      });
    }
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-ui-test-token" });
    if (path.endsWith("/auth/accept-operator-invitation") && request.method() === "POST") {
      acceptedToken = (request.postDataJSON() as { token?: string }).token ?? "";
      return json(route, { success: true, message: "Operator administrator access is active. The platform administrator will activate the operator portal after setup.", operator: { slug: "northstar-cargo" } });
    }
    return json(route, { success: false, message: `No test fixture for ${request.method()} ${path}` }, 404);
  });

  await page.goto(`/auth/activate?token=${invitationToken}`);
  await expect(page.getByText("Operator: Northstar Cargo", { exact: true })).toBeVisible();
  await expect(page.locator('input[autocomplete="new-password"]')).toHaveCount(0);
  const loginHref = await page.getByRole("link", { name: "Sign in with the invited account" }).getAttribute("href");
  expect(new URL(loginHref ?? "", "http://localhost:3000").searchParams.get("next"))
    .toBe(`/auth/activate?token=${invitationToken}`);

  await page.getByRole("button", { name: "Accept operator invitation" }).click();
  await expect(page.getByRole("status")).toContainText("activate the operator portal after setup");
  expect(acceptedToken).toBe(invitationToken);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("existing Swiftline business invitations keep their password-activation workflow", async ({ page }) => {
  let activation: Record<string, unknown> | null = null;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith(`/auth/invitations/${invitationToken}`)) {
      return json(route, {
        success: true,
        invitation: {
          kind: "BUSINESS",
          email: "client@example.test",
          name: "Client User",
          businessAccountId: "BA-TEST",
          companyName: "Swiftline Client Co.",
          expiresAt: "2026-10-22T10:00:00.000Z"
        }
      });
    }
    if (path.endsWith("/auth/activate-invitation") && request.method() === "POST") {
      activation = request.postDataJSON() as Record<string, unknown>;
      return json(route, { success: true, message: "Account activated successfully." });
    }
    return json(route, { success: false, message: `No test fixture for ${request.method()} ${path}` }, 404);
  });

  await page.goto(`/auth/activate?token=${invitationToken}`);
  await expect(page.getByText("Company: Swiftline Client Co.", { exact: true })).toBeVisible();
  await page.locator('input[autocomplete="new-password"]').nth(0).fill("StrongPass123!");
  await page.locator('input[autocomplete="new-password"]').nth(1).fill("StrongPass123!");
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Activate Account" }).click();

  await expect(page.getByRole("status")).toContainText("Your account has been activated");
  expect(activation).toMatchObject({
    token: invitationToken,
    password: "StrongPass123!",
    confirmPassword: "StrongPass123!",
    termsAccepted: true
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
