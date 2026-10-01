import { expect, test, type Page, type Route } from "playwright/test";

const branchId = "507f1f77bcf86cd799439024";
const manifestId = "507f1f77bcf86cd799439021";
const userId = "507f1f77bcf86cd799439023";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockOperationsSession(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "browser-test-token" });
    if (path.endsWith("/auth/me")) {
      return json(route, { success: true, user: { id: userId, name: "Operations Tester", email: "ops@swiftline.test", role: "operations", assignedBranches: [branchId] } });
    }
    if (path.endsWith("/notifications")) return json(route, { success: true, notifications: [], unreadCount: 0 });
    if (path.endsWith("/branches/options")) {
      return json(route, { success: true, branches: [{ id: branchId, name: "Delhi", code: "DEL" }] });
    }
    return json(route, { success: false, message: `No UI-test fixture for ${request.method()} ${path}` }, 404);
  });
}

test("one submission creates the manifest and its linked booked flight using IST times", async ({ page }) => {
  await mockOperationsSession(page);
  let submitted: Record<string, unknown> | null = null;
  await page.route("**/api/v1/operations-manifests/with-flight", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, {
      success: true,
      manifestId,
      manifestNumber: "SLC031",
      flightId: "507f1f77bcf86cd799439028",
      flightLinehaulNumber: "FLH0042",
    }, 201);
  });
  await page.route(`**/api/v1/operations-manifests/${manifestId}`, async (route) => json(route, {
    success: true,
    manifest: {
      id: manifestId,
      manifestNumber: "SLC031",
      branchId,
      branch: { name: "Delhi", code: "DEL" },
      header: {
        destinationAgent: "London Gateway",
        destinationCountryCode: "GB",
        destinationCountryName: "United Kingdom",
        flightNumber: "EY-219",
        departureDate: "2026-09-30",
        mawbNumber: "607-54691055",
        originIataCode: "DEL",
        destinationIataCode: "LHR",
        valueType: "LV",
      },
      status: "DRAFT",
      totalBags: 1,
      totalConsignments: 0,
      totalPhysicalParcels: 0,
      totalWeightKg: 0,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
    },
    bags: [{ id: "507f1f77bcf86cd799439029", bagNumber: "SLC03101", status: "OPEN", totalConsignments: 0, totalPhysicalParcels: 0, totalWeightKg: 0 }],
    consignments: [],
    scans: [],
    latestScan: null,
    sealingIssues: [],
    destinationSummary: [],
    dispatchIssues: [],
  }));

  await page.goto("/dashboard/operations-manifests/new", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Departure Date (India time)")).toHaveCount(0);
  await page.getByLabel("Origin Branch *").selectOption(branchId);
  await page.getByPlaceholder("Type to search country...").fill("United Kingdom");
  await page.getByRole("option", { name: /United Kingdom/ }).click();
  await page.getByLabel("Flight Number *").fill("EY-219");
  await page.getByLabel("MAWB Number *").fill("789-1234-5678");
  await page.getByLabel("Origin IATA *").selectOption("DEL");
  await page.getByLabel("Destination IATA *").selectOption("LHR");
  await page.getByLabel("Airline *").fill("Etihad Airways");
  await page.getByLabel("Scheduled departure (IST) *").fill("2026-09-30T12:00");
  await page.getByLabel("Scheduled arrival (IST) *").fill("2026-09-30T18:00");

  await page.getByRole("button", { name: "Create Manifest & Flight" }).click();
  await expect.poll(() => submitted).not.toBeNull();
  const payload = submitted as unknown as { branchId: string; header: Record<string, unknown>; flight: Record<string, unknown> };
  expect(payload.branchId).toBe(branchId);
  expect(payload.header.flightNumber).toBe("EY-219");
  expect(payload.header.mawbNumber).toBe("789-1234-5678");
  expect(payload.header.departureDate).toBe("2026-09-30");
  expect(payload.flight.scheduledDepartureAt).toBe("2026-09-30T06:30:00.000Z");
  expect(payload.flight.scheduledArrivalAt).toBe("2026-09-30T12:30:00.000Z");
  await expect(page).toHaveURL(new RegExp(`/dashboard/operations-manifests/${manifestId}$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "SLC031", exact: true })).toBeVisible();
});

test("manifest detail corrections require a reason and submit editable header values", async ({ page }) => {
  await mockOperationsSession(page);
  const header = {
    destinationAgent: "London Gateway",
    destinationCountryCode: "GB",
    destinationCountryName: "United Kingdom",
    flightNumber: "EY-219",
    departureDate: "2026-09-30",
    mawbNumber: "607-54691055",
    originIataCode: "DEL",
    destinationIataCode: "LHR",
    valueType: "LV"
  };
  let patchBody: Record<string, unknown> | null = null;
  await page.route(`**/api/v1/operations-manifests/${manifestId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      patchBody = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, { success: true, message: "Manifest details updated." });
    }
    return json(route, {
      success: true,
      manifest: {
        id: manifestId,
        manifestNumber: "SLC031",
        branchId,
        flightLinehaulId: "507f1f77bcf86cd799439028",
        branch: { name: "Delhi", code: "DEL" },
        header,
        status: "DISPATCHED",
        totalBags: 1,
        totalConsignments: 1,
        totalPhysicalParcels: 2,
        totalWeightKg: 8,
        createdAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z"
      },
      bags: [], consignments: [], scans: [], latestScan: null,
      sealingIssues: [], destinationSummary: [], dispatchIssues: []
    });
  });

  await page.goto(`/dashboard/operations-manifests/${manifestId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Edit details" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit manifest details" });
  await dialog.getByLabel("Flight number").fill("AI-313");
  await dialog.getByLabel("MAWB number").fill("789-1234-5678");
  await dialog.getByLabel("Correction reason").fill("Corrected flight documents");
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect.poll(() => patchBody).not.toBeNull();
  const payload = patchBody as unknown as { header: Record<string, unknown>; reason: string };
  expect(payload.header.flightNumber).toBe("AI-313");
  expect(payload.header.mawbNumber).toBe("789-1234-5678");
  expect(payload.reason).toBe("Corrected flight documents");
});

test("flight details can be corrected with an audit reason", async ({ page }) => {
  await mockOperationsSession(page);
  const flightId = "507f1f77bcf86cd799439028";
  const flight = {
    _id: flightId,
    id: flightId,
    flightLinehaulNumber: "FLH0042",
    branchId,
    flightNumber: "EY-219",
    airlineName: "Etihad Airways",
    mawbNumber: "607-54691055",
    originIataCode: "DEL",
    destinationIataCode: "LHR",
    transitIataCode: "",
    scheduledDepartureAt: "2026-09-30T06:30:00.000Z",
    scheduledArrivalAt: "2026-09-30T12:30:00.000Z",
    actualDepartureAt: null,
    actualArrivalAt: null,
    capacityKg: 1000,
    allocatedWeightKg: 0,
    utilisationPercent: 0,
    totalShipments: 0,
    totalBags: 0,
    totalPieces: 0,
    status: "BOOKING_CONFIRMED",
    connection: null,
    customsStatus: "PENDING",
    customsClearedAt: null,
    customsSubmittedAt: null,
    destinationAgent: "London Gateway",
    finalMileCarrier: "DPD UK",
    arrivalAt: null,
    handoverAt: null,
    handoverReference: "",
    branch: { name: "Delhi", code: "DEL" },
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z"
  };
  let patchBody: Record<string, unknown> | null = null;
  await page.route(`**/api/v1/flight-linehauls/${flightId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      patchBody = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, { success: true, message: "Flight updated.", flight });
    }
    return json(route, {
      success: true,
      flight,
      stats: { allocatedWeightKg: 0, utilisationPercent: 0, totalShipments: 0, totalBags: 0, totalPieces: 0, manifestCount: 1 },
      allocations: [], manifests: [], bags: [], consignments: [], offloads: [], exceptions: [], documents: [], auditHistory: []
    });
  });

  await page.goto(`/dashboard/flight-linehauls/${flightId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Edit details" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit flight details" });
  await dialog.getByLabel("Flight number").fill("AI-313");
  await dialog.getByLabel("Airline").fill("Air India");
  await dialog.getByLabel("MAWB number").fill("789-1234-5678");
  await dialog.getByLabel("Correction reason").fill("Carrier booking correction");
  await dialog.getByRole("button", { name: "Save flight details" }).click();
  await expect.poll(() => patchBody).not.toBeNull();
  const payload = patchBody as unknown as { flightNumber: string; airlineName: string; mawbNumber: string; reason: string };
  expect(payload.flightNumber).toBe("AI-313");
  expect(payload.airlineName).toBe("Air India");
  expect(payload.mawbNumber).toBe("789-1234-5678");
  expect(payload.reason).toBe("Carrier booking correction");
});

test("sealed-manifest deletion requires an explicit choice, reason and typed confirmation", async ({ page }) => {
  await mockOperationsSession(page);
  let deleteBody: Record<string, unknown> | null = null;
  let listReads = 0;
  await page.route("**/api/v1/operations-manifests**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/v1/operations-manifests") {
      listReads += 1;
      return json(route, {
        success: true,
        items: listReads === 1 ? [{
          id: manifestId,
          manifestNumber: "SLC018",
          branchId,
          branch: { name: "Delhi", code: "DEL" },
          header: { destinationAgent: "London Gateway", destinationCountryCode: "GB", destinationCountryName: "United Kingdom", flightNumber: "EY-219", departureDate: "2026-09-30", mawbNumber: "607-54691055", originIataCode: "DEL", destinationIataCode: "LHR", valueType: "LV" },
          status: "SEALED",
          totalBags: 1,
          totalConsignments: 1,
          totalPhysicalParcels: 2,
          totalWeightKg: 8,
          createdAt: "2026-09-29T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
        }] : [],
        pagination: { page: 1, limit: 15, total: listReads === 1 ? 1 : 0, pages: 1 },
      });
    }
    if (request.method() === "DELETE" && path === `/api/v1/operations-manifests/${manifestId}`) {
      deleteBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, { success: true, message: "SLC018 archived and removed from active manifests.", deleted: { manifestNumber: "SLC018", status: "SEALED", mode: "ARCHIVE", numberWillBeReused: true, readyMilestonesRemoved: 1, flightLinehaulId: "507f1f77bcf86cd799439028", storageCleanupPending: 0 } });
    }
    return json(route, { success: false, message: `Unhandled UI-test request ${request.method()} ${path}` }, 404);
  });

  await page.goto("/dashboard/operations-manifests", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Delete manifest SLC018" }).click();
  const dialog = page.getByRole("dialog", { name: /Delete sealed manifest SLC018/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Archive & Delete" })).toBeDisabled();
  await dialog.getByLabel("Reason for deletion").fill("Incorrect departure schedule");
  await dialog.getByLabel(/Type SLC018 to confirm/).fill("SLC018");
  await dialog.getByText("Permanently Delete", { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /Permanently Delete/ })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Permanently Delete" })).toBeEnabled();
  await dialog.getByText("Archive & Delete", { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /Archive & Delete/ })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Archive & Delete" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Archive & Delete" }).click();
  await expect.poll(() => deleteBody).not.toBeNull();
  expect(deleteBody).toEqual({ mode: "ARCHIVE", reason: "Incorrect departure schedule", confirmationManifestNumber: "SLC018" });
  await expect(page.getByText("No operations manifests found.")).toBeVisible();
});

test("dispatched manifests keep a disabled delete action with an explanation", async ({ page }) => {
  await mockOperationsSession(page);
  await page.route("**/api/v1/operations-manifests**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/v1/operations-manifests") {
      return json(route, {
        success: true,
        items: [{
          id: manifestId,
          manifestNumber: "SLC019",
          branchId,
          branch: { name: "Delhi", code: "DEL" },
          header: { destinationAgent: "London Gateway", destinationCountryCode: "GB", destinationCountryName: "United Kingdom", flightNumber: "EY-220", departureDate: "2026-09-30", mawbNumber: "607-54691056", originIataCode: "DEL", destinationIataCode: "LHR", valueType: "LV" },
          status: "DISPATCHED",
          totalBags: 1,
          totalConsignments: 1,
          totalPhysicalParcels: 2,
          totalWeightKg: 8,
          createdAt: "2026-09-29T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
        }],
        pagination: { page: 1, limit: 15, total: 1, pages: 1 },
      });
    }
    return json(route, { success: false, message: `Unhandled UI-test request ${request.method()} ${path}` }, 404);
  });

  await page.goto("/dashboard/operations-manifests", { waitUntil: "domcontentloaded" });
  const disabledAction = page.getByLabel("Delete manifest SLC019 unavailable");
  await expect(page.getByRole("button", { name: "Delete manifest SLC019" })).toBeDisabled();
  await expect(disabledAction).toHaveAttribute("aria-disabled", "true");

  await disabledAction.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Dispatched manifests cannot be deleted because their dispatch and shipment tracking history must remain auditable."
  );
  await expect(page.getByRole("tooltip")).toBeVisible();
});
