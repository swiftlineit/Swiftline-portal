import { expect, test, type Page } from "playwright/test";

const alphaId = "507f1f77bcf86cd799439011";
const betaId = "507f1f77bcf86cd799439012";
const owners = [
  { _id: alphaId, accountId: "BA-2026-757526", company: { companyName: "Alpha Logistics" }, status: "active" },
  { _id: betaId, accountId: "BA-2026-757527", company: { companyName: "Beta Exports" }, status: "active" }
];
const account = {
  ...owners[0], contact: { title: "mr.", firstName: "Alpha", lastName: "Owner", email: "alpha@example.com", mobileType: "mobile", countryCode: "+91", mobileNumber: "9876543210", jobTitle: "Director", department: "Operations", shipmentTypes: ["international_courier"] },
  company: { ...owners[0]!.company, registrationCountry: "India", registrationId: "ABCDE1234F", companyType: "pvt_ltd", operatingCountries: ["India"], requestedCreditLimit: { currency: "INR", amount: 0 }, registeredAddress: "Delhi", billingAddress: null },
  documents: {}, kycReview: { overallStatus: "verified", checks: {} }, assignedBranch: { _id: "507f1f77bcf86cd799439013", name: "Delhi", code: "DEL", status: "ACTIVE" },
  depositStatus: "not_required", agreementStatus: "not_generated", creditLimitStatus: "not_reviewed",
  gstBilling: { requestedTreatment: "GST_APPLICABLE", status: "NOT_REQUIRED", version: 1 }, createdAt: "2026-10-01T00:00:00.000Z"
};
type ShareRequestPayload = {
  businessAccountId?: string;
  expectedVersion: number;
  title: string;
  channels: string[];
  selection: { countryCodes: string[]; services: string[]; rateIds: string[] };
  adjustmentMode: string;
  adjustmentValue: number;
  terms: { validFrom: string; validUntil: string; remarks: string };
  recipientAccountIds: string[];
  recipientEmails: { email: string; name: string }[];
  recipientPhones: { phone: string; name: string }[];
};

async function mockPortal(page: Page, role = "admin") {
  const writes: Array<Record<string, unknown>> = [];
  const versions: Record<string, number> = { [alphaId]: 1, [betaId]: 1 };
  const added: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith("/auth/refresh")) return json({ success: true, accessToken: "test-token" });
    if (path.endsWith("/auth/me")) return json({ success: true, user: { _id: "507f1f77bcf86cd799439015", role, email: "admin@example.com", firstName: "Test", lastName: "Staff", assignedBranches: [account.assignedBranch] } });
    if (path.includes("/notifications")) return json({ success: true, notifications: [], unreadCount: 0 });
    if (path.endsWith("/account-options")) {
      const q = (url.searchParams.get("search") || "").toLowerCase();
      return json({ success: true, accounts: owners.filter((owner) => (owner.company.companyName + owner.accountId).toLowerCase().includes(q)) });
    }
    if (path.endsWith("/business-accounts/BA-2026-757526")) return json({ success: true, account });
    if (path.endsWith("/country-rate-cards")) {
      const owner = url.searchParams.get("businessAccountId");
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (body.businessAccountId) versions[body.businessAccountId] += 1;
        const rate = { _id: "new-rate-" + added.length, ...body };
        added.push(rate);
        return json({ success: true, rate, version: versions[body.businessAccountId] || 0 });
      }
      const rate = { _id: (owner || "individual") + "-rate", ...(owner ? { businessAccountId: owner } : { band: "BAND_D" }), countryCode: "GB", countryName: "United Kingdom", service: "COURIER", fromKg: 0, toKg: 30, chargesPerKg: owner === betaId ? 600 : 420, maxBoxKg: 30, gstTreatment: "INCLUDED", gstRatePercent: 18, gstApplyToAllRates: false };
      return json({ success: true, version: owner ? versions[owner] : 0, migrationRequired: false, rates: [rate, ...added.filter((item) => item.businessAccountId === owner)] });
    }
    if (path.endsWith("/route-charges")) {
      const owner = url.searchParams.get("businessAccountId");
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON(); writes.push(body);
        if (body.businessAccountId) versions[body.businessAccountId] += 1;
        return json({ success: true, version: versions[body.businessAccountId] || 0, routeCharge: body });
      }
      return json({ success: true, version: owner ? versions[owner] : 0, routeCharges: owner ? [
        { _id: owner + "-courier-charges", businessAccountId: owner, countryCode: "GB", service: "COURIER", fuelSurchargePercent: 10, remoteAreaCharge: 0, remoteAreaPostcodes: [], handlingCharge: 25, insurancePercent: 0, insuranceMinimum: 0, discountPercent: 0 },
        { _id: owner + "-cargo-charges", businessAccountId: owner, countryCode: "GB", service: "CARGO", fuelSurchargePercent: 12, remoteAreaCharge: 0, remoteAreaPostcodes: [], handlingCharge: 7, insurancePercent: 0, insuranceMinimum: 0, discountPercent: 0 }
      ] : [] });
    }
    if (path.endsWith("/profile/image")) return route.fulfill({ status: 404, json: { success: false } });
    return json({ success: true, accounts: [], shares: [], notifications: [], unreadCount: 0, disruptions: [], updates: [], documents: [], members: [], branches: [], overview: {}, activities: [] });
  });
  return writes;
}

async function expectRateCardFieldsUseRoundedLg(page: Page) {
  const fields = await page.locator('form input:not([type="checkbox"]):not([type="file"]):not([type="hidden"]), form select, form textarea')
    .evaluateAll((controls) => controls.map((control) => control.classList.contains("rounded-lg")));
  expect(fields.length).toBeGreaterThan(0);
  expect(fields.every(Boolean)).toBe(true);
}

test("central rate cards keep selector, rates and private route charges together", async ({ page }, info) => {
  const writes = await mockPortal(page);
  await page.goto("/dashboard/country-rate-card");
  const picker = page.getByRole("combobox", { name: "Business account or Individual Clients" });
  await expect(picker).toHaveValue("Individual Clients");
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  const shareButton = page.getByRole("button", { name: "Share", exact: true });
  const addRateButton = page.getByRole("button", { name: "Add rate", exact: true });
  const [shareBox, addRateBox] = await Promise.all([shareButton.boundingBox(), addRateButton.boundingBox()]);
  expect(shareBox).not.toBeNull();
  expect(addRateBox).not.toBeNull();
  expect(Math.abs((shareBox?.x ?? 0) + (shareBox?.width ?? 0) - ((addRateBox?.x ?? 0) + (addRateBox?.width ?? 0)))).toBeLessThanOrEqual(1);
  await expect(page.getByText("Business Account Assignments", { exact: true })).toHaveCount(0);
  await expect(picker).toHaveClass(/rounded-lg/);
  await picker.fill("Alpha");
  await page.getByRole("option", { name: /Alpha Logistics/ }).click();
  await expect(picker).toHaveValue(/Alpha Logistics/);
  await page.getByRole("tab", { name: "Route Charges", exact: true }).click();
  await page.locator("tr").filter({ hasText: "Cargo" }).getByRole("button", { name: "Edit charges", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Cargo", exact: true })).toBeChecked();
  await expect(page.getByRole("spinbutton", { name: /Handling Charge/ })).toHaveValue("7");
  await page.getByRole("spinbutton", { name: /Fuel Surcharge/ }).fill("15");
  await expectRateCardFieldsUseRoundedLg(page);
  await page.screenshot({ path: info.outputPath("route-charge-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "Save Route Charges", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ businessAccountId: alphaId, expectedVersion: 1, fuelSurchargePercent: 15, services: ["CARGO"] });
  expect(writes[0]).not.toHaveProperty("band");
  await page.getByRole("tab", { name: "Rates", exact: true }).click();
  await page.screenshot({ path: info.outputPath("rate-card-workspace.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("adding an inclusive rate preserves the amount and private owner", async ({ page }, info) => {
  const writes = await mockPortal(page, "finance");
  await page.goto("/dashboard/country-rate-card");
  await page.getByRole("combobox", { name: "Business account or Individual Clients" }).fill("Alpha");
  await page.getByRole("option", { name: /Alpha Logistics/ }).click();
  await page.getByRole("button", { name: "Add rate", exact: true }).click();
  await page.getByRole("combobox", { name: /Country/i }).fill("United States");
  await page.getByRole("spinbutton", { name: "From KG", exact: true }).fill("0");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "To KG", exact: true }).fill("30");
  await page.getByRole("spinbutton", { name: "Charges / KG", exact: true }).fill("420");
  await page.getByRole("spinbutton", { name: "Max Box KG", exact: true }).fill("30");
  await page.getByRole("combobox", { name: "GST", exact: true }).selectOption("INCLUDED");
  await page.getByRole("spinbutton", { name: "GST %", exact: true }).fill("18");
  await expect(page.getByText(/Rate-card display preview/)).toContainText("420 GST included (18%)");
  await expectRateCardFieldsUseRoundedLg(page);
  await page.screenshot({ path: info.outputPath("rate-editor.png"), fullPage: true });
  await page.getByRole("button", { name: /Add rate/ }).last().click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ businessAccountId: alphaId, expectedVersion: 1, chargesPerKg: 420, gstTreatment: "INCLUDED", gstRatePercent: 18 });
});

test("the account's Rate Card tab follows Users & Access and shares the editor", async ({ page }) => {
  await mockPortal(page);
  await page.goto("/dashboard/business-accounts/BA-2026-757526#rate-card");
  await expect(page.getByRole("tab", { name: "Rates", exact: true })).toBeVisible();
  await expect(page.getByText("Private business rate card", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Business account or Individual Clients" })).toHaveCount(0);
  const tabs = page.locator("button").filter({ hasText: /^(Users & Access|Rate Card)$/ });
  await expect(tabs).toHaveText(["Users & Access", "Rate Card"]);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByText("Private business rate card", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Rate Card Assignment", { exact: false })).toHaveCount(0);
});

test("sharing a rate card is one step and includes every rate and route charge", async ({ page }, info) => {
  await mockPortal(page);
  const submitted: { payload?: ShareRequestPayload } = {};
  await page.route("**/api/v1/rate-card-shares", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({ json: { success: true, shares: [] } });
    }

    const payload = route.request().postDataJSON() as ShareRequestPayload;
    submitted.payload = payload;
    const recipientPhone = payload.recipientPhones[0]?.phone || "";
    return route.fulfill({
      status: 201,
      json: {
        success: true,
        share: {
          shareNumber: "RC/26-27/00008",
          channels: payload.channels,
          expiresAt: `${payload.terms.validUntil}T18:29:59.999Z`,
        },
        links: {
          view: "https://portal.swiftline.example/rate-card/share?token=test",
          pdf: "https://portal.swiftline.example/rate-card/share?token=test&download=pdf",
          excel: "https://portal.swiftline.example/rate-card/share?token=test&download=excel",
        },
        emailsQueued: 1,
        whatsappLinks: recipientPhone ? [{
          phone: recipientPhone,
          name: "",
          url: "https://wa.me/919876543210?text=Swiftline",
          message: "Swiftline rate card",
        }] : [],
      },
    });
  });
  await page.context().route("https://wa.me/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" }),
  );

  await page.goto("/dashboard/country-rate-card");
  const picker = page.getByRole("combobox", { name: "Business account or Individual Clients" });
  await picker.fill("Alpha");
  await page.getByRole("option", { name: /Alpha Logistics/ }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Share rate card" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/all 1 rate slab across 1 destination/i)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Service", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: "Email" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "WhatsApp" })).not.toBeChecked();

  await dialog.getByLabel("Valid until").fill("2026-12-31");
  await dialog.getByLabel("Terms").fill("Pickup from Delhi NCR is included.");
  await dialog.getByLabel("Email address").fill("buyer@example.com");
  await dialog.getByRole("checkbox", { name: "WhatsApp" }).check();
  await dialog.getByLabel("WhatsApp number").fill("+919876543210");

  const channelOptions = dialog.locator("fieldset > div > label");
  await expect(channelOptions).toHaveCount(2);
  const [emailOption, whatsappOption] = await Promise.all([
    channelOptions.nth(0).boundingBox(),
    channelOptions.nth(1).boundingBox(),
  ]);
  expect(emailOption?.y).toBe(whatsappOption?.y);
  expect((emailOption?.x ?? 0) + (emailOption?.width ?? 0)).toBeLessThan(whatsappOption?.x ?? 0);

  if (info.project.name === "mobile-chromium") {
    const modalSurface = dialog.locator(":scope > div");
    const scrollMetrics = await modalSurface.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.scrollHeight).toBeLessThanOrEqual(scrollMetrics.clientHeight);
  }

  await page.screenshot({ path: info.outputPath("share-rate-card-modal.png"), fullPage: true });

  const popupPromise = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Share rate card", exact: true }).click();
  const whatsapp = await popupPromise;
  await expect(whatsapp).toHaveURL(/wa\.me\/919876543210/);
  const resultDialog = page.getByRole("dialog", { name: "Rate card ready" });
  await expect(resultDialog.getByRole("status")).toContainText("Rate card prepared");
  await expect(resultDialog.getByText("1 email queued.", { exact: true })).toBeVisible();
  await expect(resultDialog.getByText(/Review it and tap Send/)).toBeVisible();

  expect(submitted.payload).toMatchObject({
    businessAccountId: alphaId,
    expectedVersion: 1,
    title: "Alpha Logistics - Rate Card",
    channels: ["EMAIL", "WHATSAPP"],
    selection: { countryCodes: [], services: [], rateIds: [] },
    adjustmentMode: "NONE",
    adjustmentValue: 0,
    terms: { validFrom: expect.any(String), validUntil: "2026-12-31", remarks: "Pickup from Delhi NCR is included." },
    recipientAccountIds: [],
    recipientEmails: [{ email: "buyer@example.com", name: "" }],
    recipientPhones: [{ phone: "+919876543210", name: "" }],
  });
});
