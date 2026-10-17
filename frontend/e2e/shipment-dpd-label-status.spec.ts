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

async function mockShipmentListApis(
  page: Page,
  role: "operations" | "client",
  shipmentOverrides?: Record<string, unknown>[]
) {
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
      const shipments = shipmentOverrides ?? (role === "operations"
        ? [shipment("001", "AVAILABLE"), shipment("002", "NOT_AVAILABLE"), shipment("003", "NOT_APPLICABLE")]
        // Include the internal field deliberately: the client component must
        // remain safe even while frontend and backend versions overlap.
        : [shipment("004", "AVAILABLE")]);
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

test("opens the available DPD label PDF while View Details keeps the shipment route", async ({ page }) => {
  await mockShipmentListApis(page, "operations");
  await page.route("http://localhost:5000/api/v1/dpd-shipments/drafts/001/details", (route) => route.fulfill({
    json: {
      success: true,
      shipment: {
        dpdShipment: { id: "booked-001" },
        labels: [{ id: "dpd-label-001", labelType: "DPD" }]
      }
    }
  }));
  await page.route("http://localhost:5000/api/v1/dpd-shipments/booked-001/label-access?**", (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("labelId")).toBe("dpd-label-001");
    expect(url.searchParams.get("disposition")).toBe("inline");
    return route.fulfill({
      json: {
        success: true,
        url: "http://localhost:3000/api/v1/dpd-shipments/booked-001/label-file?token=test-signed&disposition=inline"
      }
    });
  });
  await page.context().route("http://localhost:3000/api/v1/dpd-shipments/booked-001/label-file?**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "DPD label preview"
  }));

  await page.goto("/dashboard/shipments");
  await expect(page.getByRole("link", { name: "View Details" }).first()).toHaveAttribute("href", "/dashboard/shipments/001");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "DPD label available" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("http://localhost:3000/api/v1/dpd-shipments/booked-001/label-file?token=test-signed&disposition=inline");
  await expect(page).toHaveURL(/\/dashboard\/shipments$/);
});

test("never renders internal DPD label status in the client shipment table", async ({ page }) => {
  await mockShipmentListApis(page, "client");
  await page.goto("/client/shipments");

  await expect(page.getByText("SLCDEL090926004", { exact: true })).toBeVisible();
  await expect(page.getByText(/DPD label/i)).toHaveCount(0);
});

test("highlights only staff-relevant manifest memberships while manifest selection is active", async ({ page }) => {
  const staffAccountShipment = {
    ...shipment("STAFF-ACCOUNT", "NOT_APPLICABLE"),
    manifest: { id: "staff-account-manifest", manifestNumber: "STAFF-001" },
    manifestEligible: false,
    combinedManifestEligible: true,
    manifestMembership: {
      hasAny: true,
      account: [{ id: "staff-account-manifest", manifestNumber: "STAFF-001", actorRole: "admin" }],
      combined: []
    }
  };
  const clientAccountShipment = {
    ...shipment("CLIENT-ACCOUNT", "NOT_APPLICABLE"),
    manifest: null,
    manifestEligible: true,
    combinedManifestEligible: true,
    manifestMembership: {
      hasAny: true,
      account: [{ id: "client-account-manifest", manifestNumber: "CLIENT-001", actorRole: "client" }],
      combined: []
    }
  };
  await mockShipmentListApis(page, "operations", [staffAccountShipment, clientAccountShipment]);
  await page.goto("/dashboard/shipments");

  const staffCheckbox = page.getByRole("checkbox", { name: "Select shipment SLCDEL090926STAFF-ACCOUNT" });
  const clientCheckbox = page.getByRole("checkbox", { name: "Select shipment SLCDEL090926CLIENT-ACCOUNT" });
  await expect(staffCheckbox).not.toHaveClass(/ring-/);
  await expect(clientCheckbox).not.toHaveClass(/ring-/);

  await page.getByRole("button", { name: "Create Manifest", exact: true }).first().click();
  await expect(staffCheckbox).toHaveClass(/ring-amber-400/);
  await expect(staffCheckbox).toHaveClass(/rounded-sm/);
  await expect(clientCheckbox).not.toHaveClass(/ring-/);
  await staffCheckbox.check();
  await clientCheckbox.check();
  await expect(page.getByText(
    "1 selected shipment already has a manifest; only eligible shipments will be added.",
    { exact: true }
  )).toBeVisible();
});

test("client manifest status and checkbox highlight only reflect that client's account manifest", async ({ page }) => {
  const staffCombinedShipment = {
    ...shipment("STAFF-COMBINED", "NOT_APPLICABLE"),
    manifest: null,
    manifestEligible: true,
    manifestMembership: { hasAny: false, account: [], combined: [] }
  };
  const clientAccountShipment = {
    ...shipment("CLIENT-ACCOUNT", "NOT_APPLICABLE"),
    manifest: { id: "client-account-manifest", manifestNumber: "CLIENT-002" },
    manifestEligible: false,
    manifestMembership: {
      hasAny: true,
      account: [{ id: "client-account-manifest", manifestNumber: "CLIENT-002", actorRole: "client" }],
      combined: []
    }
  };
  await mockShipmentListApis(page, "client", [staffCombinedShipment, clientAccountShipment]);
  await page.goto("/client/shipments");

  const staffCombinedCheckbox = page.getByRole("checkbox", { name: "Select shipment SLCDEL090926STAFF-COMBINED" });
  const clientManifestCheckbox = page.getByRole("checkbox", { name: "Select shipment SLCDEL090926CLIENT-ACCOUNT" });
  await expect(staffCombinedCheckbox).toBeEnabled();
  await expect(staffCombinedCheckbox).not.toHaveClass(/ring-/);
  await expect(page.getByText("Already in a manifest", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Manifest: CLIENT-002", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Create Manifest", exact: true }).first().click();
  await expect(staffCombinedCheckbox).not.toHaveClass(/ring-/);
  await expect(clientManifestCheckbox).toHaveClass(/ring-red-400/);
  await expect(clientManifestCheckbox).toBeDisabled();
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
