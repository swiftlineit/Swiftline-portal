import { expect, test, type Page, type Route } from "playwright/test";

const manifestId = "507f1f77bcf86cd799439021";
const draftId = "507f1f77bcf86cd799439022";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockSession(page: Page, role: "operations" | "client") {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path.endsWith("/auth/refresh")) {
      return json(route, { success: true, accessToken: "browser-test-token" });
    }
    if (path.endsWith("/auth/me")) {
      return json(route, {
        success: true,
        user: {
          id: "507f1f77bcf86cd799439023",
          name: role === "operations" ? "Operations Tester" : "Client Tester",
          email: `${role}@swiftline.test`,
          role,
          assignedBranches: ["507f1f77bcf86cd799439024"],
        },
      });
    }
    if (path.endsWith("/notifications")) {
      return json(route, { success: true, notifications: [], unreadCount: 0 });
    }
    if (path.endsWith("/client/dashboard")) {
      return json(route, {
        success: true,
        accounts: [{
          membership: { role: "account_owner", status: "active" },
          account: { id: "507f1f77bcf86cd799439025", assignedBranch: null },
          dashboardAccess: { state: "READY", blockers: [] },
          bookingAccess: { state: "READY", code: null, message: null },
          assignedBranches: [{ _id: "507f1f77bcf86cd799439024", name: "Delhi" }],
        }],
      });
    }

    return json(route, { success: false, message: `No browser-test fixture for ${request.method()} ${path}` }, 404);
  });
}

function manifestDetail(
  status: "PACKING" | "READY_TO_SEAL" | "SEALED" | "DISPATCHED",
  disposition?: "DEFERRED_TO_NEXT_MANIFEST",
) {
  const now = "2026-09-18T05:30:00.000Z";
  return {
    success: true,
    manifest: {
      id: manifestId,
      manifestNumber: "OM-DEL-260918-001",
      branchId: "507f1f77bcf86cd799439024",
      branch: { name: "Delhi", code: "DEL" },
      header: {
        destinationAgent: "London Gateway",
        destinationCountryCode: "GB",
        destinationCountryName: "United Kingdom",
        flightNumber: "AI-111",
        departureDate: "2026-09-18",
        mawbNumber: "098-12345675",
        originIataCode: "DEL",
        destinationIataCode: "LHR",
        valueType: "LV",
      },
      status,
      totalBags: 1,
      totalConsignments: 1,
      totalPhysicalParcels: 3,
      totalWeightKg: 7.5,
      createdAt: now,
      updatedAt: now,
    },
    bags: [{
      id: "507f1f77bcf86cd799439026",
      bagNumber: "BAG-001",
      status: ["SEALED", "DISPATCHED"].includes(status) ? "READY" : "CLOSED",
      totalConsignments: 1,
      totalPhysicalParcels: 3,
      totalWeightKg: 7.5,
    }],
    consignments: [{
      id: "507f1f77bcf86cd799439027",
      bagId: "507f1f77bcf86cd799439026",
      bagIds: ["507f1f77bcf86cd799439026"],
      bagNumbers: ["BAG-001"],
      consignmentNumber: "SLCDEL180926001",
      displayConsignmentNumber: "SLCDEL180926001",
      expectedParcelNumbers: ["SLCDEL180926001-01", "SLCDEL180926001-02", "SLCDEL180926001-03", "SLCDEL180926001-04"],
      scannedParcelNumbers: ["SLCDEL180926001-01", "SLCDEL180926001-02", "SLCDEL180926001-03"],
      parcelDispositions: disposition ? [{
        parcelNumber: "SLCDEL180926001-04",
        disposition,
        reason: "Parcel retained for document verification",
        recordedAt: now,
      }] : [],
      parcelValues: [
        { parcelNumber: "SLCDEL180926001-01", valueMinor: 250000 },
        { parcelNumber: "SLCDEL180926001-02", valueMinor: 250000 },
        { parcelNumber: "SLCDEL180926001-03", valueMinor: 250000 },
      ],
      weightKg: 7.5,
      status: "PARTIAL",
      consigneeSnapshot: { name: "London Receiver", formatted: "London Receiver\nLondon, United Kingdom" },
      consignorSnapshot: { name: "Delhi Exporter", formatted: "Delhi Exporter\nDelhi, India" },
      description: "Garment samples",
      declaredValueMinor: 750000,
      serviceInfo: "Swiftline Express",
      goodsValueRequired: false,
      dpdWarning: "",
    }],
    scans: [],
    latestScan: null,
    sealingIssues: status === "PACKING"
      ? [
          ...(!disposition ? ["Choose Held, Deferred to next manifest, or Cancelled for 1 unscanned parcel."] : []),
        ]
      : [],
    destinationSummary: [{ countryCode: "GB", countryName: "United Kingdom", consignments: 1, parcels: 3 }],
    dispatchIssues: [],
  };
}

test("Operations records an omitted parcel and dispatches from the protected confirmation button", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await mockSession(page, "operations");
  let status: "PACKING" | "READY_TO_SEAL" | "SEALED" | "DISPATCHED" = "PACKING";
  let disposition: "DEFERRED_TO_NEXT_MANIFEST" | undefined;
  const dispatchBodies: Array<Record<string, unknown>> = [];

  await page.route(`**/api/v1/operations-manifests/${manifestId}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/scan-sessions/active")) {
      return json(route, { success: true, session: null });
    }
    if (path.endsWith("/parcel-disposition") && request.method() === "PUT") {
      const body = request.postDataJSON() as { disposition: "DEFERRED_TO_NEXT_MANIFEST" };
      disposition = body.disposition;
      status = "READY_TO_SEAL";
      return json(route, { success: true, message: "Parcel decision recorded." });
    }
    if (path.endsWith("/seal") && request.method() === "POST") {
      status = "SEALED";
      return json(route, { success: true, message: "Manifest sealed." });
    }
    if (path.endsWith("/dispatch") && request.method() === "POST") {
      dispatchBodies.push(request.postDataJSON() as Record<string, unknown>);
      status = "DISPATCHED";
      return json(route, { success: true, message: "Manifest dispatched." });
    }
    if (path === `/api/v1/operations-manifests/${manifestId}` && request.method() === "GET") {
      return json(route, manifestDetail(status, disposition));
    }
    return json(route, { success: false, message: `Unhandled manifest request ${request.method()} ${path}` }, 404);
  });

  await page.goto(`/dashboard/operations-manifests/${manifestId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("3 of 4 scanned", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Decision required", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByPlaceholder("Explain why this correction is required").fill("Parcel retained for document verification");
  await page.getByRole("button", { name: "Confirm Correction" }).click();
  await expect(page.getByText("Next manifest", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Seal Manifest" })).toBeVisible();
  await page.getByRole("button", { name: "Seal Manifest" }).click();
  await page.screenshot({ path: testInfo.outputPath("operations-partial-manifest.png"), fullPage: true });

  await expect(page.getByRole("button", { name: "Confirm Dispatch" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm Dispatch" }).click();
  await expect.poll(() => dispatchBodies.length).toBe(1);
  expect(dispatchBodies[0]).toEqual({ method: "BUTTON" });
});

test("Operations records receipt and export processing from the dedicated HAWB scanner", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await mockSession(page, "operations");
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/dpd-shipments/operations-scan", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    const action = String(body.action);
    return json(route, {
      success: true,
      message: action === "RECEIVE" ? "Received at Origin Facility recorded." : "Processing for Export recorded.",
      result: {
        alreadyRecorded: false,
        status: action === "RECEIVE" ? "WAREHOUSE_SCAN_IN" : "ORIGIN_HUB_PROCESSED",
        statusLabel: action === "RECEIVE" ? "Received at Origin Facility" : "Processing for Export",
        eventAt: "2026-09-18T07:30:00.000Z",
        location: "Delhi",
        swiftlineTrackingNumber: "SLCDEL180926001",
        parcelNumbers: ["SLCDEL180926001-01"],
        progress: { parcelNumber: "SLCDEL180926001-01", scannedParcels: 1, totalParcels: 1, remainingParcels: 0, milestoneRecorded: true },
      },
    }, 201);
  });

  await page.goto("/dashboard/operations-scans", { waitUntil: "domcontentloaded" });
  const barcode = page.getByLabel("Swiftline parcel barcode");
  await expect(barcode).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Scan parcel barcode with device camera" })).toBeVisible();
  await barcode.fill("SLCDEL180926001");
  await page.getByRole("button", { name: "Confirm receipt" }).click();
  await expect(page.getByText("Received at Origin Facility", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Process for export" }).click();
  await barcode.fill("SLCDEL180926001");
  await page.getByRole("button", { name: "Confirm processing" }).click();
  await expect(page.getByText("Processing for Export", { exact: true })).toBeVisible();
  expect(requests.map((request) => request.action)).toEqual(["RECEIVE", "PROCESS"]);
  await page.screenshot({ path: testInfo.outputPath("operations-origin-scans.png"), fullPage: true });
});

test("Selecting a dispatched manifest pre-fills a new flight and attaches its shipments", async ({ page }) => {
  test.setTimeout(120_000);
  await mockSession(page, "operations");
  const created: Array<Record<string, unknown>> = [];
  const flightId = "507f1f77bcf86cd799439040";
  await page.route("**/api/v1/operations-manifests**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/branches/options")) {
      return json(route, { success: true, branches: [{ id: "507f1f77bcf86cd799439024", name: "Delhi", code: "DEL" }] });
    }
    if (url.pathname === "/api/v1/operations-manifests" && request.method() === "GET") {
      const detail = manifestDetail("DISPATCHED", "DEFERRED_TO_NEXT_MANIFEST");
      return json(route, { success: true, items: [{ ...detail.manifest, flightLinehaulId: null }], pagination: { page: 1, pages: 1, total: 1 } });
    }
    return route.fallback();
  });
  await page.route("**/api/v1/flight-linehauls**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/flight-linehauls" && request.method() === "POST") {
      created.push(request.postDataJSON() as Record<string, unknown>);
      return json(route, { success: true, message: "Flight created.", flightId, flightLinehaulNumber: "FL-001" }, 201);
    }
    return route.fallback();
  });

  await page.goto("/dashboard/flight-linehauls/new", { waitUntil: "domcontentloaded" });
  const manifestSelect = page.getByLabel("Operations manifest *");
  await expect(manifestSelect).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Create Flight" }).click();
  await expect.poll(() => created.length).toBe(0);
  await manifestSelect.selectOption(manifestId);
  await expect(page.getByLabel("Flight number *")).toHaveValue("AI-111");
  await expect(page.getByLabel("MAWB *")).toHaveValue("098-12345675");
  await expect(page.getByLabel("Origin IATA *")).toHaveValue("DEL");
  await expect(page.getByLabel("Destination IATA *")).toHaveValue("LHR");
  await page.getByLabel("Airline *").fill("Air India");
  await page.getByLabel("Scheduled arrival *").fill("2026-09-19T06:00");
  await page.getByRole("button", { name: "Create Flight" }).click();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({
    branchId: "507f1f77bcf86cd799439024",
    flightNumber: "AI-111",
    mawbNumber: "098-12345675",
    originIataCode: "DEL",
    destinationIataCode: "LHR",
    manifestId,
  });
});

test("Operations can record a customer-visible customs hold from destination handover", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await mockSession(page, "operations");
  const flightId = "507f1f77bcf86cd799439030";
  const handoverBodies: Array<Record<string, unknown>> = [];
  const now = "2026-09-18T05:30:00.000Z";
  const flight = {
    _id: flightId,
    id: flightId,
    flightLinehaulNumber: "FL-DEL-260918-001",
    branchId: "507f1f77bcf86cd799439024",
    flightNumber: "AI-111",
    airlineName: "Air India",
    mawbNumber: "098-12345675",
    originIataCode: "DEL",
    destinationIataCode: "LHR",
    transitIataCode: "",
    scheduledDepartureAt: "2026-09-17T20:00:00.000Z",
    scheduledArrivalAt: "2026-09-18T05:00:00.000Z",
    actualDepartureAt: "2026-09-17T20:15:00.000Z",
    actualArrivalAt: "2026-09-18T05:10:00.000Z",
    capacityKg: 500,
    allocatedWeightKg: 7.5,
    utilisationPercent: 1.5,
    totalShipments: 1,
    totalBags: 1,
    totalPieces: 3,
    status: "ARRIVED_DESTINATION",
    connection: null,
    customsStatus: "SUBMITTED",
    customsClearedAt: null,
    customsSubmittedAt: now,
    destinationAgent: "London Gateway",
    finalMileCarrier: "Destination agent",
    arrivalAt: "2026-09-18T05:10:00.000Z",
    handoverAt: null,
    handoverReference: "",
    branch: { name: "Delhi", code: "DEL" },
    createdAt: now,
    updatedAt: now,
  };
  const detail = {
    success: true,
    flight,
    stats: { allocatedWeightKg: 7.5, utilisationPercent: 1.5, totalShipments: 1, totalBags: 1, totalPieces: 3, manifestCount: 1 },
    allocations: [],
    manifests: [],
    bags: [],
    consignments: [],
    offloads: [],
    exceptions: [],
    documents: [],
    auditHistory: [],
  };

  await page.route(`**/api/v1/flight-linehauls/${flightId}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/handover") && request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      handoverBodies.push(body);
      flight.customsStatus = String(body.customsStatus);
      return json(route, { success: true, message: "Handover updated.", flight });
    }
    if (path === `/api/v1/flight-linehauls/${flightId}` && request.method() === "GET") {
      return json(route, detail);
    }
    return route.fallback();
  });

  await page.goto(`/dashboard/flight-linehauls/${flightId}`, { waitUntil: "domcontentloaded" });
  const transition = page.getByLabel("Transition to");
  await expect(transition).toBeVisible({ timeout: 60_000 });
  await expect(transition.locator("option")).toHaveText(["Select status", "Closed"]);
  await page.getByRole("button", { name: "Destination handover" }).click();
  const customsStatus = page.getByLabel("Customs status");
  await expect(customsStatus).toBeVisible({ timeout: 60_000 });
  await customsStatus.selectOption("HELD");
  const customsNote = page.getByLabel(/Customs note/);
  await expect(customsNote).toHaveAttribute("required", "");
  await customsNote.fill("Customs requires the consignee tax document.");
  const handoverPanel = page.getByRole("heading", { name: "Destination handover" }).locator("xpath=ancestor::section[1]");
  await handoverPanel.screenshot({ path: testInfo.outputPath("operations-customs-hold.png") });
  await page.getByRole("button", { name: "Save handover" }).click();
  await expect.poll(() => handoverBodies.length).toBe(1);
  expect(handoverBodies[0]).toMatchObject({
    customsStatus: "HELD",
    customsNote: "Customs requires the consignee tax document.",
  });
});

function clientShipment() {
  const parcelList = [1, 2, 3, 4].map((sequence) => ({
    sequence,
    weightKg: 2.5,
    shipmentContentType: "NON_DOCUMENTS",
    contentsDescription: "Garment samples",
    items: [{ description: "Garment samples", hsnCode: "6204", quantity: 1, unitRate: 2500 }],
    declaredGoodsValueMinor: 250000,
  }));
  const milestones = [
    ["Booking Confirmed", "2026-09-17T04:30:00.000Z"],
    ["Received at Origin Facility Delhi", "2026-09-17T06:30:00.000Z"],
    ["Processing for Export", "2026-09-17T07:30:00.000Z"],
    ["Ready for Dispatch", "2026-09-17T09:30:00.000Z"],
    ["Departed from Origin Facility Delhi", "2026-09-18T01:30:00.000Z"],
    ["In International Transit", null],
    ["Arrived in Destination Country", null],
    ["Out for Delivery", null],
    ["Delivered", null],
  ].map(([label, reachedAt], index) => ({ key: `stage-${index}`, label, reachedAt, isCurrent: index === 4 }));

  return {
    shipmentDraft: {
      id: draftId,
      status: "BOOKED",
      statusLabel: "Booked",
      addressValidationStatus: "VALID",
      serviceType: "COURIER",
      serviceCode: "SWIFTLINE_EXPRESS",
      csbType: "CSB_IV",
      parcelCount: 4,
      parcelList,
      kycUseForAllParcels: true,
      kycDocuments: {},
      consignee: {
        companyName: "London Receiver Ltd",
        contactName: "Alex Receiver",
        email: "receiver@example.test",
        mobileCountryCode: "+44",
        mobileNumber: "7700900000",
        addressLine1: "1 Test Street",
        addressLine2: "",
        townOrCity: "London",
        county: "London",
        postcode: "SW1A 1AA",
        countryCode: "GB",
        countryName: "United Kingdom",
        deliveryInstructions: "Reception",
      },
      createdAt: "2026-09-17T04:30:00.000Z",
      updatedAt: "2026-09-18T01:30:00.000Z",
    },
    dpdShipment: {
      id: "507f1f77bcf86cd799439028",
      shipmentDraftId: draftId,
      idempotencyKey: "browser-test",
      dpdShipmentId: "1017000001",
      dpdTransactionId: "browser-test",
      swiftlineTrackingNumber: "SLCDEL180926001",
      parcelNumbers: parcelList.map((parcel) => `SLCDEL180926001-0${parcel.sequence}`),
      serviceCode: "SWIFTLINE_EXPRESS",
      paymentSource: "CREDIT",
      status: "LABEL_RECEIVED",
      createdAt: "2026-09-17T04:30:00.000Z",
      updatedAt: "2026-09-18T01:30:00.000Z",
    },
    bookingConfirmation: null,
    taxInvoiceNumber: "SL/26-27/0001",
    labels: [],
    currentEvent: {
      id: "event-5",
      status: "ORIGIN_HUB_DISPATCHED",
      statusLabel: "Departed from Origin Facility Delhi",
      note: "Three parcels departed; one will travel on the next manifest.",
      location: "Delhi",
      customerVisible: true,
      eventAt: "2026-09-18T01:30:00.000Z",
    },
    events: [
      { id: "event-1", status: "SHIPMENT_BOOKED", statusLabel: "Booking Confirmed", note: "Shipment booked.", location: "Delhi", customerVisible: true, eventAt: "2026-09-17T04:30:00.000Z" },
      { id: "event-2", status: "WAREHOUSE_SCAN_IN", statusLabel: "Received at Origin Facility Delhi", note: "Received by Swiftline.", location: "Delhi", customerVisible: true, eventAt: "2026-09-17T06:30:00.000Z" },
      { id: "event-3", status: "ORIGIN_HUB_PROCESSED", statusLabel: "Processing for Export", note: "Processing completed.", location: "Delhi", customerVisible: true, eventAt: "2026-09-17T07:30:00.000Z" },
      { id: "event-4", status: "READY_FOR_EXPORT", statusLabel: "Ready for Dispatch", note: "Ready for dispatch.", location: "Delhi", customerVisible: true, eventAt: "2026-09-17T09:30:00.000Z" },
      { id: "event-5", status: "ORIGIN_HUB_DISPATCHED", statusLabel: "Departed from Origin Facility Delhi", note: "Three parcels departed.", location: "Delhi", customerVisible: true, eventAt: "2026-09-18T01:30:00.000Z" },
    ],
    deliveryEstimate: null,
    trackingJourney: {
      context: { routeSegments: ["Delhi", "London"], deliveryPartnerName: "Swiftline destination partner" },
      milestones,
    },
    trackingPosition: { label: "Delhi", source: "RECORDED", basisStatus: "ORIGIN_HUB_DISPATCHED", holdReasonLabel: "" },
    parcelActivities: [{
      parcelNumber: "SLCDEL180926001-04",
      status: "DEFERRED_TO_NEXT_MANIFEST",
      eventAt: "2026-09-18T01:30:00.000Z",
      customerMessage: "This parcel is scheduled to travel on a later manifest.",
    }],
    parcelProgress: { milestone: "ORIGIN_DISPATCH", completedParcels: 3, totalParcels: 4, isPartial: true },
  };
}

test("Operations can refresh ALS and sees unknown carrier events in the review panel", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await mockSession(page, "operations");
  const base = clientShipment();
  const refreshRequests: string[] = [];
  const adminDraft = {
    _id: draftId,
    creationSource: "MANUAL",
    businessAccountId: "507f1f77bcf86cd799439025",
    branchId: "507f1f77bcf86cd799439024",
    consigneeEnteredAddress: base.shipmentDraft.consignee,
    addressValidationStatus: "VALID",
    parcelCount: 4,
    parcelList: base.shipmentDraft.parcelList,
    serviceType: "COURIER",
    serviceCode: "SWIFTLINE_EXPRESS",
    csbType: "CSB_IV",
    validationIssues: [],
    status: "BOOKED",
    bookingState: "BOOKED",
    createdAt: base.shipmentDraft.createdAt,
    updatedAt: base.shipmentDraft.updatedAt,
  };
  const transitEvent = {
    id: "event-6",
    status: "IN_TRANSIT",
    statusLabel: "In International Transit",
    note: "Flight departed Delhi.",
    location: "Delhi",
    customerVisible: true,
    eventAt: "2026-09-18T02:00:00.000Z",
  };
  const history = {
    dpdShipment: base.dpdShipment,
    shipmentDraft: {
      id: draftId,
      branchId: adminDraft.branchId,
      consigneeName: "London Receiver Ltd",
      consigneeTownOrCity: "London",
      deliveryPostcode: "SW1A 1AA",
      status: "BOOKED",
      addressValidationStatus: "VALID",
    },
    branch: { id: adminDraft.branchId, name: "Delhi", code: "DEL", city: "Delhi" },
    labels: [],
    bookingConfirmation: null,
    shipmentInvoice: null,
    currentEvent: transitEvent,
    events: [...base.events, transitEvent],
    trackingJourney: base.trackingJourney,
    trackingPosition: { label: "In flight", source: "RECORDED", basisStatus: "IN_TRANSIT", holdReasonLabel: "" },
    parcelActivities: base.parcelActivities,
    parcelProgress: base.parcelProgress,
    carrierTrackingReviews: [{
      id: "507f1f77bcf86cd799439031",
      carrierAwbNumber: "1017000001",
      eventState: "new_vendor_code",
      description: "Transferred to destination handling desk",
      location: "London",
      eventAt: "2026-09-18T06:30:00.000Z",
      processingNote: "Unknown ALS code; verify before changing customer tracking.",
      receivedAt: "2026-09-18T06:31:00.000Z",
    }],
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/api/v1/shipment-drafts/${draftId}` && request.method() === "GET") {
      return json(route, { success: true, shipmentDraft: adminDraft });
    }
    if (path === `/api/v1/dpd-shipments/drafts/${draftId}/details` && request.method() === "GET") {
      return json(route, { success: true, shipment: history });
    }
    if (path === `/api/v1/shipment-cancellations/drafts/${draftId}`) {
      return json(route, { success: true, canRequest: true, cancellation: null });
    }
    if (path === `/api/v1/dpd-shipments/${base.dpdShipment.id}/refresh-carrier-tracking` && request.method() === "POST") {
      refreshRequests.push(path);
      return json(route, { success: true, message: "ALS tracking refreshed.", result: { applied: 0, reviewRequired: 1, state: "ACTIVE" } });
    }
    return route.fallback();
  });

  await page.goto(`/dashboard/shipments/${draftId}`, { waitUntil: "domcontentloaded" });
  const refresh = page.getByRole("button", { name: "Refresh ALS Tracking" });
  await expect(refresh).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Shipment Collected", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Received at Origin Facility Delhi", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("3 of 4 parcels departed from Origin Facility", { exact: true })).toBeVisible();
  await expect(page.getByText("SLCDEL180926001-04", { exact: true })).toBeVisible();
  await expect(page.getByText("Next manifest", { exact: true })).toBeVisible();
  await refresh.click();
  await expect.poll(() => refreshRequests.length).toBe(1);
  const reviewPanel = page.getByRole("heading", { name: "Carrier events needing review" }).locator("xpath=ancestor::section[1]");
  await expect(reviewPanel).toContainText("Transferred to destination handling desk");
  await expect(reviewPanel).toContainText("Unknown ALS code; verify before changing customer tracking.");
  await reviewPanel.screenshot({ path: testInfo.outputPath("operations-als-review.png") });
});

test("Client sees shipment-level milestones with exact partial-parcel progress", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await mockSession(page, "client");
  await page.route("**/api/v1/client/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/v1/client/shipments/${draftId}`) {
      return json(route, { success: true, shipment: clientShipment() });
    }
    if (path.endsWith(`/shipments/${draftId}/cancellation`)) {
      return json(route, { success: true, canRequest: false, cancellation: null });
    }
    if (path.endsWith(`/shipments/${draftId}/pod`)) {
      return json(route, { success: true, pod: null });
    }
    if (path.endsWith(`/claims/eligibility/${draftId}`)) {
      return json(route, { success: true, eligibility: { eligible: false, reason: "NOT_PERMITTED", message: "Not available." } });
    }
    if (path.endsWith(`/shipments/${draftId}/manifests/context`)) {
      return json(route, { success: true, canCreate: false, currentShipmentDraftId: draftId, existingManifests: [], eligibleShipments: [] });
    }
    return route.fallback();
  });

  await page.goto(`/client/shipments/${draftId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Shipment Details" })).toBeVisible();
  await expect(page.getByText("Shipment Collected", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Received at Origin Facility Delhi", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Customs Clearance in Progress", { exact: true })).toHaveCount(0);
  await expect(page.getByText("3 of 4 parcels departed from Origin Facility", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("SLCDEL180926001-04", { exact: true })).toBeVisible();
  await expect(page.getByText("Next manifest", { exact: true })).toBeVisible();
  await expect(page.getByText("This parcel is scheduled to travel on a later manifest.", { exact: true })).toBeVisible();
  await expect(page.getByText("Carrier events needing review")).toHaveCount(0);
  const parcelPanel = page.getByRole("heading", { name: "Parcel activity" }).locator("xpath=ancestor::section[1]");
  await parcelPanel.screenshot({ path: testInfo.outputPath("client-partial-shipment.png") });
});
