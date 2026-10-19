import { expect, test, type Route } from "playwright/test";

const manifestId = "507f1f77bcf86cd799439021";
const branchId = "507f1f77bcf86cd799439024";
const bag1 = "507f1f77bcf86cd799439025";
const bag2 = "507f1f77bcf86cd799439026";
const parcel1 = "SLC031-01";
const parcel2 = "SLC031-02";
const parcel3 = "SLC031-03";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function manifestDetail(status: "PACKING" | "READY_TO_SEAL" | "DISPATCHED") {
  return {
    success: true,
    manifest: {
      id: manifestId, manifestNumber: "SLC031", branchId, branch: { name: "Delhi", code: "DEL" },
      header: { originIataCode: "DEL", destinationIataCode: "LHR", destinationCountryCode: "GB" },
      status, totalBags: 2, totalConsignments: 1, totalPhysicalParcels: 2, totalWeightKg: 15,
    },
    bags: [
      { id: bag1, sequence: 1, bagNumber: "SLC03101", status: status === "PACKING" ? "OPEN" : "CLOSED", totalConsignments: 1, totalPhysicalParcels: 1, totalWeightKg: 5 },
      { id: bag2, sequence: 2, bagNumber: "SLC03102", status: status === "PACKING" ? "OPEN" : "CLOSED", totalConsignments: 1, totalPhysicalParcels: 1, totalWeightKg: 10 },
    ],
    consignments: [{
      id: "consignment-1", shipmentDraftId: "draft-1", dpdShipmentId: "dpd-1", bagId: bag1,
      bagIds: [bag1, bag2], bagNumbers: ["SLC03101", "SLC03102"], consignmentNumber: "SLC031", displayConsignmentNumber: "SLC031",
      expectedParcelNumbers: [parcel1, parcel2, parcel3], scannedParcelNumbers: [parcel1, parcel2],
      activeParcelScans: [{ parcelNumber: parcel1, scanId: "scan-1", bagId: bag1 }, { parcelNumber: parcel2, scanId: "scan-2", bagId: bag2 }],
      parcelWeightSnapshots: [
        { parcelNumber: parcel1, weightKg: 5, contentsDescription: "Blue shirt", items: [{ description: "Handwoven scarf" }], valueMinor: 10000 },
        { parcelNumber: parcel2, weightKg: 10, contentsDescription: "Shoes", items: [{ description: "Leather shoes" }], valueMinor: 20000 },
        { parcelNumber: parcel3, weightKg: 4, contentsDescription: "Book", items: [{ description: "Book" }], valueMinor: 3000 },
      ],
      parcelValues: [{ parcelNumber: parcel1, valueMinor: 10000 }, { parcelNumber: parcel2, valueMinor: 20000 }],
      parcelDispositions: [{ parcelNumber: parcel3, disposition: "HELD", reason: "Not at facility" }],
      consigneeSnapshot: { name: "Asha Patel", formatted: "Asha Patel\nLondon" },
      consignorSnapshot: { formatted: "Swiftline" }, description: "Clothes, shoes, book", weightKg: 15,
      serviceInfo: "EXP", dpdStatus: "LABEL_RECEIVED", carrierReconciliationRequired: false,
    }],
    scans: [], latestScan: null, sealingIssues: [], destinationSummary: [], dispatchIssues: [],
  };
}

test("dispatched manifest shows true bag contents and read-only repeat lookup", async ({ page }) => {
  let lookups = 0;
  let writes = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/operations-manifests/") && route.request().method() !== "GET") writes += 1;
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "test-token" });
    if (path.endsWith("/auth/me")) return json(route, { success: true, user: { id: "user-1", role: "operations", email: "ops@swiftline.test", assignedBranches: [branchId] } });
    if (path.endsWith("/notifications")) return json(route, { success: true, notifications: [], unreadCount: 0 });
    if (path === `/api/v1/operations-manifests/${manifestId}`) return json(route, manifestDetail("DISPATCHED"));
    if (path.endsWith("/scan-details")) return json(route, { success: true, manifest: manifestDetail("DISPATCHED").manifest });
    if (path.endsWith(`/parcels/${parcel1}/details`)) {
      lookups += 1;
      return json(route, { success: true, parcel: {
        parcelNumber: parcel1, packed: true, scannedAt: "2026-10-19T00:00:00.000Z", disposition: null, dispositionReason: "",
        weightKg: 5, valueMinor: 10000, contentsDescription: "Handwoven scarf", items: [{ description: "Handwoven scarf" }],
        consignmentNumber: "SLC031", serviceInfo: "EXP", consignee: { name: "Asha Patel", formatted: "Asha Patel\nLondon" },
        manifest: { id: manifestId, manifestNumber: "SLC031", status: "DISPATCHED" }, bag: { bagNumber: "SLC03101", status: "CLOSED" }, otherShipmentBags: ["SLC03102"],
      } });
    }
    return json(route, { success: false, message: `Unmocked ${path}` }, 404);
  });
  await page.goto(`/dashboard/operations-manifests/${manifestId}`);
  await expect(page.getByRole("heading", { name: "Bag contents" })).toBeVisible();
  const bag1Rows = page.locator("table").first().locator("tbody").filter({ hasText: "SLC03101" });
  await expect(bag1Rows).toContainText(parcel1);
  await expect(bag1Rows).not.toContainText(parcel2);
  await expect(bag1Rows).toContainText(`${parcel3} (Held`);
  await page.getByRole("searchbox", { name: "Search bag contents" }).fill("Handwoven scarf");
  await expect(page.locator("table").first().locator("tbody")).toHaveCount(1);
  await page.getByRole("link", { name: "Scan Details" }).click();
  await expect(page).toHaveURL(new RegExp(`/manifest-scanner/details/${manifestId}`));
  await page.getByRole("textbox", { name: "Parcel number" }).fill(parcel1);
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByRole("region", { name: "Parcel details" })).toContainText("Bag SLC03101");
  await page.getByRole("textbox", { name: "Parcel number" }).fill(parcel1);
  await page.getByRole("button", { name: "Find" }).click();
  await expect.poll(() => lookups).toBe(2);
  expect(writes).toBe(0);
});

test("packing bag shows only its own scanned parcels and outstanding parcel information", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "test-token" });
    if (path.endsWith("/auth/me")) return json(route, { success: true, user: { id: "user-1", role: "operations", email: "ops@swiftline.test", assignedBranches: [branchId] } });
    if (path.endsWith("/notifications")) return json(route, { success: true, notifications: [], unreadCount: 0 });
    if (path.endsWith("/scan-sessions/active")) return json(route, { success: true, session: null });
    if (path === `/api/v1/operations-manifests/${manifestId}`) return json(route, manifestDetail("PACKING"));
    return json(route, { success: false, message: `Unmocked ${path}` }, 404);
  });
  await page.goto(`/dashboard/operations-manifests/${manifestId}`);
  await page.getByRole("button", { name: /SLC03101/ }).click();
  const table = page.getByRole("table");
  await expect(table).toContainText(parcel1);
  await expect(table).not.toContainText(parcel2);
  await expect(table).not.toContainText("Leather shoes");
  await expect(table).toContainText(`${parcel3}`);
  await expect(table).toContainText("Held");
  await page.getByRole("button", { name: /SLC03102/ }).click();
  await expect(table).toContainText(parcel2);
  await expect(table).not.toContainText(parcel1);
});

test("close all and open all each use one bag action", async ({ page }) => {
  let status: "PACKING" | "READY_TO_SEAL" = "PACKING";
  let closeCalls = 0;
  let reopenCalls = 0;
  let individualReopens = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "test-token" });
    if (path.endsWith("/auth/me")) return json(route, { success: true, user: { id: "user-1", role: "operations", email: "ops@swiftline.test", assignedBranches: [branchId] } });
    if (path.endsWith("/notifications")) return json(route, { success: true, notifications: [], unreadCount: 0 });
    if (path.endsWith("/scan-sessions/active")) return json(route, { success: true, session: null });
    if (path.endsWith("/bags/close-all")) {
      closeCalls += 1; status = "READY_TO_SEAL";
      return json(route, { success: true, result: { closed: 2, bagNumbers: ["SLC03101", "SLC03102"] } });
    }
    if (path.endsWith("/bags/reopen-all")) {
      reopenCalls += 1; status = "PACKING";
      return json(route, { success: true, result: { reopened: 2, bagNumbers: ["SLC03101", "SLC03102"] } });
    }
    if (path.endsWith("/reopen")) individualReopens += 1;
    if (path === `/api/v1/operations-manifests/${manifestId}`) return json(route, manifestDetail(status));
    return json(route, { success: false, message: `Unmocked ${path}` }, 404);
  });
  await page.goto(`/dashboard/operations-manifests/${manifestId}`);
  await page.getByRole("button", { name: "Close All" }).click();
  await expect.poll(() => closeCalls).toBe(1);
  await expect(page.getByText("READY TO SEAL", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open All" }).click();
  await expect.poll(() => reopenCalls).toBe(1);
  await expect(page.getByText("PACKING", { exact: true })).toBeVisible();
  expect(individualReopens).toBe(0);
});
