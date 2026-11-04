import { expect, test, type Page, type Route } from "playwright/test";

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

async function mockClientDashboard(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/api/v1/auth/refresh") return json(route, { success: true, accessToken: "workspace-entry-test-token" });
    if (path === "/api/v1/auth/me") return json(route, { success: true, user: { name: "Aman Negi", email: "aman@example.test", role: "client" } });
    if (path === "/api/v1/client/dashboard") return json(route, { success: true, accounts: [] });
    if (path === "/api/v1/auth/client-workspaces") return json(route, {
      success: true,
      swiftline: true,
      operators: [
        { slug: "testop", companyName: "JK LOGISTICS", status: "ACTIVE", role: "OPERATOR_ADMIN" },
        { slug: "waiting-cargo", companyName: "Waiting Cargo", status: "DRAFT", role: "FINANCE" }
      ]
    });
    if (path === "/api/v1/auth/operator-workspaces") return json(route, {
      success: true,
      workspaces: [
        { slug: "testop", companyName: "JK LOGISTICS", status: "ACTIVE", role: "OPERATOR_ADMIN" },
        { slug: "waiting-cargo", companyName: "Waiting Cargo", status: "DRAFT", role: "FINANCE" }
      ]
    });
    return json(route, { success: false, message: "Not available in this browser fixture." }, 404);
  });
}

test("a dual-role client can enter each active operator workspace from the client dashboard", async ({ page }) => {
  await mockClientDashboard(page);
  await page.goto("/client/dashboard");

  const workspaces = page.getByRole("region", { name: "Your operator workspaces" });
  await expect(workspaces.getByText("JK LOGISTICS")).toBeVisible();
  await expect(workspaces.getByText("Operator administrator · /portal/testop")).toBeVisible();
  await expect(workspaces.getByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/portal/testop");
  await expect(workspaces.getByText("Waiting Cargo")).toBeVisible();
  await expect(workspaces.getByText("Awaiting activation")).toBeVisible();
  await expect(page.getByText("No business account linked")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("workspace chooser aligns sign out with the heading and displays workspace logos responsively", async ({ page }) => {
  await mockClientDashboard(page);
  await page.route("**/api/v1/operators/testop/settings/logo", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWaoAAAAASUVORK5CYII=", "base64")
  }));

  await page.goto("/workspaces");

  const heading = page.getByRole("heading", { name: "Choose workspace" });
  const signOut = page.getByRole("button", { name: "Sign out" });
  const swiftlineWorkspace = page.getByRole("link", { name: /Swiftline client portal/ });
  const operatorWorkspace = page.getByRole("link", { name: /JK LOGISTICS/ });

  await expect(heading).toBeVisible();
  await expect(signOut).toBeVisible();
  await expect(swiftlineWorkspace.locator("img")).toBeVisible();
  await expect(operatorWorkspace.locator("img")).toHaveAttribute("src", /^blob:/);
  await expect(page.getByText("SWIFTLINE PORTAL", { exact: true })).toHaveCount(0);

  const layout = await page.evaluate(() => {
    const headingElement = document.querySelector("h1");
    const signOutElement = document.querySelector("button");
    if (!headingElement || !signOutElement) return null;
    const headingRect = headingElement.getBoundingClientRect();
    const signOutRect = signOutElement.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      headingRight: headingRect.right,
      signOutLeft: signOutRect.left,
      signOutRight: signOutRect.right
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.documentWidth).toBeLessThanOrEqual(layout?.viewportWidth ?? 0);
  if ((layout?.viewportWidth ?? 0) >= 640) {
    expect(layout?.signOutLeft).toBeGreaterThanOrEqual(layout?.headingRight ?? 0);
  } else {
    expect(layout?.signOutRight).toBeGreaterThan((layout?.viewportWidth ?? 0) / 2);
  }
});

test("an unavailable operator workspace shows a centered maintenance page without the workspace shell", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (path === "/api/v1/auth/refresh") return json(route, { success: true, accessToken: "workspace-entry-test-token" });
    if (path === "/api/v1/operators/jk-logistics/me") {
      return json(route, { success: false, message: "Operator not found." }, 404);
    }
    return json(route, { success: false, message: "Not available in this browser fixture." }, 404);
  });

  await page.goto("/portal/jk-logistics/settings");

  await expect(page.getByRole("heading", { name: "This workspace is unavailable right now" })).toBeVisible();
  await expect(page.getByText("We are taking a short maintenance break. Please try again later.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/?next=%2Fportal%2Fjk-logistics");
  await expect(page.locator("header")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
