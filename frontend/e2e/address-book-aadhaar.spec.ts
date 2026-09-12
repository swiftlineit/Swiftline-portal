import { expect, test } from "playwright/test";

const entry = {
  id: "507f1f77bcf86cd799439012",
  type: "SENDER",
  label: "Delhi Sender",
  isFavourite: false,
  companyName: "EXAMPLE EXPORTERS",
  contactName: "RAVI KUMAR",
  email: "ravi@example.com",
  mobileCountryCode: "+91",
  mobileNumber: "9876543210",
  hasAadhaarNumber: true,
  aadhaarNumberMasked: "XXXX XXXX 0124",
  countryCode: "IN",
  countryName: "India",
  addressLine1: "10 MARKET ROAD",
  addressLine2: "",
  townOrCity: "DELHI",
  county: "DELHI",
  postcode: "110001",
  instructions: "",
  providerPlaceId: "",
  validationStatus: "NOT_VALIDATED",
  validationProvider: "",
  validationMessage: "",
  suggestedAddress: null,
  validatedAt: null,
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
};

test("masks and reveals a saved sender Aadhaar with the eye control", async ({ page }) => {
  await page.route("http://localhost:5000/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/refresh")) {
      return route.fulfill({ json: { success: true, accessToken: "test-token" } });
    }
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: { success: true, user: { id: "user-1", name: "Test User", email: "test@example.com", role: "client" } } });
    }
    if (path.endsWith("/client/dashboard")) {
      return route.fulfill({
        json: {
          success: true,
          accounts: [{
            membership: { role: "account_owner", status: "active" },
            account: { id: "507f1f77bcf86cd799439011", assignedBranch: null },
            dashboardAccess: { state: "READY", blockers: [] },
            bookingAccess: { state: "READY", code: null, message: null },
            assignedBranches: [{ _id: "507f1f77bcf86cd799439013", name: "Delhi" }],
          }],
        },
      });
    }
    if (path.endsWith(`/client/address-book/${entry.id}/aadhaar/reveal`)) {
      return route.fulfill({ json: { success: true, aadhaarNumber: "234567890124" } });
    }
    if (path.endsWith("/client/address-book")) {
      return route.fulfill({
        json: { success: true, entries: [entry], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } },
      });
    }
    return route.fulfill({ json: { success: true, notifications: [], unreadCount: 0 } });
  });

  await page.goto("/client/address-book");

  await expect(page.getByText("XXXX XXXX 0124", { exact: true })).toBeVisible();
  await expect(page.getByText("2345 6789 0124", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Show Aadhaar number" }).click();
  await expect(page.getByText("2345 6789 0124", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Hide Aadhaar number" }).click();
  await expect(page.getByText("XXXX XXXX 0124", { exact: true })).toBeVisible();
  await expect(page.getByText("2345 6789 0124", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Add Address" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Address" });
  await dialog.getByLabel("Address Type *").selectOption("SENDER");
  await expect(dialog.getByLabel("Aadhaar Number (optional)")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Show Aadhaar number" })).toBeVisible();
});
