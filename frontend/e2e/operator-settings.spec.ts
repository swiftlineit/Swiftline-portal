import { expect, test, type Page, type Route } from "playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const operatorId = "507f1f77bcf86cd799439001";
const branchId = "507f1f77bcf86cd799439031";
let companyName = "Northstar Cargo";
let slug = "northstar-cargo";
let logoUploaded = false;
let logoUpdatedAt = "2026-10-23T10:00:00.000Z";
const logoBuffer = readFileSync(resolve(process.cwd(), "../backend/assets/swiftline-label-logo.png"));
let branch = {
  _id: branchId,
  name: "North Hub",
  code: "NORTH",
  status: "ACTIVE",
  address: {
    address: "10 Market Road",
    city: "Mumbai",
    stateOrProvince: "Maharashtra",
    postalCode: "400001",
    countryName: "India",
    countryCode: "IN"
  },
  contact: { email: "billing@northstar.example", phone: "+919876543210" },
  gstin: "27ABCDE1234F1Z5",
  invoiceSacCode: "996812",
  baseCurrency: "INR"
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockSettings(page: Page) {
  companyName = "Northstar Cargo";
  slug = "northstar-cargo";
  logoUploaded = false;
  logoUpdatedAt = "2026-10-23T10:00:00.000Z";
  branch = {
    ...branch,
    address: { ...branch.address },
    contact: { ...branch.contact }
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "operator-settings-test-token" });

    if (path === `/api/v1/operators/${slug}/me`) return json(route, {
      success: true,
      operator: { id: operatorId, slug, companyName },
      membership: { role: "OPERATOR_ADMIN", assignedBranches: [] },
      access: { mode: "MEMBER", readOnly: false }
    });

    if (/^\/api\/v1\/operators\/[^/]+\/settings$/.test(path) && request.method() === "GET") {
      return json(route, {
        success: true,
        operator: {
          id: operatorId,
          slug,
          companyName,
          logo: logoUploaded ? {
            url: `/api/v1/operators/${slug}/settings/logo`,
            mimeType: "image/png",
            updatedAt: logoUpdatedAt
          } : null
        },
        banners: [],
        branches: [branch],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 }
      });
    }
    if (/^\/api\/v1\/operators\/[^/]+\/settings\/logo$/.test(path) && request.method() === "GET") {
      if (!logoUploaded) return json(route, { success: false, message: "Company logo not found." }, 404);
      return route.fulfill({ status: 200, contentType: "image/png", body: logoBuffer });
    }
    if (/^\/api\/v1\/operators\/[^/]+\/settings\/logo$/.test(path) && request.method() === "PUT") {
      logoUploaded = true;
      logoUpdatedAt = "2026-10-23T10:05:00.000Z";
      return json(route, {
        success: true,
        logo: { url: `/api/v1/operators/${slug}/settings/logo`, mimeType: "image/png", updatedAt: logoUpdatedAt }
      });
    }
    if (/^\/api\/v1\/operators\/[^/]+\/settings\/logo$/.test(path) && request.method() === "DELETE") {
      logoUploaded = false;
      return json(route, { success: true, logo: null });
    }
    if (/^\/api\/v1\/operators\/[^/]+\/settings\/company$/.test(path) && request.method() === "PATCH") {
      const body = request.postDataJSON() as { companyName: string };
      companyName = body.companyName;
      return json(route, { success: true, operator: { id: operatorId, slug, companyName } });
    }
    if (path === `/api/v1/operators/${slug}/settings/slug` && request.method() === "PATCH") {
      const body = request.postDataJSON() as { slug: string };
      slug = body.slug;
      return json(route, { success: true, operator: { id: operatorId, slug, companyName } });
    }
    if (path === `/api/v1/operators/${slug}/branches/${branchId}` && request.method() === "PATCH") {
      const body = request.postDataJSON() as typeof branch;
      branch = { ...branch, ...body };
      return json(route, { success: true, branch });
    }

    return json(route, { success: false, message: `No settings fixture for ${request.method()} ${path}` }, 404);
  });
}

test("operator admin updates workspace identity, branch invoice details, and company logo", async ({ page }) => {
  await mockSettings(page);
  await page.goto(`/portal/${slug}/settings`);

  await page.getByLabel("Company name").fill("Northstar Express");
  await expect(page.getByLabel("Company name")).toHaveValue("Northstar Express");
  const companyUpdate = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/settings/company"));
  await page.getByRole("button", { name: "Save name" }).click();
  const companyUpdatePayload = await (await companyUpdate).json() as { operator?: { companyName?: string } };
  expect(companyUpdatePayload.operator?.companyName).toBe("Northstar Express");
  await expect(page.getByText("Company name saved. New tax invoices will show this name.")).toBeVisible();

  await page.getByRole("button", { name: "Details" }).click();
  const branchDialog = page.getByRole("dialog", { name: "North Hub" });
  await expect(branchDialog).toBeVisible();
  const editBranch = branchDialog.getByRole("button", { name: "Edit", exact: true });
  await expect(editBranch).toHaveAttribute("type", "button");
  await editBranch.click();
  await expect(branchDialog.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await branchDialog.getByLabel("GSTIN").fill("27ABCDE1234F1Z5");
  await branchDialog.getByLabel("Registered address").fill("22 Harbour Road");
  const branchUpdate = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/branches/${branchId}`) && response.request().method() === "PATCH");
  await branchDialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await branchUpdate).ok()).toBe(true);
  await expect(branchDialog.getByLabel("GSTIN")).toHaveValue("27ABCDE1234F1Z5");
  await branchDialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByLabel("Logo file").setInputFiles({
    name: "northstar-logo.png",
    mimeType: "image/png",
    buffer: logoBuffer
  });
  const logoUpdate = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/settings/logo") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Upload logo" }).click();
  expect((await logoUpdate).ok()).toBe(true);
  await expect(page.getByRole("img", { name: "Northstar Express logo" })).toBeVisible();
  await expect(page.getByText("Company logo saved. New tax and shipment invoice PDFs will use this logo.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove logo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update logo" })).toBeVisible();

  await page.getByRole("textbox", { name: "Workspace URL" }).fill("northstar-express");
  const slugUpdate = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/settings/slug"));
  await page.getByRole("button", { name: "Save URL" }).click();
  expect((await slugUpdate).ok()).toBe(true);
  await page.waitForURL("**/portal/northstar-express/settings");
  await expect(page.getByLabel("Company name")).toHaveValue("Northstar Express");

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
