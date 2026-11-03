import { expect, test, type Page, type Route } from "playwright/test";

const operatorSlug = "northstar-cargo";
const draftId = "DRAFT-SUPPORT-1001";
const token = "a".repeat(64);

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

async function mockSupportDraft(page: Page, operatorRequests: Array<{ method: string; token?: string }>, expiresInMs = 15 * 60 * 1000) {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  await page.addInitScript(({ supportToken, grantExpiresAt }) => {
    sessionStorage.setItem("swiftline.operatorSupportSession", JSON.stringify({
      token: supportToken,
      sessionId: "507f1f77bcf86cd799439001",
      tenantId: "507f1f77bcf86cd799439002",
      operatorSlug: "northstar-cargo",
      companyName: "Northstar Cargo",
      reason: "Review a client shipment issue",
      expiresAt: grantExpiresAt
    }));
  }, { supportToken: token, grantExpiresAt: expiresAt });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") {
      const origin = request.headers().origin ?? "http://127.0.0.1:3001";
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "authorization,content-type,x-operator-support-token",
          "access-control-allow-methods": request.headers()["access-control-request-method"] ?? "GET,HEAD,OPTIONS",
          vary: "Origin"
        }
      });
    }
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-support-test-token" });
    if (path.startsWith(`/api/v1/operators/${operatorSlug}/`)) {
      operatorRequests.push({ method: request.method(), token: request.headers()["x-operator-support-token"] });
    }
    if (path === `/api/v1/operators/${operatorSlug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439002", slug: operatorSlug, companyName: "Northstar Cargo" },
        membership: { role: "OPERATOR_ADMIN", assignedBranches: [] },
        access: { mode: "PLATFORM_SUPPORT", readOnly: true, expiresAt }
      });
    }
    if (path === `/api/v1/operators/${operatorSlug}/dpd-labels/drafts/${draftId}`) {
      return json(route, {
        success: true,
        shipmentDraft: {
          _id: draftId,
          creationSource: "MANUAL",
          businessAccountId: "BA-1001",
          branchId: "507f1f77bcf86cd799439003",
          consignorAddress: {
            companyName: "Northstar Textiles",
            contactName: "Mira Shah",
            email: "mira@example.test",
            mobileCountryCode: "+91",
            mobileNumber: "9876543210",
            countryCode: "IN",
            countryName: "India",
            postcode: "110001",
            addressLine1: "1 NORTH ROAD",
            townOrCity: "DELHI"
          },
          consigneeEnteredAddress: {
            companyName: "Harbour Stores",
            contactName: "Asha Rao",
            email: "asha@example.test",
            mobileCountryCode: "+44",
            mobileNumber: "7700900000",
            countryCode: "GB",
            countryName: "United Kingdom",
            postcode: "SW1A 1AA",
            addressLine1: "10 HARBOUR STREET",
            townOrCity: "LONDON"
          },
          parcelList: [{
            sequence: 1,
            weightKg: 4.5,
            lengthCm: 30,
            widthCm: 20,
            heightCm: 15,
            shipmentContentType: "GOODS",
            contentsDescription: "HANDMADE TEXTILES",
            declaredGoodsValueMinor: 1088200,
            items: [{ description: "Cotton scarf", hsnCode: "6214", quantity: 2 }]
          }],
          serviceType: "COURIER",
          serviceCode: "EXPRESS",
          validationIssues: [],
          status: "DRAFT",
          bookingState: "EDITABLE",
          createdAt: "2026-10-24T08:00:00.000Z"
        }
      });
    }
    return json(route, { success: false, message: `No fixture for ${request.method()} ${path}` }, 404);
  });
}

test("Swiftline support can inspect an operator draft without booking or editing controls", async ({ page }) => {
  const operatorRequests: Array<{ method: string; token?: string }> = [];
  await mockSupportDraft(page, operatorRequests);
  await page.goto(`/portal/${operatorSlug}/shipments/drafts/${draftId}`);

  await expect(page.getByText(/Swiftline support access/)).toBeVisible();
  await expect(page.getByText("Read-only shipment draft", { exact: true })).toBeVisible();
  await expect(page.getByText("HANDMADE TEXTILES")).toBeVisible();
  await expect(page.getByText("Northstar Textiles")).toBeVisible();
  await expect(page.getByText(/10,882\.00/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Create Shipment|Save as Draft|Book Shipment/ })).toHaveCount(0);
  await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);

  await expect.poll(() => operatorRequests.length).toBeGreaterThan(0);
  expect(operatorRequests.every((request) => request.method === "GET" && request.token === token)).toBe(true);
});

test("support access clears and returns to the platform registry when it expires", async ({ page }) => {
  const operatorRequests: Array<{ method: string; token?: string }> = [];
  await mockSupportDraft(page, operatorRequests, 4_000);
  await page.goto(`/portal/${operatorSlug}/shipments/drafts/${draftId}`);

  await expect(page.getByText("Read-only shipment draft", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/operators$/, { timeout: 8_000 });
  await expect(page.getByText(/Swiftline support access/)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("swiftline.operatorSupportSession"))).toBeNull();
});
