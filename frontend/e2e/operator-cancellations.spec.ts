import { expect, test, type Page, type Route } from "playwright/test";

const slug = "northstar-cargo";
const draftId = "507f1f77bcf86cd799439051";
const cancellationId = "507f1f77bcf86cd799439071";
const accountId = "507f1f77bcf86cd799439021";
const branchId = "507f1f77bcf86cd799439031";

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

function cancellationFixture(status: "REQUESTED" | "COMPLETED" | "REJECTED" = "REQUESTED") {
  return {
    id: cancellationId,
    shipmentDraftId: draftId,
    dpdShipmentId: "507f1f77bcf86cd799439061",
    businessAccountId: accountId,
    branchId,
    requesterType: "CLIENT",
    requesterRole: "account_owner",
    reason: "Customer needs to change the delivery plan.",
    shipmentStatusAtRequest: "ORIGIN_HUB_DISPATCHED",
    status,
    originalAmountMinor: 100_000,
    taxTreatment: "GST_APPLICABLE",
    requestedFeeBaseMinor: 0,
    approvedFeeBaseMinor: status === "COMPLETED" ? 2_500 : null,
    feeGstMinor: status === "COMPLETED" ? 450 : null,
    feeTotalMinor: status === "COMPLETED" ? 2_950 : null,
    refundableAmountMinor: status === "COMPLETED" ? 97_050 : null,
    feeReason: "Requested service was already dispatched.",
    carrierConfirmed: false,
    carrierConfirmationRequired: false,
    settlementConfirmed: status === "COMPLETED",
    reviewNote: status === "REJECTED" ? "The shipment has already been delivered." : "",
    creditNoteId: status === "COMPLETED" ? "507f1f77bcf86cd799439081" : null,
    cancellationFeeInvoiceId: status === "COMPLETED" ? "507f1f77bcf86cd799439082" : null,
    requestedAt: "2026-10-23T08:00:00.000Z",
    reviewedAt: status === "REQUESTED" ? null : "2026-10-23T08:30:00.000Z",
    completedAt: status === "COMPLETED" ? "2026-10-23T08:30:00.000Z" : null
  };
}

async function mockSession(page: Page, role: "CLIENT" | "OPERATOR_ADMIN" | "OPERATIONS" | "FINANCE") {
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
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-cancellation-test-token" });
    if (path === `/api/v1/operators/${slug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439011", slug, companyName: "Northstar Cargo" },
        membership: { role, assignedBranches: role === "OPERATOR_ADMIN" ? [] : [branchId] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}` && request.method() === "GET") {
      return json(route, { success: true, shipment: {
        shipmentDraft: {
          _id: draftId,
          businessAccountId: accountId,
          branchId,
          customerType: "BUSINESS",
          consignorAddress: {},
          consignee: { companyName: "Asha Shah", contactName: "Asha Shah", townOrCity: "Mumbai", postcode: "400001", countryName: "India", countryCode: "IN" },
          consigneeEnteredAddress: { companyName: "Asha Shah", contactName: "Asha Shah", townOrCity: "Mumbai", postcode: "400001", countryName: "India", countryCode: "IN" },
          parcelList: [{ sequence: 1, weightKg: 1, items: [], contentsDescription: "Parts" }],
          parcelCount: 1,
          serviceType: "COURIER"
        },
        dpdShipment: { _id: "507f1f77bcf86cd799439061", swiftlineTrackingNumber: "OABC123NORTH261000001", status: "LABEL_RECEIVED", createdAt: "2026-10-22T08:00:00.000Z" },
        branch: { name: "North Hub", code: "NORTH" },
        events: [],
        currentEvent: { status: "ORIGIN_HUB_DISPATCHED", statusLabel: "Dispatched", eventAt: "2026-10-22T09:00:00.000Z" },
        labels: [],
        shipmentInvoice: { invoiceNumber: "OP/26-27/0001", currency: "INR", totalAmountMinor: 100_000, status: "ISSUED", revision: 1 },
        taxInvoiceNumber: "OP/26-27/0001"
      } });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/cancellation` && request.method() === "GET") {
      return json(route, { success: true, canRequest: true, eligibilityMessage: "", cancellation: null });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/cancellation` && request.method() === "POST") {
      return json(route, { success: true, cancellation: { ...cancellationFixture(), reason: request.postDataJSON()?.reason ?? "" } }, 201);
    }
    if (path === `/api/v1/operators/${slug}/cancellations` && request.method() === "GET") {
      return json(route, { success: true, cancellations: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } });
    }
    return json(route, { success: false, message: `No cancellation test fixture for ${request.method()} ${path}` }, 404);
  });
}

test("operator client requests cancellation with a reason and sees review status", async ({ page }) => {
  let postedBody: Record<string, unknown> | null = null;
  await mockSession(page, "CLIENT");
  await page.route(`**/api/v1/operators/${slug}/shipments/${draftId}/cancellation`, async (route) => {
    if (route.request().method() === "POST") {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, { success: true, cancellation: { ...cancellationFixture(), reason: postedBody.reason } }, 201);
    }
    return json(route, { success: true, canRequest: true, eligibilityMessage: "", cancellation: null });
  });

  await page.goto(`/portal/${slug}/shipments/${draftId}`);
  const panel = page.getByRole("region", { name: "Shipment cancellation" });
  await expect(panel.getByLabel("Reason for cancellation")).toBeVisible();
  await panel.getByLabel("Reason for cancellation").fill("Customer needs to change the delivery plan.");
  await panel.getByRole("button", { name: "Request cancellation" }).click();

  await expect(panel.getByText("Awaiting operator review")).toBeVisible();
  await expect(panel.getByText("Original invoice")).toBeVisible();
  await expect.poll(() => postedBody).toEqual({ reason: "Customer needs to change the delivery plan." });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator staff can review a cancellation and set an editable fee", async ({ page }) => {
  let postedApproval: Record<string, unknown> | null = null;
  let queueReads = 0;
  await mockSession(page, "OPERATIONS");
  await page.route(`**/api/v1/operators/${slug}/cancellations?*`, async (route) => {
    if (route.request().method() !== "GET") return json(route, { success: false, message: "Unexpected queue method." }, 405);
    queueReads += 1;
    return json(route, {
      success: true,
      cancellations: queueReads > 1 ? [] : [{
        ...cancellationFixture(),
        trackingNumber: "OABC123NORTH261000001",
        accountName: "Northstar Parts",
        accountId: "BA-2026-123456",
        branch: { id: branchId, name: "North Hub", code: "NORTH" },
        destination: "Asha Shah",
        currentStatus: "ORIGIN_HUB_DISPATCHED"
      }],
      pagination: { page: 1, pageSize: 50, total: queueReads > 1 ? 0 : 1, totalPages: 1 }
    });
  });
  await page.route(`**/api/v1/operators/${slug}/cancellations/${cancellationId}/approve`, async (route) => {
    postedApproval = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { success: true, cancellation: cancellationFixture("COMPLETED") });
  });

  await page.goto(`/portal/${slug}/cancellations`);
  await expect(page.getByRole("heading", { name: "Cancellation review" })).toBeVisible();
  await expect(page.getByText("OABC123NORTH261000001")).toBeVisible();
  await page.getByRole("button", { name: "Review and approve" }).click();
  await page.getByLabel("Cancellation fee before GST").fill("25.00");
  await page.getByLabel("Reason for fee").fill("Shipment had already been dispatched.");
  await page.getByLabel("I verified the cancellation and credit settlement details.").check();
  await page.getByRole("button", { name: "Approve cancellation" }).click();

  await expect.poll(() => postedApproval).toEqual({
    feeBaseMinor: 2500,
    feeReason: "Shipment had already been dispatched.",
    reviewNote: "",
    settlementConfirmed: true
  });
  await expect(page.getByRole("heading", { name: "No cancellation requests need review" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator staff must record a rejection reason", async ({ page }) => {
  let postedRejection: Record<string, unknown> | null = null;
  await mockSession(page, "OPERATOR_ADMIN");
  await page.route(`**/api/v1/operators/${slug}/cancellations?*`, async (route) => json(route, {
    success: true,
    cancellations: [{
      ...cancellationFixture(),
      trackingNumber: "OABC123NORTH261000001",
      accountName: "Northstar Parts",
      accountId: "BA-2026-123456",
      branch: { id: branchId, name: "North Hub", code: "NORTH" },
      destination: "Asha Shah",
      currentStatus: "DELIVERED"
    }],
    pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 }
  }));
  await page.route(`**/api/v1/operators/${slug}/cancellations/${cancellationId}/reject`, async (route) => {
    postedRejection = route.request().postDataJSON() as Record<string, unknown>;
    return json(route, { success: true, cancellation: cancellationFixture("REJECTED") });
  });

  await page.goto(`/portal/${slug}/cancellations`);
  await page.getByRole("button", { name: "Decline" }).click();
  await page.getByLabel("Reason for declining").fill("The shipment has already been delivered.");
  await page.getByRole("button", { name: "Confirm decline" }).click();
  await expect.poll(() => postedRejection).toEqual({ reviewNote: "The shipment has already been delivered." });
});
