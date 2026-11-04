import { expect, test, type Page, type Route } from "playwright/test";

const slug = "northstar-cargo";
const accountId = "507f1f77bcf86cd799439021";
const branchId = "507f1f77bcf86cd799439031";
const draftId = "507f1f77bcf86cd799439051";

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

function captureBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function expectOperatorBookingColumnsToFitViewport(page: Page) {
  const layout = await page.evaluate(() => {
    const fields = document.querySelector<HTMLElement>('[data-testid="operator-booking-fields"]');
    const summary = document.querySelector<HTMLElement>('[data-testid="operator-booking-summary"]');
    if (!fields || !summary) return null;
    return {
      desktop: window.innerWidth >= 1280,
      fieldsHeight: fields.getBoundingClientRect().height,
      summaryHeight: summary.getBoundingClientRect().height,
      fieldsOverflow: getComputedStyle(fields).overflowY,
      summaryOverflow: getComputedStyle(summary).overflowY,
      fieldsScrollbarWidth: getComputedStyle(fields).scrollbarWidth,
      summaryScrollbarWidth: getComputedStyle(summary).scrollbarWidth,
      fieldsHasMoreContent: fields.scrollHeight > fields.clientHeight,
      expectedColumnHeight: Math.min(900, Math.max(520, window.innerHeight * 0.78))
    };
  });
  expect(layout).not.toBeNull();
  if (!layout?.desktop) return;
  expect(Math.abs(layout.fieldsHeight - layout.summaryHeight)).toBeLessThanOrEqual(1);
  expect(layout.fieldsOverflow).toBe("auto");
  expect(layout.summaryOverflow).toBe("auto");
  expect(layout.fieldsScrollbarWidth).toBe("thin");
  expect(layout.summaryScrollbarWidth).toBe("thin");
  expect(layout.fieldsHasMoreContent).toBe(true);
  expect(Math.abs(layout.fieldsHeight - layout.expectedColumnHeight)).toBeLessThanOrEqual(1);
}

async function expectWithBrowserDiagnostics(page: Page, errors: string[], assertion: () => Promise<void>) {
  try {
    await assertion();
  } catch (cause) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${message}\nBrowser errors: ${errors.join("\n") || "none"}\nVisible page: ${bodyText.slice(0, 1200)}`);
  }
}

async function mockOperatorShipmentApi(
  page: Page,
  role: "OPERATOR_ADMIN" | "CLIENT",
  capturedDrafts: Array<Record<string, unknown>>,
  capturedManifests: Array<{ path: string; body: Record<string, unknown> }> = [],
  capturedShipmentQueries: Array<{ path: string; query: Record<string, string> }> = [],
  detailStatus: "DELIVERED" | "IN_TRANSIT" = "DELIVERED"
) {
  const draftFixture = {
    _id: draftId,
    creationSource: "MANUAL",
    businessAccountId: accountId,
    branchId,
    consigneeEnteredAddress: { companyName: "", contactName: "", addressLine1: "", addressLine2: "", townOrCity: "", county: "", postcode: "", countryCode: "", countryName: "" },
    parcelList: [{ sequence: 1, weightKg: 0, shipmentContentType: "PARCEL", contentsDescription: "", shipmentReference1: "", shipmentReference2: "", items: [] }],
    serviceType: "COURIER",
    serviceCode: "",
    addressValidationStatus: "NOT_VALIDATED",
    status: "NEEDS_REVIEW",
    bookingState: "EDITABLE",
    validationIssues: [],
    createdAt: "2026-10-23T08:00:00.000Z",
    updatedAt: "2026-10-23T08:00:00.000Z"
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-shipment-test-token" });
    if (path === `/api/v1/operators/${slug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
        membership: { role, assignedBranches: role === "CLIENT" ? [] : [branchId] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }
    if (path === `/api/v1/operators/${slug}/business-accounts`) {
      return json(route, {
        success: true,
        accounts: [{
          _id: accountId,
          accountId: "BA-2026-123456",
          accountKind: "BUSINESS",
          status: "active",
          contact: { firstName: "Asha", lastName: "Mehta", email: "asha@example.test" },
          company: { companyName: "Northstar Parts" },
          assignedBranch: { _id: branchId, name: "North Hub", code: "NORTH", status: "ACTIVE" },
          createdAt: "2026-10-22T08:00:00.000Z",
          updatedAt: "2026-10-22T08:00:00.000Z"
        }],
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${slug}/branches`) {
      return json(route, {
        success: true,
        branches: [{
          _id: branchId,
          name: "North Hub",
          code: "NORTH",
          address: { countryCode: "IN", countryName: "India", city: "Delhi" },
          status: "ACTIVE"
        }],
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/amendments` && request.method() === "GET") {
      return json(route, { success: true, canRequest: false, eligibilityMessage: "No amendment is available for this test shipment.", amendments: [] });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/cancellation` && request.method() === "GET") {
      return json(route, { success: true, canRequest: false, eligibilityMessage: "No cancellation is available for this test shipment.", cancellation: null });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}${role === "CLIENT" ? "" : "/details"}` && request.method() === "GET") {
      const detailEvents = detailStatus === "DELIVERED"
        ? [
          { id: "507f1f77bcf86cd799439072", shipmentDraftId: draftId, status: "DELIVERED", statusLabel: "Delivered", note: "Delivered to recipient", location: "Delhi", customerVisible: true, eventAt: "2026-10-24T08:00:00.000Z" },
          { id: "507f1f77bcf86cd799439073", shipmentDraftId: draftId, status: "OUT_FOR_DELIVERY", note: "The courier is completing the final delivery route.", location: "Delhi", customerVisible: true, eventAt: "2026-10-23T08:00:00.000Z" },
          { id: "507f1f77bcf86cd799439074", shipmentDraftId: draftId, status: "DESTINATION_ARRIVED", note: "Shipment reached the destination hub.", location: "Delhi Hub", customerVisible: true, eventAt: "2026-10-22T08:00:00.000Z" },
          { id: "507f1f77bcf86cd799439075", shipmentDraftId: draftId, status: "PARCEL_COLLECTED", note: "Parcel collected from the consignor.", location: "Mumbai", customerVisible: true, eventAt: "2026-10-21T08:00:00.000Z" }
        ]
        : [
          { id: "507f1f77bcf86cd799439072", shipmentDraftId: draftId, status: "IN_TRANSIT", statusLabel: "In transit", note: "Shipment is moving to the destination hub.", location: "Delhi", customerVisible: true, eventAt: "2026-10-24T08:00:00.000Z" },
          { id: "507f1f77bcf86cd799439073", shipmentDraftId: draftId, status: "PARCEL_COLLECTED", note: "Parcel collected from the consignor.", location: "Mumbai", customerVisible: true, eventAt: "2026-10-23T08:00:00.000Z" },
          { id: "507f1f77bcf86cd799439074", shipmentDraftId: draftId, status: "SHIPMENT_BOOKED", note: "Shipment booking confirmed.", location: "Mumbai", customerVisible: true, eventAt: "2026-10-22T08:00:00.000Z" }
        ];
      return json(route, { success: true, shipment: {
        shipmentDraft: {
          id: draftId,
          status: detailStatus,
          statusLabel: detailStatus === "DELIVERED" ? "Delivered" : "In transit",
          addressValidationStatus: "VALIDATED",
          serviceType: "COURIER",
          serviceCode: "INTERNAL_COURIER",
          parcelCount: 1,
          parcelList: [{
            sequence: 1,
            weightKg: 2.5,
            shipmentContentType: "MERCHANDISE",
            contentsDescription: "Cotton shirts",
            items: [{ description: "Cotton shirt", hsnCode: "6109", quantity: 2, unitRate: 450 }]
          }],
          consignee: { companyName: "Asha Shah", contactName: "Asha Shah", email: "asha@example.test", countryCode: "IN", countryName: "India", postcode: "110001", addressLine1: "1 Market Road", townOrCity: "Delhi" },
          consignor: { companyName: "Northstar Parts", contactName: "Northstar Dispatch", email: "dispatch@example.test", countryCode: "IN", countryName: "India", postcode: "400001", addressLine1: "2 Export Lane", townOrCity: "Mumbai" },
          createdAt: "2026-10-23T08:00:00.000Z",
          updatedAt: "2026-10-23T08:00:00.000Z"
        },
        dpdShipment: {
          id: "507f1f77bcf86cd799439071",
          shipmentDraftId: draftId,
          idempotencyKey: "detail-test-booking",
          dpdShipmentId: "operator-test-booking",
          dpdTransactionId: "operator-test-transaction",
          swiftlineTrackingNumber: "NORTHSTAR0001",
          parcelNumbers: ["NORTHSTAR-PARCEL-001"],
          serviceCode: "INTERNAL_COURIER",
          paymentSource: "BUSINESS_ACCOUNT",
          status: "LABEL_RECEIVED",
          createdAt: "2026-10-23T08:00:00.000Z",
          updatedAt: "2026-10-23T08:00:00.000Z"
        },
        bookingConfirmation: null,
        taxInvoiceNumber: "NS/26-27/0001",
        labels: [],
        currentEvent: detailEvents[0],
        events: detailEvents,
        shipmentInvoice: { invoiceNumber: "NS/26-27/0001", currency: "INR", totalAmountMinor: 123456, status: "ISSUED", revision: 1 },
        branch: { name: "North Hub", code: "NORTH" }
      } });
    }
    if (path === `/api/v1/operators/${slug}/manifests` && request.method() === "GET") {
      return json(route, { success: true, manifests: [], pagination: { page: 1, limit: 15, total: 0, totalPages: 1 } });
    }
    if (path === `/api/v1/operators/${slug}/manifests/bulk` || path === `/api/v1/operators/${slug}/manifests/combined`) {
      capturedManifests.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      return json(route, { success: true, manifest: {
        id: "507f1f77bcf86cd799439061",
        manifestNumber: "NORTH-0001",
        manifestType: path.endsWith("/combined") ? "COMBINED" : "ACCOUNT",
        businessAccountId: accountId,
        businessAccountIds: [accountId],
        branchId,
        shipmentDraftIds: [draftId],
        destinationAgent: "",
        flightNumber: "",
        departureDate: "",
        mawbNumber: "",
        originIataCode: "",
        destinationIataCode: "",
        businessAccountName: "Northstar Parts",
        origin: "North Hub",
        destination: "UK Hub",
        coloader: "",
        paymentType: "",
        totalPieces: 1,
        totalWeightKg: 1,
        totalBags: 0,
        shipmentCount: 1,
        actorRole: role === "CLIENT" ? "client" : "admin",
        generatedAt: "2026-10-23T08:00:00.000Z"
      } }, 201);
    }
    if (path === `/api/v1/operators/${slug}/booked-shipments`) {
      capturedShipmentQueries.push({ path, query: Object.fromEntries(new URL(request.url()).searchParams.entries()) });
      return json(route, {
        success: true,
        shipments: [{
          id: draftId,
          creationSource: "MANUAL",
          businessAccountId: accountId,
          businessAccountName: "Northstar Parts",
          businessAccountCode: "BA-2026-123456",
          branchId,
          branch: { name: "North Hub", code: "NORTH", city: "Delhi" },
          shipmentReference: "NS-PO-27",
          invoiceNumber: "NS/26-27/0001",
          swiftlineTrackingNumber: "OABC123NORTH261000001",
          awbNumbers: ["NORTH-PARCEL-001", "NORTH-PARCEL-002"],
          forwardingNumbers: [],
          consignor: "Northstar Parts",
          consignee: "Asha Shah",
          destination: "Asha Shah, Mumbai, India",
          destinationCountry: "India",
          product: "Operator Courier",
          serviceInfo: "Operator Courier",
          route: "Delhi to Mumbai",
          shipmentInvoice: { invoiceNumber: "JK/26-27/0001", currency: "INR", totalAmountMinor: 123456, chargeableAmountMinor: 123456, status: "ISSUED", revision: 1 },
          pieces: 2,
          parcelWeightsKg: [1.25, 2.5],
          weightKg: 3.75,
          status: "PARCEL_COLLECTED",
          statusLabel: "Parcel Collected",
          lastScan: null,
          deliveryEstimate: null,
          bookingStatus: "LABEL_RECEIVED",
          bookingStatusLabel: "Booked",
          manifest: null,
          manifestEligible: true,
          createdAt: "2026-10-23T08:00:00.000Z",
          updatedAt: "2026-10-23T08:00:00.000Z"
        }],
        pagination: { page: 1, limit: 30, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${slug}/shipments` && request.method() === "GET") {
      capturedShipmentQueries.push({ path, query: Object.fromEntries(new URL(request.url()).searchParams.entries()) });
      if (role === "OPERATOR_ADMIN") {
        return json(route, {
          success: true,
          shipments: [{
            draft: {
              _id: draftId,
              businessAccountId: accountId,
              branchId,
              consigneeEnteredAddress: { companyName: "Asha Shah", contactName: "Asha Shah", townOrCity: "Mumbai", postcode: "400001", countryName: "India", countryCode: "IN" },
              parcelCount: 1,
              parcelList: [{ shipmentReference1: "NS-PO-27", weightKg: 1 }],
              updatedAt: "2026-10-23T08:00:00.000Z",
              createdAt: "2026-10-23T08:00:00.000Z"
            },
            businessAccountName: "Northstar Parts",
            shipment: { swiftlineTrackingNumber: "OABC123NORTH261000001", parcelNumbers: ["NORTH-PARCEL-001", "NORTH-PARCEL-002"], status: "LABEL_RECEIVED", createdAt: "2026-10-23T08:00:00.000Z" },
            taxInvoice: { invoiceNumber: "JK/26-27/0001", currency: "INR", totalAmountMinor: 123456, status: "ISSUED", paymentStatus: "PAID" },
            currentEvent: null,
            manifestEligible: true,
            combinedManifestEligible: true
          }],
          pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 }
        });
      }
      return json(route, {
        success: true,
        shipments: [{
          id: draftId,
          branchId,
          invoiceNumber: "",
          shipmentReference: "NS-PO-27",
          swiftlineTrackingNumber: "",
          destination: { companyName: "Asha Shah", contactName: "Asha Shah", townOrCity: "Mumbai", postcode: "400001", countryName: "India", countryCode: "IN" },
          branch: { name: "North Hub", code: "NORTH", city: "Delhi" },
          status: "NEEDS_REVIEW",
          statusLabel: "Draft",
          dpdStatus: "",
          bookingState: "EDITABLE",
          canDelete: true,
          shipmentInvoice: null,
          parcelCount: 1,
          parcelWeightsKg: [1.25],
          createdAt: "2026-10-23T08:00:00.000Z",
          updatedAt: "2026-10-23T08:00:00.000Z"
        }],
        pagination: { page: 1, limit: 30, total: 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${slug}/dpd-labels/drafts/manual` && request.method() === "POST") {
      capturedDrafts.push(request.postDataJSON() as Record<string, unknown>);
      return json(route, { success: true, shipmentDraft: { _id: draftId } }, 201);
    }
    if (path === `/api/v1/operators/${slug}/dpd-labels/drafts/${draftId}` && request.method() === "GET") {
      return json(route, { success: true, shipmentDraft: draftFixture });
    }
    if (path === `/api/v1/operators/${slug}/dpd-labels/drafts/${draftId}` && request.method() === "PATCH") {
      return json(route, { success: true, shipmentDraft: draftFixture });
    }
    if (path === `/api/v1/operators/${slug}/dpd-labels/drafts/${draftId}/rate-card-context`) {
      return json(route, { success: true, title: "Northstar Rate Card", rateCardAssigned: true, rates: [], routeCharges: [] });
    }
    if (path === `/api/v1/operators/${slug}/dpd-labels/drafts/${draftId}/cost-estimate`) {
      return json(route, { success: false, code: "RATE_CARD_REQUIRED", message: "Rate estimate unavailable in this browser test." }, 409);
    }
    return json(route, { success: false, message: `No shipment test fixture for ${request.method()} ${path}` }, 404);
  });
}

test("operator shipment workspace lists booked and draft records without horizontal overflow", async ({ page }) => {
  const capturedQueries: Array<{ path: string; query: Record<string, string> }> = [];
  await mockOperatorShipmentApi(page, "CLIENT", [], [], capturedQueries);
  await page.goto(`/portal/${slug}/shipments`);
  await expect.poll(() => capturedQueries.at(-1)?.query.limit).toBe("30");
  await expect(page.getByRole("heading", { name: "Shipments", exact: true })).toBeVisible();
  await expect(page.getByText("OABC123NORTH261000001").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("Asha Shah").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("Northstar Parts").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("India").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText(/1,234\.56/).filter({ visible: true })).toHaveCount(1);
  const parcelLink = page.getByText("2 parcels", { exact: true }).filter({ visible: true });
  if (await page.evaluate(() => window.innerWidth >= 768)) await parcelLink.hover();
  else await parcelLink.tap();
  const parcelTooltip = page.getByRole("tooltip");
  await expect(parcelTooltip).toBeVisible();
  if (await page.evaluate(() => window.innerWidth >= 768)) await parcelTooltip.hover();
  const tooltipBox = await parcelTooltip.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox!.width).toBeLessThan(300);
  await expect(parcelTooltip.getByText("NORTH-PARCEL-001")).toBeVisible();
  await expect(parcelTooltip.getByText("NORTH-PARCEL-002")).toBeVisible();
  await expect(parcelTooltip.getByText("1.25 kg")).toBeVisible();
  await expect(parcelTooltip.getByText("2.5 kg")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  if (await page.evaluate(() => window.innerWidth >= 768)) {
    await expect(page.getByRole("columnheader", { name: "AWB", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Consignee", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Parcels", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Amount", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Created", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Actions", exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(page.locator("#operator-shipment-branch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Drafts" }).click();
  await expect(page.getByText("No shipment drafts")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Details" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator staff filters shipments by business account and current status while searching consignee or consignor", async ({ page }) => {
  const capturedQueries: Array<{ path: string; query: Record<string, string> }> = [];
  await mockOperatorShipmentApi(page, "OPERATOR_ADMIN", [], [], capturedQueries);
  await page.goto(`/portal/${slug}/shipments`);
  await expect(page.getByLabel("Business account").locator(`option[value="${accountId}"]`)).toHaveText("Northstar Parts");
  await page.getByLabel("Business account").selectOption(accountId);
  await page.getByLabel("Status", { exact: true }).selectOption("PARCEL_COLLECTED");
  await page.getByLabel("Search shipments").fill("Asha Shah");
  await expect.poll(() => capturedQueries.at(-1)?.query.search).toBe("Asha Shah");

  const request = capturedQueries.at(-1);
  expect(request?.query.businessAccountId).toBe(accountId);
  expect(request?.query.status).toBe("PARCEL_COLLECTED");
  expect(request?.query.pageSize).toBe("10");
  expect(request?.query.branchId).toBeUndefined();
});

test("operator client draft list applies its status and party search filters", async ({ page }) => {
  const capturedQueries: Array<{ path: string; query: Record<string, string> }> = [];
  await mockOperatorShipmentApi(page, "CLIENT", [], [], capturedQueries);
  await page.goto(`/portal/${slug}/shipments`);
  await page.getByRole("tab", { name: "Drafts" }).click();
  await page.getByLabel("Status", { exact: true }).selectOption("NEEDS_REVIEW");
  await page.getByLabel("Search shipments").fill("Northstar Parts");
  await expect.poll(() => capturedQueries.at(-1)?.query.search).toBe("Northstar Parts");

  const request = capturedQueries.at(-1);
  expect(request?.path).toBe(`/api/v1/operators/${slug}/shipments`);
  expect(request?.query.businessAccountId).toBe(accountId);
  expect(request?.query.status).toBe("NEEDS_REVIEW");
  expect(request?.query.limit).toBe("30");
  expect(request?.query.branchId).toBeUndefined();
});

for (const role of ["OPERATOR_ADMIN", "CLIENT"] as const) {
  test(`shipment details layout is aligned and responsive for ${role === "CLIENT" ? "operator clients" : "operator staff"}`, async ({ page }) => {
    await mockOperatorShipmentApi(page, role, []);
    await page.goto(`/portal/${slug}/shipments/${draftId}`);

    await expect(page.getByRole("heading", { level: 1, name: "Shipment details", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to shipments" })).toHaveCount(0);
    await expect(page.getByText("Cotton shirt", { exact: true })).toBeVisible();
    await expect(page.getByText("Shipment documents", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tracking timeline", exact: true })).toBeVisible();
    const shipmentOverviewColumns = page.locator("section[aria-labelledby='operator-parties-heading'] > div.grid");
    const expectedOverviewColumnCount = await page.evaluate(() => window.innerWidth >= 1024 ? 3 : 1);
    expect(await shipmentOverviewColumns.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(expectedOverviewColumnCount);
    await expect(shipmentOverviewColumns.getByRole("heading", { name: "Consignor", exact: true })).toBeVisible();
    await expect(shipmentOverviewColumns.getByRole("heading", { name: "Consignee", exact: true })).toBeVisible();
    await expect(shipmentOverviewColumns.getByRole("heading", { name: "Shipment details", exact: true })).toBeVisible();
    const trackingHistory = page.getByRole("list", { name: "Shipment tracking history" });
    await expect(trackingHistory).toBeVisible();
    await expect(trackingHistory.locator("svg")).toHaveCount(0);
    await expect(trackingHistory.getByText("Latest", { exact: true })).toHaveCount(0);
    const trackingDots = trackingHistory.locator("li > span.rounded-full");
    await expect(trackingDots.first()).toHaveClass(/bg-emerald-500/);
    await expect(trackingDots.first()).toHaveClass(/shadow-\[/);
    await expect(trackingDots.nth(1)).toHaveClass(/bg-sky-300/);
    await expect(page.getByText("Parcel weights", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Next status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh shipment details" })).toHaveCount(0);
    await expect(page.getByText("Delivered", { exact: true }).first()).toHaveClass(/bg-emerald-50/);

    const sectionIds = await page.locator("main > section[aria-labelledby]").evaluateAll((sections) =>
      sections.map((section) => section.getAttribute("aria-labelledby"))
    );
    expect(sectionIds).toEqual([
      "operator-parties-heading",
      "operator-documents-heading",
      "operator-tracking-heading",
      "operator-goods-heading"
    ]);
    expect(await page.locator("main").evaluate((main) => getComputedStyle(main).maxWidth)).toBe("1440px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const role of ["OPERATOR_ADMIN", "CLIENT"] as const) {
  test(`shipment status editor is collapsed and role-guarded for ${role === "CLIENT" ? "operator clients" : "operator staff"}`, async ({ page }) => {
    await mockOperatorShipmentApi(page, role, [], [], [], "IN_TRANSIT");
    await page.goto(`/portal/${slug}/shipments/${draftId}`);

    await expect(page.getByRole("heading", { level: 1, name: "Shipment details", exact: true })).toBeVisible();
    await expect(page.getByLabel("Next status")).toHaveCount(0);
    if (role === "CLIENT") {
      await expect(page.getByRole("button", { name: "Update status" })).toHaveCount(0);
      return;
    }

    const updateButton = page.getByRole("button", { name: "Update status" });
    await expect(updateButton).toBeVisible();
    await updateButton.click();
    await expect(page.getByRole("heading", { name: "Update shipment status" })).toBeVisible();
    await expect(page.getByLabel("Next status")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Close status update" }).click();
    await expect(page.getByLabel("Next status")).toHaveCount(0);
  });
}

test("operator client creates an account manifest from its booked shipment", async ({ page }) => {
  test.setTimeout(90_000);
  const capturedManifests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await mockOperatorShipmentApi(page, "CLIENT", [], capturedManifests);
  await page.goto(`/portal/${slug}/shipments`);
  await page.getByLabel("Select shipment OABC123NORTH261000001").filter({ visible: true }).check({ force: true });
  await page.getByRole("button", { name: "Create account manifest" }).click();
  const dialog = page.getByRole("dialog", { name: "Create account manifest" });
  await dialog.getByLabel(/Destination/).fill("UK Hub");
  await dialog.getByRole("button", { name: "Create account manifest" }).click();
  await expect.poll(() => capturedManifests.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/portal/${slug}/manifests#manifest-507f1f77bcf86cd799439061$`), { timeout: 60_000 });
  expect(capturedManifests).toEqual([{
    path: `/api/v1/operators/${slug}/manifests/bulk`,
    body: { shipmentDraftIds: [draftId], origin: "North Hub", destination: "UK Hub", coloader: "", paymentType: "" }
  }]);
});

test("operator staff creates a combined manifest without mixing branches", async ({ page }) => {
  const capturedManifests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await mockOperatorShipmentApi(page, "OPERATOR_ADMIN", [], capturedManifests);
  await page.goto(`/portal/${slug}/shipments`);
  await page.getByLabel("Select shipment OABC123NORTH261000001").filter({ visible: true }).check({ force: true });
  await page.getByRole("button", { name: "Create combined manifest" }).click();
  const dialog = page.getByRole("dialog", { name: "Create combined manifest" });
  await dialog.getByLabel(/Destination/).fill("UK Hub");
  await dialog.getByRole("button", { name: "Create combined manifest" }).click();
  await expect.poll(() => capturedManifests.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/portal/${slug}/manifests#manifest-507f1f77bcf86cd799439061$`), { timeout: 30_000 });
  expect(capturedManifests).toEqual([{
    path: `/api/v1/operators/${slug}/manifests/combined`,
    body: { shipmentDraftIds: [draftId], origin: "North Hub", destination: "UK Hub", coloader: "", paymentType: "" }
  }]);
});

test("operator staff creates a draft with the selected account and branch", async ({ page }) => {
  const browserErrors = captureBrowserErrors(page);
  const postedDrafts: Array<Record<string, unknown>> = [];
  await mockOperatorShipmentApi(page, "OPERATOR_ADMIN", postedDrafts);
  await page.goto(`/portal/${slug}/shipments/new`);
  await expect(page.getByRole("heading", { name: "Create a shipment" })).toBeVisible();
  await expectWithBrowserDiagnostics(page, browserErrors, () =>
    expect(page.getByLabel("Business account")).toHaveValue("")
  );
  await expect(page.getByLabel("Assigned dispatch branch")).toBeDisabled();

  const accountSelect = page.getByLabel("Business account");
  const branchSelect = page.getByLabel("Assigned dispatch branch");
  const accountOption = accountSelect.locator(`option[value="${accountId}"]`);
  await expect(accountOption).toHaveText("Northstar Parts");
  await expect(accountOption).not.toContainText("BA-2026-123456");
  await expect(page.getByText(/first-release booking uses your operator/i)).toHaveCount(0);
  const accountBox = await accountSelect.boundingBox();
  const branchBox = await branchSelect.boundingBox();
  expect(accountBox).not.toBeNull();
  expect(branchBox).not.toBeNull();
  if (accountBox && branchBox) {
    const isMobile = await page.evaluate(() => window.innerWidth < 768);
    if (isMobile) expect(branchBox.y).toBeGreaterThan(accountBox.y);
    else expect(Math.abs(accountBox.y - branchBox.y)).toBeLessThanOrEqual(2);
  }

  await accountSelect.selectOption(accountId);
  await expect(branchSelect).toHaveValue(branchId);
  await page.getByRole("button", { name: "Continue to shipment details" }).click();
  await expect(page).toHaveURL(new RegExp(`/portal/${slug}/shipments/new\\?draftId=${draftId}$`));
  await expect(page.getByText("Consignee Details", { exact: true })).toBeVisible();
  const bookShipmentButton = page.getByRole("button", { name: "Book Shipment", exact: true });
  await expect(bookShipmentButton).toBeVisible();
  await expect(bookShipmentButton.locator("svg")).toHaveCount(0);
  await expectOperatorBookingColumnsToFitViewport(page);
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  expect(postedDrafts).toEqual([{ businessAccountId: accountId, branchId }]);
});

test("operator client opens the shipment form directly using its assigned account and branch", async ({ page }) => {
  const browserErrors = captureBrowserErrors(page);
  const postedDrafts: Array<Record<string, unknown>> = [];
  await mockOperatorShipmentApi(page, "CLIENT", postedDrafts);
  await page.goto(`/portal/${slug}/shipments/new`);
  await expect(page.getByRole("heading", { name: "Create a shipment" })).toBeVisible();
  await expectWithBrowserDiagnostics(page, browserErrors, () =>
    expect(page.getByText("Consignee Details", { exact: true })).toBeVisible()
  );
  if (await page.evaluate(() => window.innerWidth >= 1280)) {
    const description = page.getByText("Enter the shipment, recipient, parcel, and goods details for your business account.");
    const shipmentsLink = page.getByRole("link", { name: "Shipments", exact: true });
    const descriptionBox = await description.boundingBox();
    const shipmentsBox = await shipmentsLink.boundingBox();
    expect(descriptionBox).not.toBeNull();
    expect(shipmentsBox).not.toBeNull();
    if (descriptionBox && shipmentsBox) {
      expect(Math.abs(descriptionBox.y + descriptionBox.height - shipmentsBox.y - shipmentsBox.height)).toBeLessThanOrEqual(1);
    }
  }
  await expect(page.getByLabel("Business account")).toHaveCount(0);
  await expect(page.getByLabel("Assigned dispatch branch")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/portal/${slug}/shipments/new\\?draftId=${draftId}$`));
  await expect(page.getByRole("button", { name: "Continue to shipment details" })).toHaveCount(0);
  const bookShipmentButton = page.getByRole("button", { name: "Book Shipment", exact: true });
  await expect(bookShipmentButton).toBeVisible();
  await expect(bookShipmentButton.locator("svg")).toHaveCount(0);
  await expectOperatorBookingColumnsToFitViewport(page);
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  expect(postedDrafts).toEqual([{ businessAccountId: accountId, branchId }]);
});

for (const role of ["OPERATOR_ADMIN", "CLIENT"] as const) {
  test(`saved shipment drafts use the aligned scrollable booking layout for ${role === "CLIENT" ? "operator clients" : "operator staff"}`, async ({ page }) => {
    await mockOperatorShipmentApi(page, role, []);
    await page.goto(`/portal/${slug}/shipments/drafts/${draftId}`);

    await expect(page.getByRole("heading", { name: "Create a shipment", exact: true })).toBeVisible();
    await expect(page.getByText("Consignee Details", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Book Shipment", exact: true })).toBeVisible();
    await expectOperatorBookingColumnsToFitViewport(page);

    const layout = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>("[data-operator-header-content]");
      const main = document.querySelector<HTMLElement>("main.mx-auto");
      if (!header || !main) return null;
      const headerRect = header.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
        pageCanScroll: document.documentElement.scrollHeight > window.innerHeight
      };
    });

    expect(layout).not.toBeNull();
    expect(layout?.documentWidth).toBeLessThanOrEqual(layout?.viewportWidth ?? 0);
    if ((layout?.viewportWidth ?? 0) >= 1280) {
      expect(Math.abs((layout?.headerLeft ?? 0) - (layout?.mainLeft ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((layout?.headerRight ?? 0) - (layout?.mainRight ?? 0))).toBeLessThanOrEqual(1);
    } else {
      expect(layout?.pageCanScroll).toBe(true);
    }
  });
}
