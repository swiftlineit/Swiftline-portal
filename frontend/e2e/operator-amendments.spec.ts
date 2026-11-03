import { expect, test, type Page, type Route } from "playwright/test";

const slug = "northstar-cargo";
const draftId = "507f1f77bcf86cd799439051";
const amendmentId = "507f1f77bcf86cd799439091";
const accountId = "507f1f77bcf86cd799439021";
const branchId = "507f1f77bcf86cd799439031";

const estimate = {
  parcels: [{
    sequence: 1,
    actualWeightKg: 1,
    volumetricWeightKg: 1,
    chargeableWeightKg: 1,
    rateCardId: "507f1f77bcf86cd799439101",
    rateFromKg: 0,
    rateToKg: 5,
    chargesPerKg: 100,
    maxBoxKg: 20,
    baseAmount: 100,
    exceedsMaxBoxKg: false
  }],
  baseAmount: 100,
  gstAmount: 18,
  totalAmount: 118,
  missingRate: false,
  exceedsMaxBoxKg: false,
  gstRate: 0.18
};

function amendmentFixture(status: "REQUESTED" | "APPROVED" | "REJECTED" = "REQUESTED") {
  return {
    id: amendmentId,
    shipmentDraftId: draftId,
    dpdShipmentId: "507f1f77bcf86cd799439061",
    businessAccountId: accountId,
    branchId,
    requestedBy: "507f1f77bcf86cd799439011",
    actorRole: "client",
    status,
    reason: "Customer asked to correct delivery details.",
    requestedChanges: { consigneeEnteredAddress: { townOrCity: "Pune" } },
    changePreview: [{ fieldName: "consigneeEnteredAddress.townOrCity", originalValue: "Mumbai", newValue: "Pune" }],
    pricingImpact: { current: estimate, requested: estimate, deltaAmount: 0 },
    fundingPreview: {
      billingMode: "BUSINESS_ACCOUNT",
      previousAmountMinor: 11800,
      amendedAmountMinor: 11800,
      deltaAmountMinor: 0,
      availableBookingCapacityMinor: 100000,
      canFund: true,
      message: "",
      adjustment: {
        previousAmountMinor: 11800,
        amendedAmountMinor: 11800,
        deltaAmountMinor: 0,
        advanceUsedMinor: 0,
        creditUsedMinor: 0,
        creditReducedMinor: 0,
        advanceRefundedMinor: 0,
        advanceCreditedMinor: 0,
        advanceAppliedMinor: 0,
        creditOutstandingMinor: 0,
        settledAmountMinor: 11800
      }
    },
    billingAdjustment: null,
    reviewNote: status === "REJECTED" ? "The delivery details could not be verified." : "",
    requestedAt: "2026-10-23T08:00:00.000Z",
    reviewedAt: status === "REQUESTED" ? null : "2026-10-23T08:30:00.000Z",
    appliedAt: status === "APPROVED" ? "2026-10-23T08:30:00.000Z" : null,
    currentAmountMinor: 11800,
    requestedAmountMinor: 11800
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockSession(page: Page, role: "CLIENT" | "OPERATOR_ADMIN" | "OPERATIONS" | "FINANCE") {
  let submitted = false;
  let amendmentReviewed = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-amendment-test-token" });
    if (path === `/api/v1/operators/${slug}/me`) {
      return json(route, {
        success: true,
        operator: { id: "507f1f77bcf86cd799439001", slug, companyName: "Northstar Cargo" },
        membership: { role, assignedBranches: role === "OPERATOR_ADMIN" ? [] : [branchId] },
        access: { mode: "MEMBER", readOnly: false }
      });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}` && request.method() === "GET") {
      return json(route, { success: true, shipment: {
        shipmentDraft: {
          _id: draftId,
          status: "READY_FOR_DPD",
          addressValidationStatus: "VALID",
          businessAccountId: accountId,
          branchId,
          customerType: "BUSINESS",
          serviceType: "COURIER",
          serviceCode: "INTL",
          consignee: {
            companyName: "Asha Shah",
            contactName: "Asha Shah",
            email: "asha@example.test",
            mobileNumber: "9000000000",
            addressLine1: "10 Market Road",
            addressLine2: "",
            townOrCity: "Mumbai",
            county: "Maharashtra",
            postcode: "400001",
            countryName: "India",
            countryCode: "IN"
          },
          parcelList: [{ sequence: 1, weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, shipmentContentType: "PARCEL", items: [{ description: "Parts", hsnCode: "1234", unitType: "PCS", quantity: 1, unitRate: 100 }], contentsDescription: "Parts" }],
          parcelCount: 1,
          createdAt: "2026-10-22T08:00:00.000Z"
        },
        dpdShipment: { _id: "507f1f77bcf86cd799439061", swiftlineTrackingNumber: "OABC123NORTH261000001", status: "LABEL_RECEIVED", createdAt: "2026-10-22T08:00:00.000Z" },
        branch: { name: "North Hub", code: "NORTH" },
        events: [],
        currentEvent: { status: "SHIPMENT_BOOKED", statusLabel: "Booked", eventAt: "2026-10-22T08:00:00.000Z" },
        labels: [],
        shipmentInvoice: { invoiceNumber: "OP/26-27/0001", currency: "INR", totalAmountMinor: 11800, status: "ISSUED", revision: 1 },
        taxInvoiceNumber: "OP/26-27/0001"
      } });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/amendments` && request.method() === "GET") {
      return json(route, {
        success: true,
        canRequest: !submitted,
        eligibilityMessage: submitted ? "Resolve the pending amendment request before submitting another." : "",
        amendments: submitted ? [amendmentFixture()] : []
      });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/amendments/preview` && request.method() === "POST") {
      return json(route, {
        success: true,
        pricingImpact: { current: estimate, requested: estimate, deltaAmount: 0 },
        fundingPreview: amendmentFixture().fundingPreview
      });
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/amendments` && request.method() === "POST") {
      submitted = true;
      return json(route, { success: true, amendment: amendmentFixture() }, 200);
    }
    if (path === `/api/v1/operators/${slug}/shipments/${draftId}/cancellation`) {
      return json(route, { success: true, canRequest: false, eligibilityMessage: "", cancellation: null });
    }
    if (path === `/api/v1/operators/${slug}/shipment-amendments` && request.method() === "GET") {
      return json(route, {
        success: true,
        amendments: amendmentReviewed ? [] : [
          {
            ...amendmentFixture(),
            trackingNumber: "OABC123NORTH261000001",
            accountName: "Northstar Parts",
            accountId: "BA-2026-123456",
            consignee: "Asha Shah",
            branch: { id: branchId, name: "North Hub", code: "NORTH" }
          }
        ],
        pagination: { page: 1, pageSize: 25, total: amendmentReviewed ? 0 : 1, totalPages: 1 }
      });
    }
    if (path === `/api/v1/operators/${slug}/shipment-amendments/${amendmentId}/approve` && request.method() === "POST") {
      amendmentReviewed = true;
      return json(route, { success: true, amendment: amendmentFixture("APPROVED") });
    }
    if (path === `/api/v1/operators/${slug}/shipment-amendments/${amendmentId}/reject` && request.method() === "POST") {
      amendmentReviewed = true;
      return json(route, { success: true, amendment: amendmentFixture("REJECTED") });
    }
    return json(route, { success: false, message: `No amendment fixture for ${request.method()} ${path}` }, 404);
  });
}

test("operator client previews and requests an amendment for staff review", async ({ page }) => {
  await mockSession(page, "CLIENT");
  await page.goto(`/portal/${slug}/shipments/${draftId}`);
  await page.getByRole("button", { name: "Request Amendment" }).click();
  await page.getByLabel("Town / City").fill("Pune");
  await page.getByRole("button", { name: "Check Charges" }).click();
  await expect(page.getByText("Difference")).toBeVisible();
  await page.getByRole("button", { name: "Submit Request" }).click();

  await expect(page.getByText("Awaiting operator review")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("operator operations staff can review and apply an amendment", async ({ page }) => {
  await mockSession(page, "OPERATIONS");
  await page.goto(`/portal/${slug}/amendments`);
  await expect(page.getByRole("heading", { name: "Amendment review" })).toBeVisible();
  await expect(page.getByText("OABC123NORTH261000001")).toBeVisible();
  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByText("Requested changes")).toBeVisible();
  await page.getByRole("button", { name: "Approve and apply" }).click();

  await expect(page.getByRole("heading", { name: "No amendment requests need review" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
