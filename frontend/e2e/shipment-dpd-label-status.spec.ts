import { expect, test, type Page } from "playwright/test";

type DpdLabelStatus = "AVAILABLE" | "NOT_AVAILABLE" | "NOT_APPLICABLE";

function shipment(id: string, dpdLabelStatus: DpdLabelStatus) {
  return {
    id,
    creationSource: "MANUAL",
    businessAccountId: "account-1",
    businessAccountName: "Example Exporters",
    businessAccountCode: "BA-001",
    branchId: "branch-1",
    branch: { name: "Delhi", code: "DEL", city: "Delhi" },
    shipmentReference: `REF-${id}`,
    invoiceNumber: "",
    swiftlineTrackingNumber: `SLCDEL090926${id}`,
    awbNumbers: [`SLCDEL090926${id}-01`],
    forwardingNumbers: [],
    consignor: "Example Exporters",
    consignee: "Example Receiver",
    destination: "London, United Kingdom",
    destinationCountry: "United Kingdom",
    product: "Documents",
    serviceInfo: "COURIER",
    route: "Delhi to London",
    shipmentInvoice: null,
    pieces: 1,
    weightKg: 1,
    status: "SHIPMENT_BOOKED",
    statusLabel: "Shipment booked",
    lastScan: null,
    deliveryEstimate: null,
    bookingStatus: "LABEL_RECEIVED",
    bookingStatusLabel: "Label received",
    manifest: null,
    manifestEligible: false,
    dpdLabelStatus,
    createdAt: "2026-09-09T08:00:00.000Z",
    updatedAt: "2026-09-09T08:00:00.000Z"
  };
}

async function mockShipmentListApis(page: Page, role: "operations" | "client") {
  await page.route("http://localhost:5000/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/auth/refresh")) {
      return route.fulfill({ json: { success: true, accessToken: "test-token" } });
    }
    if (path.endsWith("/auth/me")) {
      return route.fulfill({
        json: {
          success: true,
          user: { id: "user-1", name: "Test User", email: "test@swiftline.test", role }
        }
      });
    }
    if (path.endsWith("/notifications")) {
      return route.fulfill({ json: { success: true, notifications: [], unreadCount: 0 } });
    }
    if (path.endsWith("/client/dashboard")) {
      return route.fulfill({ json: { success: true, accounts: [] } });
    }
    if (path.endsWith("/client/rate-card-shares")) {
      return route.fulfill({ json: { success: true, shares: [], unreadCount: 0 } });
    }
    if (path.endsWith("/service-disruptions") || path.endsWith("/client/service-disruptions")) {
      return route.fulfill({ json: { success: true, disruptions: [] } });
    }
    if (path.endsWith("/regulatory-updates") || path.endsWith("/client/regulatory-updates")) {
      return route.fulfill({ json: { success: true, updates: [] } });
    }
    if (path.endsWith("/business-accounts")) {
      return route.fulfill({
        json: {
          success: true,
          accounts: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 1 }
        }
      });
    }
    if (path.endsWith("/shipments/operations-manifests/options")) {
      return route.fulfill({ json: { success: true, manifests: [] } });
    }
    if (path.endsWith("/shipments") || path.endsWith("/client/booked-shipments")) {
      const shipments = role === "operations"
        ? [shipment("001", "AVAILABLE"), shipment("002", "NOT_AVAILABLE"), shipment("003", "NOT_APPLICABLE")]
        // Include the internal field deliberately: the client component must
        // remain safe even while frontend and backend versions overlap.
        : [shipment("004", "AVAILABLE")];
      return route.fulfill({
        json: {
          success: true,
          shipments,
          pagination: { page: 1, limit: 20, total: shipments.length, totalPages: 1 }
        }
      });
    }

    return route.fulfill({ json: { success: true } });
  });
}

test("shows route-aware DPD label status in the staff shipment table", async ({ page }) => {
  await mockShipmentListApis(page, "operations");
  await page.goto("/dashboard/shipments");

  await expect(page.getByText("DPD label available", { exact: true })).toBeVisible();
  await expect(page.getByText("DPD label not available", { exact: true })).toBeVisible();
  await expect(page.getByText("DPD label not applicable", { exact: true })).toBeVisible();
});

test("never renders internal DPD label status in the client shipment table", async ({ page }) => {
  await mockShipmentListApis(page, "client");
  await page.goto("/client/shipments");

  await expect(page.getByText("SLCDEL090926004", { exact: true })).toBeVisible();
  await expect(page.getByText(/DPD label/i)).toHaveCount(0);
});

test("keeps the latest shipment query when a delayed page response arrives", async ({ page }) => {
  await mockShipmentListApis(page, "operations");
  let releasePageTwo!: () => void;
  const pageTwoResponse = new Promise<void>((resolve) => { releasePageTwo = resolve; });

  await page.route("http://localhost:5000/api/v1/shipments**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/shipments/operations-manifests/options")) {
      return route.fallback();
    }

    const requestedPage = url.searchParams.get("page") ?? "1";
    const filtered = url.searchParams.get("status") === "SHIPMENT_BOOKED";

    if (requestedPage === "2" && !filtered) {
      await pageTwoResponse;
      return route.fulfill({
        json: {
          success: true,
          shipments: [shipment("PAGE-TWO", "AVAILABLE")],
          pagination: { page: 2, limit: 20, total: 80, totalPages: 4 }
        }
      });
    }

    return route.fulfill({
      json: {
        success: true,
        shipments: [shipment(filtered ? "FILTERED" : "PAGE-ONE", "AVAILABLE")],
        pagination: { page: 1, limit: 20, total: 80, totalPages: 4 }
      }
    });
  });

  await page.goto("/dashboard/shipments");
  await expect(page.getByText("SLCDEL090926PAGE-ONE", { exact: true })).toBeVisible();

  const next = page.getByRole("button", { name: "Next", exact: true });
  await next.click();
  await expect(next).toBeDisabled();

  await page.locator("label").filter({ hasText: "Status" }).locator("select").selectOption("SHIPMENT_BOOKED");
  await expect(page.getByText("SLCDEL090926FILTERED", { exact: true })).toBeVisible();

  releasePageTwo();
  await expect(page.getByText("SLCDEL090926PAGE-TWO", { exact: true })).toHaveCount(0);
  await expect(page.getByText("SLCDEL090926FILTERED", { exact: true })).toBeVisible();
});
