import { expect, test, type Page, type Route } from "playwright/test";

const slug = "northstar-cargo";
const draftId = "507f1f77bcf86cd799439051";
const trackingNumber = "NSCDEL311026001";

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

async function mockTrackingApi(page: Page, role: "OPERATOR_ADMIN" | "CLIENT", searchTerm: string, apiCalls: string[]) {
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
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-tracking-test-token" });
    if (path === "/api/v1/auth/me") return json(route, { success: true, user: { name: "Asha Mehta", email: "asha@example.test", role: "client" } });
    if (path === `/api/v1/operators/${slug}/me`) return json(route, {
      success: true,
      operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
      membership: { role, assignedBranches: [] },
      access: { mode: "MEMBER", readOnly: false }
    });

    if (path === `/api/v1/operators/${slug}/booked-shipments` && role === "CLIENT") {
      expect(url.searchParams.get("search")).toBe(searchTerm);
      return json(route, {
        success: true,
        shipments: [{
          id: draftId,
          businessAccountId: "507f1f77bcf86cd799439021",
          businessAccountName: "Northstar Parts",
          branchId: "507f1f77bcf86cd799439031",
          branch: { name: "North Hub", code: "NORTH", city: "Delhi" },
          swiftlineTrackingNumber: trackingNumber,
          awbNumbers: [trackingNumber],
          consignee: "Asha Shah",
          destination: "Delhi",
          destinationCountry: "India",
          pieces: 1,
          status: "IN_TRANSIT",
          statusLabel: "In transit",
          createdAt: "2026-10-31T09:00:00.000Z"
        }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 }
      });
    }

    if (path === `/api/v1/operators/${slug}/shipments` && role !== "CLIENT") {
      expect(url.searchParams.get("search")).toBe(searchTerm);
      return json(route, {
        success: true,
        shipments: [{
          businessAccountName: "Northstar Parts",
          draft: {
            _id: draftId,
            businessAccountId: "507f1f77bcf86cd799439021",
            branchId: "507f1f77bcf86cd799439031",
            consigneeEnteredAddress: { companyName: "Asha Shah", contactName: "Asha Shah", townOrCity: "Delhi", countryName: "India", countryCode: "IN" },
            parcelCount: 1,
            createdAt: "2026-10-31T09:00:00.000Z",
            updatedAt: "2026-10-31T09:00:00.000Z"
          },
          shipment: { _id: "507f1f77bcf86cd799439071", swiftlineTrackingNumber: trackingNumber, parcelNumbers: [trackingNumber], status: "LABEL_RECEIVED", createdAt: "2026-10-31T09:00:00.000Z" },
          currentEvent: { status: "IN_TRANSIT", note: "Shipment is moving to the destination hub.", location: "Delhi", eventAt: "2026-10-31T10:00:00.000Z" }
        }],
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }
      });
    }

    if (path === `/api/v1/operators/${slug}/shipments/${draftId}${role === "CLIENT" ? "" : "/details"}`) {
      return json(route, { success: true, shipment: {
        shipmentDraft: {
          id: draftId,
          status: "IN_TRANSIT",
          statusLabel: "In transit",
          serviceType: "COURIER",
          serviceCode: "INTERNAL_COURIER",
          parcelCount: 1,
          parcelList: [{ sequence: 1, weightKg: 2.5, shipmentContentType: "PARCEL", items: [] }],
          consignee: { companyName: "Asha Shah", contactName: "Asha Shah", townOrCity: "Delhi", countryName: "India", countryCode: "IN" },
          createdAt: "2026-10-31T09:00:00.000Z"
        },
        dpdShipment: {
          id: "507f1f77bcf86cd799439071",
          shipmentDraftId: draftId,
          idempotencyKey: "tracking-test-booking",
          dpdShipmentId: "operator-test-booking",
          dpdTransactionId: "operator-test-transaction",
          swiftlineTrackingNumber: trackingNumber,
          parcelNumbers: [trackingNumber],
          serviceCode: "INTERNAL_COURIER",
          paymentSource: "BUSINESS_ACCOUNT",
          status: "LABEL_RECEIVED",
          createdAt: "2026-10-31T09:00:00.000Z"
        },
        currentEvent: { id: "event-current", status: "IN_TRANSIT", statusLabel: "In transit", note: "Shipment is moving to the destination hub.", location: "Delhi Hub", customerVisible: true, eventAt: "2026-10-31T10:00:00.000Z" },
        events: [
          { id: "event-current", status: "IN_TRANSIT", statusLabel: "In transit", note: "Shipment is moving to the destination hub.", location: "Delhi Hub", customerVisible: true, eventAt: "2026-10-31T10:00:00.000Z" },
          { id: "event-booked", status: "SHIPMENT_BOOKED", statusLabel: "Shipment booked", note: "Booking confirmed.", location: "North Hub", customerVisible: true, eventAt: "2026-10-31T09:00:00.000Z" }
        ]
      } });
    }

    return json(route, { success: false, message: `No tracking fixture for ${request.method()} ${path}` }, 404);
  });
}

for (const role of ["OPERATOR_ADMIN", "CLIENT"] as const) {
  for (const searchTerm of [trackingNumber, "Asha Shah"]) {
    const searchKind = searchTerm === trackingNumber ? "AWB" : "sender or recipient name";
    test(`${role === "CLIENT" ? "operator client" : "operator staff"} can track by ${searchKind} only through its operator workspace`, async ({ page }) => {
      const apiCalls: string[] = [];
      await mockTrackingApi(page, role, searchTerm, apiCalls);
      await page.goto(`/portal/${slug}/tracking`);
      await expect(page.getByRole("heading", { name: "Track a shipment" })).toBeVisible();

      await page.getByLabel("AWB, sender or recipient name").fill(searchTerm);
      await page.getByRole("button", { name: "Track shipment" }).click();

      await expect(page.getByRole("heading", { name: trackingNumber })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Tracking history" })).toBeVisible();
      await expect(page.getByText("In transit", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Shipment booked", { exact: true })).toBeVisible();
      await expect(page.getByText("2.50 kg", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "View shipment details" })).toHaveAttribute("href", `/portal/${slug}/shipments/${draftId}`);
      expect(apiCalls.some((call) => call.includes("/api/v1/client/"))).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
