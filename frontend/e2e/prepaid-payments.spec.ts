import { expect, test, type Page } from "playwright/test";

async function mockPayments(page: Page, options: { failFirst?: boolean; noFinancialAccess?: boolean; populated?: boolean; staff?: boolean; standaloneReceipts?: boolean; documentCentre?: boolean } = {}) {
  let walletCalls = 0;
  const walletActivityRequests: Array<{ page: string; limit: string }> = [];
  let legacyCreditCalls = 0;
  const cashReceiptPosts: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  let cashReceiptUnreadCount = options.documentCentre ? 1 : 0;
  const qaAccount = {
    _id: "offline-account", accountId: "BA-QA-001", status: "active",
    company: { companyName: "QA Exporters", requestedCreditLimit: { currency: "INR", amount: null } },
    contact: { firstName: "QA", lastName: "Client", email: "offline@example.test" },
    assignedBranch: { _id: "offline-branch", name: "Delhi", code: "DEL" }
  };
  const qaCashReceipt = (number: number) => ({
    id: `cash-qa-${number}`, receiptNumber: `CR-QA-${String(number).padStart(3, "0")}`, receiptType: "STANDALONE", status: "FINALIZED",
    businessAccountId: qaAccount._id, branchId: "offline-branch", shipmentDraftId: null, totalReceivedMinor: 42_500,
    customerName: "QA Exporters", receiptDate: "2026-11-21T10:00:00.000Z", accountId: qaAccount.accountId, destination: "",
    service: "COURIER", pieces: 2, weightKg: 4.25, customerReference: "PO-77", cashCustodyReference: `CASH-QA-${number}`,
    createdByName: "Offline Staff", issuedAt: "2026-11-21T10:00:00.000Z"
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // The browser can load local Next assets only. All API traffic is fulfilled
  // below; external requests (including gateway and carrier scripts) are denied.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) && url.port !== "5000"
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (payload: unknown, status = 200) => route.fulfill({ status, json: payload });
    if (path.includes("/client/credit") || path.includes("/client/credit-statements")) {
      legacyCreditCalls += 1;
      return json({ success: false, message: "Legacy credit endpoints must not be used." }, 410);
    }
    if (path.endsWith("/auth/refresh")) return json({ success: true, accessToken: "offline-browser-token" });
    if (path.endsWith("/auth/me")) return json({ success: true, user: { id: "offline-client", name: options.staff ? "Offline Admin" : "Offline Client", email: "offline@example.test", role: options.staff ? "admin" : "client" } });
    if (path.endsWith("/auth/client-workspaces")) return json({ success: true, swiftline: true, operators: [] });
    if (options.standaloneReceipts && path.endsWith("/business-accounts")) return json({ success: true, accounts: [qaAccount] });
    if (options.standaloneReceipts && path.endsWith("/cash-receipts")) {
      if (route.request().method() === "POST") {
        cashReceiptPosts.push(JSON.parse(route.request().postData() || "{}") as Record<string, unknown>);
        return json({ success: true, duplicate: false, receipt: qaCashReceipt(1) }, 201);
      }
      const current = Number(new URL(route.request().url()).searchParams.get("page") || 1);
      const receipts = current === 1 ? Array.from({ length: 5 }, (_, index) => qaCashReceipt(index + 1)) : [qaCashReceipt(6)];
      return json({ success: true, receipts, pagination: { page: current, limit: 5, total: 6, totalPages: 2 } });
    }
    if (path.endsWith("/client/dashboard")) return json({ success: true, accounts: [{
      membership: { role: options.noFinancialAccess ? "viewer" : "account_owner", status: "active" },
      dashboardAccess: { state: "READY", canBook: true },
      assignedBranches: [{ _id: "offline-branch", name: "Delhi", code: "DEL", status: "active" }],
      account: { id: "offline-account", accountId: "OFF-001", status: "active", company: { companyName: "Offline Exporters", city: "Delhi", stateOrProvince: "Delhi" }, contact: { firstName: "Offline", lastName: "Client", email: "offline@example.test" } }
    }] });
    if (options.documentCentre && path.endsWith("/client/documents/cash-receipts/unread-count")) {
      return json({ success: true, unreadCount: cashReceiptUnreadCount });
    }
    if (options.documentCentre && path.endsWith("/client/documents")) return json({
      success: true,
      items: [
        { id: "CASH_RECEIPT:qa-receipt", documentType: "CASH_RECEIPT", documentTypeLabel: "Cash Receipt", title: "Cash Receipt", reference: "CR-QA-001", awb: "SLC-QA-001", awbCount: 1, destination: "London", documentDate: "2026-11-21T10:00:00.000Z", format: "PDF", fileName: "CASH-RECEIPT-CR-QA-001.pdf", status: "Finalized", isNew: true, downloadPath: "/api/v1/client/documents/cash-receipts/qa-receipt/pdf?businessAccountId=offline-account", downloadMode: "BLOB" },
        { id: "BILLING_INVOICE:qa-invoice", documentType: "BILLING_INVOICE", documentTypeLabel: "Billing Invoices", title: "Shipment Invoice", reference: "INV-QA-001", awb: "SLC-QA-001", awbCount: 1, destination: "London", documentDate: "2026-11-20T10:00:00.000Z", format: "PDF", fileName: "INV-QA-001.pdf", status: "Paid", isNew: false, downloadPath: "/api/v1/client/shipments/qa-shipment/invoice/pdf", downloadMode: "BLOB" }
      ],
      documentTypes: [],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 }
    });
    if (options.documentCentre && path.includes("/client/documents/cash-receipts/qa-receipt/pdf")) {
      cashReceiptUnreadCount = 0;
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4 QA receipt" });
    }
    if (path.endsWith("/client/payment-terms")) return json({ success: true, terms: { version: "offline-v1", title: "Payment terms", content: "Offline payment terms", publishedAt: "2026-11-20T00:00:00.000Z" } });
    if (path.endsWith("/client/prepaid-topups")) {
      const current = Number(new URL(route.request().url()).searchParams.get("page") || 1);
      return json({ success: true, topUps: options.populated ? Array.from({ length: current === 1 ? 5 : 1 }, (_, i) => ({ id: 'receipt-' + ((current - 1) * 5 + i + 1), internalReference: 'TOPUP-QA-' + ((current - 1) * 5 + i + 1), purpose: 'CUSTOMER_ADVANCE', amountMinor: 100000, currency: 'INR', status: 'CAPTURED', createdAt: '2026-11-21T10:52:00.000Z', razorpayOrderId: 'order_qa', razorpayPaymentId: 'pay_qa' })) : [], pagination: { page: current, limit: 5, total: options.populated ? 6 : 0, totalPages: options.populated ? 2 : 1 } });
    }
    if (path.endsWith("/client/prepaid-transactions")) {
      const url = new URL(route.request().url());
      const currentPage = url.searchParams.get("page") || "1";
      const limit = url.searchParams.get("limit") || "";
      walletActivityRequests.push({ page: currentPage, limit });
      return json({ success: true, transactions: options.populated ? [{ _id: `wallet-qa-${currentPage}`, createdAt: '2026-11-21T10:52:00.000Z', transactionType: 'SHIPMENT_PAYMENT_COMPLETED', direction: 'DEBIT', amountMinor: 10000, currency: 'INR', cashBalanceAfterMinor: 4000000, reservedBalanceAfterMinor: 0, shipmentDraftId: 'qa-shipment', shipmentNumber: 'SLC-QA-001' }] : [], pagination: { page: Number(currentPage), limit: 50, total: options.populated ? 51 : 0, totalPages: options.populated ? 2 : 1 } });
    }
    if (path.endsWith('/client/account-ledger')) return json({ success: true, transactions: [{ _id: 'gateway-qa', createdAt: '2026-11-21T10:52:00.000Z', transactionType: 'RAZORPAY_BOOKING_PAYMENT', direction: 'CREDIT', paymentSource: 'RAZORPAY', status: 'ALLOCATED', amountMinor: 10000, currency: 'INR', reference: 'pay_qa_booking', shipmentDraftId: 'qa-shipment', shipmentNumber: 'SLC-QA-001' }], pagination: { page: 1, limit: 50, total: 1, totalPages: 1 } });
    if (path.endsWith('/prepaid-accounts/offline-account/ledger')) return json({ success: true, account: { id: 'offline-account', companyName: 'QA Exporters', accountId: 'BA-QA-001' }, wallet: { currency: 'INR', availableBalanceMinor: 4000000, cashBalanceMinor: 5000000, reservedBalanceMinor: 1000000 }, transactions: [{ _id: 'gateway-staff', createdAt: '2026-11-21T10:52:00.000Z', transactionType: 'RAZORPAY_BOOKING_PAYMENT', direction: 'CREDIT', paymentSource: 'RAZORPAY', status: 'ALLOCATED', amountMinor: 10000, currency: 'INR', reference: 'pay_qa_booking', shipmentDraftId: 'qa-shipment', shipmentNumber: 'SLC-QA-001' }], pagination: { page: 1, limit: 50, total: 1, totalPages: 1 } });
    if (path.endsWith("/client/prepaid-account")) {
      walletCalls += 1;
      if (options.failFirst && walletCalls === 1) return json({ success: false, message: "Wallet temporarily unavailable. Retry shortly." }, 500);
      return json({ success: true, prepaidAccount: { businessAccountId: "offline-account", currency: "INR", cashBalanceMinor: 5_000_000, reservedBalanceMinor: 1_000_000, availableBalanceMinor: 4_000_000, status: "ACTIVE", minimumBalanceWarningMinor: 0, minTopUpMinor: 10_000, maxTopUpMinor: 10_000_000, dailyTopUp: { limitMinor: 50_000_000, remainingMinor: 50_000_000, usedMinor: 0 } } });
    }
    if (path.endsWith("/notifications")) return json({ success: true, notifications: [], unreadCount: 0 });
    if (path.endsWith("/client/rate-card-shares")) return json({ success: true, shares: [], unreadCount: 0 });
    if (path.endsWith("/client/cash-receipts/unread-count")) return json({ success: true, unreadCount: 1 });
    if (path.includes("service-disruptions")) return json({ success: true, disruptions: [] });
    if (path.includes("regulatory-updates")) return json({ success: true, updates: [] });
    if (path.includes("feature-announcements")) return json({ success: true, announcements: [] });
    return json({ success: true });
  });
  return { errors, walletCalls: () => walletCalls, walletActivityRequests: () => walletActivityRequests, cashReceiptPosts: () => cashReceiptPosts, legacyCreditCalls: () => legacyCreditCalls };
}

test("payments distinguish backend failure from permissions and recover on retry", async ({ page }, info) => {
  const mock = await mockPayments(page, { failFirst: true });
  await page.goto("/client/payments");
  await expect(page.getByRole("alert").filter({ hasText: "Unable to load wallet balances" })).toBeVisible();
  await expect(page.getByText("Account balances are not available for this login.")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry loading balances" }).click();
  await expect(page.getByRole("heading", { name: "Available to book" })).toBeVisible();
  await expect(page.getByText(/Per payment|Today .* used/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available to book" }).locator("..")).not.toHaveClass(/bg-blue-900/);
  await expect(page.getByRole("heading", { name: "Wallet total" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Held for bookings" })).toBeVisible();
  await expect(page.getByText(/credit|dues|statements/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Top up with Razorpay" })).toBeDisabled();
  expect(mock.walletCalls()).toBe(2);
  expect(mock.legacyCreditCalls()).toBe(0);
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("prepaid-payments-recovered.png"), fullPage: true });
});

test("payments show one clear available balance, wallet activity and Razorpay terms", async ({ page }, info) => {
  const mock = await mockPayments(page);
  await page.goto("/client/payments");
  await expect(page.getByRole("heading", { name: "Available to book" })).toBeVisible();
  await expect(page.getByText(/Per payment|Today .* used/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available to book" }).locator("..")).not.toHaveClass(/bg-blue-900/);
  await expect(page.getByText(/40,000\.00/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wallet total" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Held for bookings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add wallet funds" })).toBeVisible();
  await expect(page.getByText("Add funds securely through Razorpay.")).toBeVisible();
  await expect(page.getByRole("link", { name: "payment terms" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wallet activity" })).toBeVisible();
  await expect(page.getByText("No transactions found.")).toBeVisible();
  await page.getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: "Top up with Razorpay" })).toBeEnabled();
  await expect(page.getByText(/credit|dues|statements/i)).toHaveCount(0);
  expect(mock.legacyCreditCalls()).toBe(0);
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("prepaid-payments.png"), fullPage: true });
});


test('populated payments paginate receipts and link wallet and gateway entries to shipments', async ({ page }, info) => {
  const mock = await mockPayments(page, { populated: true });
  await page.goto('/client/payments');
  const receipts = page.getByRole('region', { name: 'Payment receipts' });
  await expect(receipts.getByRole('button', { name: 'View', exact: true })).toHaveCount(5);
  await expect(receipts.getByRole('button', { name: /Print|Download/ })).toHaveCount(0);
  await expect(receipts.getByText(/Wallet top-up on/)).toHaveCount(5);
  if (await page.evaluate(() => window.innerWidth >= 1024)) {
    const topUpHeight = await page.locator('#add-money').evaluate((element) => element.getBoundingClientRect().height);
    const receiptHeight = await receipts.evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(topUpHeight - receiptHeight)).toBeLessThan(2);
  }
  await expect(page.getByRole('link', { name: 'Open shipment SLC-QA-001' })).toHaveAttribute('href', '/client/shipments/qa-shipment');
  const walletNavigation = page.getByRole('navigation', { name: 'Payment activity pages' });
  await expect(walletNavigation.getByRole('button', { name: 'Next' })).toBeEnabled();
  await walletNavigation.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => mock.walletActivityRequests().some((request) => request.page === '2')).toBe(true);
  await receipts.getByRole('button', { name: 'Next' }).click();
  await expect(receipts.getByText('TOPUP-QA-6', { exact: true })).toBeVisible();
  await expect(receipts.getByRole('button', { name: 'View', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'All transactions' }).click();
  await expect(page.getByText('pay_qa_booking', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account ledger', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open shipment SLC-QA-001' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('populated-payments.png'), fullPage: true });
});

test('staff account ledger shows Razorpay booking payments with a compact balance summary', async ({ page }, info) => {
  const mock = await mockPayments(page, { staff: true });
  await page.goto('/dashboard/prepaid-accounts/offline-account');
  await expect(page.getByRole('heading', { name: 'QA Exporters' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Business Accounts/ })).toHaveCount(0);
  await expect(page.getByText('pay_qa_booking', { exact: true })).toBeVisible();
  const refreshBox = await page.getByRole('button', { name: 'Refresh' }).boundingBox();
  const exportBox = await page.getByRole('button', { name: 'Export ledger' }).boundingBox();
  expect(refreshBox?.width).toBe(exportBox?.width);
  await expect(page.getByRole('heading', { name: 'Available to book' }).locator('..')).not.toHaveClass(/bg-blue-900/);
  await expect(page.getByRole('link', { name: 'Open shipment SLC-QA-001' })).toHaveAttribute('href', '/dashboard/shipments/qa-shipment');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('staff-account-ledger.png'), fullPage: true });
});

test('standalone receipt form and staff history are compact, editable and paginated', async ({ page }, info) => {
  const mock = await mockPayments(page, { staff: true, standaloneReceipts: true });
  await page.goto('/dashboard/cash-receipts');
  await expect(page.getByRole('heading', { name: 'Create a standalone receipt' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Standalone receipt history' })).toBeVisible();
  const receiptTable = page.getByRole('table');
  await expect(receiptTable.getByRole('columnheader')).toHaveText(['Receipt', 'Received from', 'Download']);
  await expect(receiptTable.getByRole('row')).toHaveCount(6);
  await expect(receiptTable.getByText('CR-QA-001', { exact: true })).toBeVisible();
  await expect(receiptTable.getByText('Shipment details', { exact: true })).toHaveCount(0);
  await expect(receiptTable.getByText('Amount', { exact: true })).toHaveCount(0);
  await expect(receiptTable.getByText('Recorded by', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('From date')).toBeVisible();
  await expect(page.getByLabel('To date')).toBeVisible();
  const filterBoxes = await Promise.all([
    page.getByLabel('From date').locator('xpath=..').boundingBox(),
    page.getByLabel('To date').locator('xpath=..').boundingBox(),
    page.getByRole('button', { name: 'Export CSV' }).boundingBox()
  ]);
  if (await page.evaluate(() => window.innerWidth >= 1280)) {
    expect(filterBoxes.every((box) => box !== null)).toBe(true);
    expect(Math.max(...filterBoxes.map((box) => box?.y ?? 0)) - Math.min(...filterBoxes.map((box) => box?.y ?? 0))).toBeLessThan(2);
  }
  const form = page.locator('form');
  await expect(form.getByLabel('Received from')).toHaveValue('QA Exporters');
  await expect(form.getByText('Recorded by Offline Admin', { exact: false })).toBeVisible();
  await expect(form.getByLabel('Destination')).toHaveCount(0);
  const history = page.getByRole('navigation', { name: 'Standalone receipt pages' });
  await expect(history.getByRole('button', { name: 'Next' })).toBeEnabled();
  if (await page.evaluate(() => window.innerWidth >= 1280)) {
    const formHeight = await form.evaluate((element) => element.getBoundingClientRect().height);
    const historyHeight = await page.getByRole('heading', { name: 'Standalone receipt history' }).evaluate((element) => element.closest('section')!.getBoundingClientRect().height);
    expect(Math.abs(formHeight - historyHeight)).toBeLessThan(2);
  }
  await form.getByLabel('Amount received (INR)').fill('425');
  await form.getByLabel('Payment reference').fill('CASH-REF-77');
  await form.getByLabel('Pieces').fill('2');
  await form.getByLabel('Total weight (kg)').fill('4.25');
  await form.getByRole('button', { name: 'Generate cash receipt' }).click();
  await expect(page.getByText('Cash receipt recorded and shared with Swiftline staff.')).toBeVisible();
  await expect.poll(() => mock.cashReceiptPosts().length).toBe(1);
  expect(mock.cashReceiptPosts()[0]).toMatchObject({ businessAccountId: 'offline-account', branchId: 'offline-branch', customerName: 'QA Exporters', amountMinor: 42_500, paymentReference: 'CASH-REF-77', pieces: 2, weightKg: 4.25 });
  await history.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('CR-QA-006', { exact: true })).toBeVisible();
  expect(mock.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('standalone-cash-receipts.png'), fullPage: true });
});

test('standalone receipt shipment details are optional', async ({ page }) => {
  const mock = await mockPayments(page, { staff: true, standaloneReceipts: true });
  await page.goto('/dashboard/cash-receipts');
  const form = page.locator('form');
  await form.getByLabel('Amount received (INR)').fill('425');
  await form.getByLabel('Payment reference').fill('CASH-REF-OPTIONAL');
  await form.getByRole('button', { name: 'Generate cash receipt' }).click();
  await expect(page.getByText('Cash receipt recorded and shared with Swiftline staff.')).toBeVisible();
  expect(mock.cashReceiptPosts()).toHaveLength(1);
  expect(mock.cashReceiptPosts()[0]).not.toHaveProperty('service');
  expect(mock.cashReceiptPosts()[0]).not.toHaveProperty('pieces');
  expect(mock.cashReceiptPosts()[0]).not.toHaveProperty('weightKg');
  expect(mock.errors).toEqual([]);
});

test('only unread cash receipts receive a badge and document-row highlight', async ({ page }) => {
  await mockPayments(page, { documentCentre: true });
  await page.goto('/client/documents');

  const newReceiptRow = page.locator('[data-document-id="CASH_RECEIPT:qa-receipt"]:visible');
  const invoiceRow = page.locator('[data-document-id="BILLING_INVOICE:qa-invoice"]:visible');
  await expect(newReceiptRow).toHaveClass(/amber/);
  await expect(newReceiptRow.getByText(/New/)).toBeVisible();
  await expect(invoiceRow).not.toHaveClass(/amber/);
  await expect(invoiceRow.getByText(/New/)).toHaveCount(0);
  if (await page.evaluate(() => window.innerWidth < 1024)) await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('link', { name: /Documents Centre.*1/ })).toBeVisible();
  if (await page.evaluate(() => window.innerWidth < 1024)) await page.getByRole('button', { name: 'Close menu' }).click();

  await newReceiptRow.getByRole('button', { name: 'View' }).click();
  await expect(newReceiptRow.getByText(/New/)).toHaveCount(0);
  await expect(newReceiptRow).not.toHaveClass(/amber/);
  if (await page.evaluate(() => window.innerWidth < 1024)) await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('link', { name: 'Documents Centre' })).toBeVisible();
});
