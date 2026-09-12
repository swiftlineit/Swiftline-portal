import { expect, test } from "playwright/test";

const account = {
  _id: "507f1f77bcf86cd799439011",
  accountId: "BA-DROP-TEST",
  status: "draft",
  contact: {
    title: "mr.",
    firstName: "Drag",
    lastName: "Test",
    email: "drag.test@example.com",
    mobileType: "mobile",
    countryCode: "+91",
    mobileNumber: "9876543210",
    jobTitle: "Director",
    department: "Operations",
    shipmentTypes: ["international_courier"],
  },
  company: {
    registrationCountry: "India",
    registrationIdType: "pan",
    registrationId: "ABCDE1234F",
    gstin: "",
    gstExempt: true,
    gstExemptReason: "Not registered for GST",
    noCompanyRegistration: false,
    noCompany: false,
    companyType: "Private Limited",
    companyName: "Drag Test Logistics",
    registeredAddress: "1 Test Road",
    addressLine2: "",
    city: "New Delhi",
    stateOrProvince: "Delhi",
    postalCode: "110001",
    addressCountry: "India",
    useCompanyAddressAsBillingAddress: true,
    billingAddress: null,
    operatingCountries: ["India"],
    industry: "Logistics",
    monthlyShipmentVolume: "1-10",
    requestedCreditLimit: { currency: "INR", amount: null },
  },
  documents: {},
  gstBilling: {
    requestedTreatment: "GST_APPLICABLE",
    status: "NOT_REQUIRED",
    requestReason: "",
    decisionReason: "",
    version: 1,
  },
  createdAt: "2026-09-11T00:00:00.000Z",
};

test("accepts dropped PDF and image documents in the internal account form", async ({ page }) => {
  await page.route("**/api/v1/auth/refresh", async (route) => {
    await route.fulfill({ json: { success: true, accessToken: "test-access-token" } });
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({ json: { success: true, user: { email: "admin@example.com", role: "admin" } } });
  });
  await page.route("**/api/v1/business-accounts/validate-unique**", async (route) => {
    await route.fulfill({
      json: {
        success: true,
        conflicts: { email: false, mobileNumber: false, registrationId: false },
      },
    });
  });
  await page.route("**/api/v1/business-accounts/BA-DROP-TEST", async (route) => {
    await route.fulfill({ json: { success: true, account } });
  });

  await page.goto("/dashboard/business-accounts/BA-DROP-TEST/edit");
  await page.getByRole("button", { name: "3. Upload Documents" }).click();

  const aadhaarDropZone = page.locator('label[for="document-upload-aadhaarCard"]');
  const aadhaarTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-1.4"], "aadhaar-card.pdf", { type: "application/pdf" }));
    return transfer;
  });
  await aadhaarDropZone.dispatchEvent("dragenter", { dataTransfer: aadhaarTransfer });
  await expect(aadhaarDropZone).toHaveClass(/border-\[\#0D1282\]/);
  await aadhaarDropZone.dispatchEvent("drop", { dataTransfer: aadhaarTransfer });
  await expect(page.getByText("aadhaar-card.pdf", { exact: true })).toBeVisible();

  const panDropZone = page.locator('label[for="document-upload-panCard"]');
  const panTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pan-card.png", { type: "image/png" }));
    return transfer;
  });
  await panDropZone.dispatchEvent("drop", { dataTransfer: panTransfer });
  await expect(page.getByText("pan-card.png", { exact: true })).toBeVisible();
  await expect(page.getByText("Complete these to continue")).toHaveCount(0);
});
