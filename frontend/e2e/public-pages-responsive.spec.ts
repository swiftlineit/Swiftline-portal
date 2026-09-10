import { expect, test } from "playwright/test";

const pages = [
  {
    path: "/track",
    heading: "Track Your Swiftline Shipment",
  },
  {
    path: "/book-shipment-online",
    heading: "Book your Swiftline shipment online",
  },
  {
    path: "/request/business-account",
    heading: "Open a Swiftline Business Shipping Account",
  },
] as const;

test.beforeEach(async ({ page }) => {
  await page.route(
    "http://localhost:5000/api/v1/public/shipment-bookings/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/status")) {
        return route.fulfill({
          status: 404,
          json: { success: false, message: "No existing booking session." },
        });
      }
      if (path.endsWith("/session")) {
        return route.fulfill({
          status: 201,
          json: {
            success: true,
            booking: {
              reference: "WEB-RESPONSIVE-TEST",
              state: "DRAFT",
              revision: 1,
              quote: null,
              shipment: null,
            },
          },
        });
      }
      return route.fulfill({ json: { success: true, prohibitedGoods: [] } });
    },
  );
});

for (const pageDefinition of pages) {
  test(`${pageDefinition.path} stays usable without horizontal overflow`, async ({ page }) => {
    await page.goto(pageDefinition.path);
    await expect(page.getByRole("heading", { name: pageDefinition.heading })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
