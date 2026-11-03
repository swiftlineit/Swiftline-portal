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
