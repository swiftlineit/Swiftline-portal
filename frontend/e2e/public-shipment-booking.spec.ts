import { expect, test, type Page } from "playwright/test";

const booking = (state = "DRAFT") => ({
  reference: "WEB-20260908-ABCD1234",
  state,
  revision: 2,
  quote: null,
  shipment:
    state === "BOOKED"
      ? {
          trackingNumber: "SLCDEL080926001",
          invoiceUrl: "/invoice",
          labelsUrl: "/labels",
        }
      : null,
});

async function mockApis(page: Page) {
  let sessionStarts = 0;
  let paymentCompleted = false;
  await page.route(
    "http://localhost:5000/api/v1/public/shipment-bookings/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/policies"))
        return route.fulfill({
          json: {
            success: true,
            prohibitedGoods: [
              "Alcohol / Liquor",
              "Cash / Currency",
              "Loose Battery / Power Bank",
              "Explosives / Fireworks",
            ],
          },
        });
      if (path.endsWith("/status"))
        return route.fulfill({
          status: paymentCompleted ? 200 : 401,
          json: paymentCompleted
            ? { success: true, booking: booking("BOOKED") }
            : { success: false, message: "No existing booking session." },
        });
      if (path.endsWith("/session")) {
        sessionStarts += 1;
        paymentCompleted = false;
        return route.fulfill({
          status: 201,
          json: { success: true, booking: booking() },
        });
      }
      if (path.endsWith("/reference/hs-codes"))
        return route.fulfill({
          json: {
            success: true,
            suggestions: [
              { code: "62052000", description: "Men's cotton shirts" },
            ],
          },
        });
      if (path.endsWith("/address-lookup/autocomplete"))
        return route.fulfill({
          json: {
            success: true,
            provider: "google",
            predictions: [
              {
                placeId: "place-1",
                text: "10 Downing Street, London",
                mainText: "10 Downing Street",
                secondaryText: "London, United Kingdom",
              },
            ],
          },
        });
      if (path.includes("/address-lookup/places/"))
        return route.fulfill({
          json: {
            success: true,
            address: {
              addressLine1: "10 Downing Street",
              addressLine2: "",
              city: "London",
              state: "Greater London",
              postalCode: "SW1A 1AA",
              countryCode: "GB",
              countryName: "United Kingdom",
            },
          },
        });
      if (path.endsWith("/draft"))
        return route.fulfill({
          json: { success: true, booking: booking(), validationIssues: [] },
        });
      if (path.endsWith("/quote"))
        return route.fulfill({
          json: {
            success: true,
            booking: {
              ...booking("QUOTED"),
              quote: {
                amountMinor: 236000,
                currency: "INR",
                pricingHash: "hash",
                expiresAt: "2026-09-08T12:30:00.000Z",
              },
            },
            quote: {
              amountMinor: 236000,
              currency: "INR",
              pricingHash: "hash",
              expiresAt: "2026-09-08T12:30:00.000Z",
              parcels: [
                {
                  sequence: 1,
                  actualWeightKg: 2,
                  volumetricWeightKg: 0.6,
                  chargeableWeightKg: 2,
                },
              ],
              lines: [
                {
                  code: "FREIGHT",
                  label: "Freight",
                  kind: "CHARGE",
                  amountMinor: 200000,
                  basis: "2 kg",
                },
                {
                  code: "GST",
                  label: "GST 18%",
                  kind: "TAX",
                  amountMinor: 36000,
                  basis: "18%",
                },
              ],
              totalWeightKg: 2,
              totalVolumetricWeightKg: 0.6,
              totalChargeableWeightKg: 2,
            },
          },
        });
      if (path.endsWith("/payments/order"))
        return route.fulfill({
          status: 201,
          json: {
            success: true,
            order: {
              id: "order_test",
              amountMinor: 236000,
              currency: "INR",
              keyId: "rzp_test",
              bookingReference: "WEB-20260908-ABCD1234",
            },
          },
        });
      if (path.endsWith("/payments/confirm")) {
        paymentCompleted = true;
        return route.fulfill({
          json: { success: true, booking: booking("BOOKED") },
        });
      }
      return route.fulfill({ json: { success: true } });
    },
  );
  return { sessionStarts: () => sessionStarts };
}

async function completeAddressStep(page: Page) {
  const sender = page.getByRole("region", { name: "Sender details" });
  await expect(sender.getByText("Confirm sender email", { exact: true })).toHaveCount(0);
  await sender.getByLabel("Contact name").fill("Ravi Kumar");
  await sender.locator('input[type="email"]').nth(0).fill("ravi@example.com");
  await sender.getByLabel("Mobile number").fill("9876543210");
  await sender.getByLabel("PIN code").fill("110001");
  await sender.getByLabel("Address line 1").fill("10 Market Road");
  await sender.getByLabel("Town / city").fill("Delhi");
  await sender.getByLabel("Aadhaar number").fill("234567890124");
  const receiver = page.getByRole("region", { name: "Receiver details" });
  await receiver.getByLabel("Contact name").fill("Alex Smith");
  await receiver.getByLabel("Email").fill("alex@example.com");
  await receiver.getByLabel("Mobile number").fill("7400123456");
  await receiver.locator('button[aria-label="Country"]').click();
  await page.keyboard.type("United Kingdom");
  await page.keyboard.press("Enter");
  await expect(receiver.locator('button[aria-label="Country"]')).toContainText(
    "United Kingdom",
  );
  await receiver.getByLabel("Address line 1").fill("10 Down");
  await page.getByRole("button", { name: /10 Downing Street/ }).click();
  await expect(receiver.getByLabel("Postal code")).toHaveValue("SW1A 1AA");
  await expect(receiver.getByLabel("Town / city")).toHaveValue("London");
  await page.getByRole("button", { name: "Continue" }).click();
}

let mockedApi: Awaited<ReturnType<typeof mockApis>>;

test.beforeEach(async ({ page }) => {
  mockedApi = await mockApis(page);
  await page.addInitScript(() => {
    class RazorpayMock {
      options: {
        handler: (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => void;
      };
      constructor(options: RazorpayMock["options"]) {
        this.options = options;
      }
      open() {
        void this.options.handler({
          razorpay_order_id: "order_test",
          razorpay_payment_id: "pay_test",
          razorpay_signature: "signature_test",
        });
      }
    }
    Object.defineProperty(window, "Razorpay", {
      value: RazorpayMock,
      configurable: true,
    });
  });
});

test("books and pays for a public shipment", async ({ page }, testInfo) => {
  await page.goto("/book-shipment-online");
  await expect(page).toHaveTitle(/Book an International Shipment Online/);
  await completeAddressStep(page);
  await page
    .getByRole("button", { name: "View prohibited and restricted items" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Prohibited and restricted goods" }),
  ).toContainText("Loose Battery / Power Bank");
  await page
    .getByRole("dialog", { name: "Prohibited and restricted goods" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByLabel("Actual weight (kg)").fill("2");
  await page.getByLabel("Length (cm)").fill("20");
  await page.getByLabel("Width (cm)").fill("15");
  await page.getByLabel("Height (cm)").fill("10");
  await page.getByLabel("Description").fill("Cotton shirts");
  await page.getByLabel("Unit value (₹)").fill("1000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Confirm before pricing")).toBeVisible();
  await page.getByLabel(/I accept the online booking terms/).check();
  await page.getByLabel(/I have read the cancellation/).check();
  await page.getByLabel(/I confirm the shipment contains no/).check();
  await page.getByRole("button", { name: "Calculate final quote" }).click();
  await expect(page.getByText("₹2,360.00", { exact: true })).toBeVisible();
  await expect(page.getByText("Freight cost", { exact: true })).toBeVisible();
  await expect(page.getByText("GST (18%)", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `../.impeccable/review/public-booking-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: /Pay ₹2,360.00/ }).click();
  await expect(page).toHaveURL(/\/book-shipment-online\/status$/);
  await expect(
    page.getByRole("heading", { name: "Your shipment is ready" }),
  ).toBeVisible();
  await expect(page.getByText("SLCDEL080926001")).toBeVisible();
  await expect(page.getByRole("link", { name: "Get help" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to book shipment" }).click();
  await expect.poll(() => mockedApi.sessionStarts()).toBe(2);
  await expect(page.getByRole("region", { name: "Sender details" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your shipment is ready" })).toHaveCount(0);
});

test("company selection requires a company name", async ({ page }) => {
  await page.goto("/book-shipment-online");
  const sender = page.getByRole("region", { name: "Sender details" });
  await sender.getByText("Company", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText("Company name is required.", { exact: true }),
  ).toBeVisible();
  await expect(sender.getByLabel("Company name")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("validates a destination phone before the quote step", async ({
  page,
}) => {
  await page.goto("/book-shipment-online");
  const receiver = page.getByRole("region", { name: "Receiver details" });
  await receiver.getByLabel("Mobile number").fill("0000000000");
  await receiver.getByLabel("Email").focus();
  await expect(
    page.getByText(
      "Enter a valid mobile number for the selected country code",
      { exact: true },
    ),
  ).toHaveCount(1);
});

test("does not advance when the persisted draft fails quote validation", async ({
  page,
}) => {
  await page.route("**/api/v1/public/shipment-bookings/draft", (route) =>
    route.fulfill({
      json: {
        success: true,
        booking: booking(),
        validationIssues: ["Receiver address could not be validated."],
      },
    }),
  );
  await page.goto("/book-shipment-online");
  await completeAddressStep(page);
  await page.getByLabel("Actual weight (kg)").fill("2");
  await page.getByLabel("Length (cm)").fill("20");
  await page.getByLabel("Width (cm)").fill("15");
  await page.getByLabel("Height (cm)").fill("10");
  await page.getByLabel("Description").fill("Cotton shirts");
  await page.getByLabel("Unit value (₹)").fill("1000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText("Receiver address could not be validated.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Dimensions and contents", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Confirm before pricing")).toHaveCount(0);
});

test("shows country flags, address suggestions and HS-code search", async ({
  page,
}) => {
  await page.goto("/book-shipment-online");
  const sender = page.getByRole("region", { name: "Sender details" });
  await expect(sender.locator("img").first()).toBeVisible();
  await completeAddressStep(page);
  await page.getByLabel("Description").fill("Cotton shirts");
  await page.getByLabel("HS code").focus();
  await expect(page.getByRole("button", { name: /62052000/ })).toBeVisible();
  await page.getByRole("button", { name: /62052000/ }).click();
  await expect(page.getByLabel("HS code")).toHaveValue("62052000");
});

test("mobile layout has no horizontal overflow", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"));
  await page.goto("/book-shipment-online");
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(
    page.getByRole("heading", { name: "Sender details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Receiver details" }),
  ).toBeVisible();
});
