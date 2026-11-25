import { expect, test, type Page } from "playwright/test";

type MockOptions = {
  failFirst?: boolean;
  noFinancialAccess?: boolean;
  populated?: boolean;
  staff?: boolean;
  documentCentre?: boolean;
};

const qaAccount = {
  _id: "offline-account",
  accountId: "BA-QA-001",
  status: "active",
  company: {
    companyName: "QA Exporters",
    registrationCountry: "India",
    registrationId: "ABCDE1234F",
    companyType: "pvt_ltd",
    operatingCountries: ["India"],
    requestedCreditLimit: { currency: "INR", amount: null },
    registeredAddress: "Delhi",
    billingAddress: null
  },
  contact: {
    firstName: "QA",
    lastName: "Client",
    email: "offline@example.test"
  },
  documents: {},
  kycReview: { overallStatus: "verified", checks: {} },
  assignedBranch: { _id: "offline-branch", name: "Delhi", code: "DEL", status: "ACTIVE" },
  depositStatus: "not_required",
  agreementStatus: "not_generated",
  creditLimitStatus: "not_reviewed",
  gstBilling: { requestedTreatment: "GST_APPLICABLE", status: "NOT_REQUIRED", version: 1 },
  createdAt: "2026-10-01T00:00:00.000Z"
};

function paymentRows(populated: boolean, page: number) {
  if (!populated) return [];
  if (page === 1) {
    return [
      {
        _id: "ledger-booking",
        createdAt: "2026-11-21T10:52:00.000Z",
        transactionType: "RAZORPAY_BOOKING_PAYMENT",
        direction: "CREDIT" as const,
        paymentSource: "RAZORPAY",
        status: "ALLOCATED",
        amountMinor: 100_000,
        currency: "INR",
        reference: "pay_qa_booking",
        description: "Online payment captured for booking",
        shipmentDraftId: "qa-shipment",
        shipmentNumber: "SLC-QA-001"
      },
      {
        _id: "ledger-cash",
        createdAt: "2026-11-21T11:15:00.000Z",
        transactionType: "CASH_RECEIPT_RECORDED",
        direction: "CREDIT" as const,
        paymentSource: "CASH_RECEIPT",
        status: "FINALIZED",
        amountMinor: 42_500,
        currency: "INR",
        reference: "CR-QA-001",
        description: "Cash received before booking"
      }
    ];
  }
  return [{
    _id: "ledger-refund",
    createdAt: "2026-11-22T09:30:00.000Z",
    transactionType: "RAZORPAY_REFUND",
    direction: "DEBIT" as const,
    paymentSource: "RAZORPAY",
    status: "REFUNDED",
    amountMinor: 25_000,
    currency: "INR",
    reference: "refund_qa",
    description: "Refunded to original payment method",
    shipmentDraftId: "qa-shipment",
    shipmentNumber: "SLC-QA-001"
  }];
}

async function mockPayments(page: Page, options: MockOptions = {}) {
  const errors: string[] = [];
  const forbiddenRequests: string[] = [];
  const clientLedgerRequests: string[] = [];
  const staffLedgerRequests: string[] = [];
  let clientLedgerCalls = 0;
  let cashReceiptUnreadCount = options.documentCentre ? 1 : 0;

  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) && url.port !== "5000"
      ? route.continue()
      : route.abort("blockedbyclient");
  });

  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (payload: unknown, status = 200) => route.fulfill({ status, json: payload });

    const removedEndpoint =
      path.endsWith("/client/prepaid-topups") ||
      path.endsWith("/client/prepaid-transactions") ||
      path.endsWith("/client/prepaid-account") ||
      path.endsWith("/client/payment-terms") ||
      path.includes("/client/credit") ||
      path.includes("/client/credit-statements") ||
      (path.includes("/prepaid-accounts/") && path.endsWith("/ledger")) ||
      path.endsWith("/cash-receipts");

    if (removedEndpoint) {
      forbiddenRequests.push(path);
      return json({ success: false, message: "Removed payments endpoint must not be used." }, 410);
    }

    if (path.endsWith("/auth/refresh")) return json({ success: true, accessToken: "offline-browser-token" });
    if (path.endsWith("/auth/me")) {
      return json({
        success: true,
        user: {
          id: "offline-user",
          name: options.staff ? "Offline Admin" : "Offline Client",
          email: "offline@example.test",
          role: options.staff ? "admin" : "client"
        }
      });
    }
    if (path.endsWith("/auth/client-workspaces")) return json({ success: true, swiftline: true, operators: [] });
    if (path.endsWith("/client/dashboard")) {
      return json({
        success: true,
        accounts: [{
          membership: { role: options.noFinancialAccess ? "viewer" : "account_owner", status: "active" },
          dashboardAccess: { state: "READY", canBook: true },
          assignedBranches: [{ _id: "offline-branch", name: "Delhi", code: "DEL", status: "active" }],
          account: {
            id: "offline-account",
            accountId: "BA-QA-001",
            status: "active",
            company: { companyName: "QA Exporters", city: "Delhi", stateOrProvince: "Delhi" },
            contact: { firstName: "QA", lastName: "Client", email: "offline@example.test" }
          }
        }]
      });
    }
    if (path.endsWith("/client/account-ledger")) {
      clientLedgerCalls += 1;
      clientLedgerRequests.push(url.search);
      if (options.failFirst && clientLedgerCalls === 1) {
        return json({ success: false, message: "Payments ledger temporarily unavailable. Retry shortly." }, 500);
      }
      const current = Number(url.searchParams.get("page") || 1);
      return json({
        success: true,
        transactions: paymentRows(Boolean(options.populated), current),
        pagination: { page: current, limit: 50, total: options.populated ? 3 : 0, totalPages: options.populated ? 2 : 1 }
      });
    }
    if (path.endsWith("/business-accounts/offline-account")) return json({ success: true, account: qaAccount });
    if (path.endsWith("/business-accounts/offline-account/payments-ledger")) {
      staffLedgerRequests.push(url.search);
      const current = Number(url.searchParams.get("page") || 1);
      return json({
        success: true,
        account: { id: "offline-account", accountId: "BA-QA-001", companyName: "QA Exporters", branchId: "offline-branch" },
        transactions: paymentRows(true, current),
        pagination: { page: current, limit: 50, total: 3, totalPages: 2 }
      });
    }
    if (options.documentCentre && path.endsWith("/client/documents/cash-receipts/unread-count")) {
      return json({ success: true, unreadCount: cashReceiptUnreadCount });
    }
    if (options.documentCentre && path.endsWith("/client/documents")) {
      return json({
        success: true,
        items: [
          { id: "CASH_RECEIPT:qa-receipt", documentType: "CASH_RECEIPT", documentTypeLabel: "Cash Receipt", title: "Cash Receipt", reference: "CR-QA-001", awb: "SLC-QA-001", awbCount: 1, destination: "London", documentDate: "2026-11-21T10:00:00.000Z", format: "PDF", fileName: "CASH-RECEIPT-CR-QA-001.pdf", status: "Finalized", isNew: true, downloadPath: "/api/v1/client/documents/cash-receipts/qa-receipt/pdf?businessAccountId=offline-account", downloadMode: "BLOB" },
          { id: "BILLING_INVOICE:qa-invoice", documentType: "BILLING_INVOICE", documentTypeLabel: "Billing Invoices", title: "Shipment Invoice", reference: "INV-QA-001", awb: "SLC-QA-001", awbCount: 1, destination: "London", documentDate: "2026-11-20T10:00:00.000Z", format: "PDF", fileName: "INV-QA-001.pdf", status: "Paid", isNew: false, downloadPath: "/api/v1/client/shipments/qa-shipment/invoice/pdf", downloadMode: "BLOB" }
        ],
        documentTypes: [],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 }
      });
    }
    if (options.documentCentre && path.includes("/client/documents/cash-receipts/qa-receipt/pdf")) {
      cashReceiptUnreadCount = 0;
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 QA receipt" });
    }
    if (path.endsWith("/notifications")) return json({ success: true, notifications: [], unreadCount: 0 });
    if (path.endsWith("/client/rate-card-shares")) return json({ success: true, shares: [], unreadCount: 0 });
    if (path.endsWith("/client/cash-receipts/unread-count")) return json({ success: true, unreadCount: 1 });
    if (path.includes("service-disruptions")) return json({ success: true, disruptions: [] });
    if (path.includes("regulatory-updates")) return json({ success: true, updates: [] });
    if (path.includes("feature-announcements")) return json({ success: true, announcements: [] });
    return json({ success: true });
  });

  return {
    errors,
    forbiddenRequests: () => forbiddenRequests,
    clientLedgerRequests: () => clientLedgerRequests,
    staffLedgerRequests: () => staffLedgerRequests,
    clientLedgerCalls: () => clientLedgerCalls
  };
}

test("payments distinguish backend failure from permissions and recover on retry", async ({ page }, info) => {
  const mock = await mockPayments(page, { failFirst: true });
  await page.goto("/client/payments");

  const alert = page.getByRole("alert").filter({ hasText: "Unable to load payments" });
  await expect(alert).toBeVisible();
  await expect(alert.getByText("Payments ledger temporarily unavailable. Retry shortly.")).toBeVisible();
  await alert.getByRole("button", { name: "Retry loading payments" }).click();

  await expect(alert).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Payments ledger", exact: true })).toBeVisible();
  await expect(page.getByText("No payments found.")).toBeVisible();
  expect(mock.clientLedgerCalls()).toBeGreaterThanOrEqual(2);
  expect(mock.forbiddenRequests()).toEqual([]);
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("payments-recovered.png"), fullPage: true });
});

test("payments are unavailable when the login has no financial account role", async ({ page }) => {
  const mock = await mockPayments(page, { noFinancialAccess: true });
  await page.goto("/client/payments");

  await expect(page.getByText("Payments are not available for this login.")).toBeVisible();
  expect(mock.clientLedgerCalls()).toBe(0);
  expect(mock.forbiddenRequests()).toEqual([]);
  expect(mock.errors).toEqual([]);
});

test("payments show online, cash and refund activity without wallet controls", async ({ page }, info) => {
  const mock = await mockPayments(page, { populated: true });
  await page.goto("/client/payments");

  const ledger = page.getByRole("region", { name: "Payments ledger" });
  await expect(ledger.getByRole("columnheader", { name: "Method / status" })).toBeVisible();
  await expect(ledger.getByText("Online booking payment")).toBeVisible();
  await expect(ledger.getByText("Cash receipt recorded")).toBeVisible();
  await expect(ledger.getByText("pay_qa_booking", { exact: true })).toBeVisible();
  await expect(ledger.getByRole("link", { name: "Open shipment SLC-QA-001" })).toHaveAttribute("href", "/client/shipments/qa-shipment");
  await expect(page.getByText(/Add wallet funds|Wallet activity|payment terms/i)).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /wallet/i })).toHaveCount(0);

  const pagination = page.getByRole("navigation", { name: "Payments ledger pages" });
  await pagination.getByRole("button", { name: "Next" }).click();
  await expect.poll(() => mock.clientLedgerRequests().some((request) => request.includes("page=2"))).toBe(true);
  await expect(ledger.getByText("Payment refund")).toBeVisible();
  await expect(ledger.getByText("refund_qa", { exact: true })).toBeVisible();
  expect(mock.forbiddenRequests()).toEqual([]);
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("payments-ledger.png"), fullPage: true });
});

test("old prepaid account and credit ledger links land on the staff payments ledger", async ({ page }, info) => {
  const mock = await mockPayments(page, { staff: true });
  await page.goto("/dashboard/prepaid-accounts/offline-account");

  await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard/business-accounts/offline-account");
  expect(page.url()).toContain("tab=ledger");
  expect(page.url()).toContain("#payments-ledger");

  const ledger = page.getByRole("region", { name: "Business account payments ledger" });
  await expect(ledger.getByRole("heading", { name: "Payments ledger" })).toBeVisible();
  await expect(ledger.getByText("Online booking payment")).toBeVisible();
  await expect(ledger.getByText("pay_qa_booking", { exact: true })).toBeVisible();
  await expect(ledger.getByRole("link", { name: "Open shipment SLC-QA-001" })).toHaveAttribute("href", "/dashboard/shipments/qa-shipment");
  await expect(page.getByText(/Available to book|Wallet total|Wallet ledger/i)).toHaveCount(0);
  expect(mock.staffLedgerRequests().length).toBeGreaterThan(0);
  expect(mock.forbiddenRequests()).toEqual([]);
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("staff-payments-ledger.png"), fullPage: true });
});

test("only unread cash receipts receive a badge and document-row highlight", async ({ page }) => {
  await mockPayments(page, { documentCentre: true });
  await page.goto("/client/documents");

  const newReceiptRow = page.locator('[data-document-id="CASH_RECEIPT:qa-receipt"]:visible');
  const invoiceRow = page.locator('[data-document-id="BILLING_INVOICE:qa-invoice"]:visible');
  await expect(newReceiptRow).toHaveClass(/amber/);
  await expect(newReceiptRow.getByText(/New/)).toBeVisible();
  await expect(invoiceRow).not.toHaveClass(/amber/);
  await expect(invoiceRow.getByText(/New/)).toHaveCount(0);
  if (await page.evaluate(() => window.innerWidth < 1024)) await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("link", { name: /Documents Centre.*1/ })).toBeVisible();
  if (await page.evaluate(() => window.innerWidth < 1024)) await page.getByRole("button", { name: "Close menu" }).click();

  await newReceiptRow.getByRole("button", { name: "View" }).click();
  await expect(newReceiptRow.getByText(/New/)).toHaveCount(0);
  await expect(newReceiptRow).not.toHaveClass(/amber/);
  if (await page.evaluate(() => window.innerWidth < 1024)) await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("link", { name: "Documents Centre" })).toBeVisible();
});
