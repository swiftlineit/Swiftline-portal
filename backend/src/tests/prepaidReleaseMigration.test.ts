import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { applyPrepaidRelease, inspectPrepaidRelease } from "../scripts/prepaidReleaseMigration.js";

const uri = process.env.PREPAID_OFFLINE_MONGODB_URI ?? "";
const target = new URL(uri);
if (target.protocol !== "mongodb:" || target.hostname !== "127.0.0.1" || target.username || target.password) {
  throw new Error("Release migration tests require the isolated local prepaid replica set.");
}
const client = new MongoClient(uri);
const root = new ObjectId();
const operator = new ObjectId();
const account = new ObjectId();
const operatorAccount = new ObjectId();
let db: Db;

before(async () => {
  await client.connect();
  db = client.db(`sl_prepaid_release_${new ObjectId().toHexString()}`);
});
after(async () => {
  if (db) await db.dropDatabase();
  await client.close();
});
beforeEach(async () => {
  await db.dropDatabase();
  await db.collection("tenants").insertMany([
    { _id: root, kind: "SWIFTLINE", status: "ACTIVE" },
    { _id: operator, kind: "OPERATOR", status: "ACTIVE" }
  ]);
  await db.collection("businessaccounts").insertMany([
    { _id: account, tenantId: root }, { _id: operatorAccount, tenantId: operator }
  ]);
  await db.collection("prepaidaccounts").insertMany([
    { businessAccountId: account, cashBalanceMinor: 12000, reservedBalanceMinor: 500, version: 4 },
    { tenantId: operator, businessAccountId: operatorAccount, cashBalanceMinor: 7000, reservedBalanceMinor: 0, version: 2 }
  ]);
  await db.collection("paymenttopups").insertOne({ businessAccountId: account, amountMinor: 12300,
    idempotencyKey: "legacy-captured-topup", razorpayOrderId: "order_original", razorpayPaymentId: "pay_original", status: "CAPTURED" });
  await db.collection("businesscreditaccounts").insertOne({ businessAccountId: account, tenantId: root,
    customerAdvanceBalanceMinor: 19762000, status: "ACTIVE" });
});

test("release preflight reads active-operator production shape without changing records or indexes", async () => {
  const beforeWallets = await db.collection("prepaidaccounts").find().toArray();
  const beforeIndexes = await db.collection("prepaidaccounts").listIndexes().toArray();
  const report = await inspectPrepaidRelease(db);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.ownership.find((item) => item.collection === "prepaidaccounts")?.count, 1);
  assert.ok(report.missingIndexes.some((item) => item.options.name === "direct_payment_gateway_payment"));
  assert.deepEqual(await db.collection("prepaidaccounts").find().toArray(), beforeWallets);
  assert.deepEqual(await db.collection("prepaidaccounts").listIndexes().toArray(), beforeIndexes);
});

test("release migration preserves money and captures, supports an active operator, and reruns safely", async () => {
  await db.collection("prepaidaccounts").createIndex({ businessAccountId: 1 }, { unique: true });
  await db.collection("paymenttopups").createIndex({ razorpayOrderId: 1 }, { unique: true });
  const operatorBefore = await db.collection("prepaidaccounts").findOne({ tenantId: operator });
  const legacyBefore = await db.collection("businesscreditaccounts").findOne({ businessAccountId: account });
  const topupBefore = await db.collection("paymenttopups").findOne({ businessAccountId: account });
  const result = await applyPrepaidRelease(db);
  assert.equal(result.missingIndexes.length, 0);
  assert.equal(result.ownership.length, 0);
  const wallet = await db.collection("prepaidaccounts").findOne({ businessAccountId: account });
  assert.equal(String(wallet?.tenantId), String(root));
  assert.equal(wallet?.cashBalanceMinor, 12000);
  assert.equal(wallet?.reservedBalanceMinor, 500);
  assert.equal(wallet?.version, 4);
  assert.equal(wallet?.fundingCycleSequence, 0);
  assert.ok((await db.collection("prepaidaccounts").listIndexes().toArray()).some((index) => index.name === "businessAccountId_1" && index.unique));
  assert.ok((await db.collection("paymenttopups").listIndexes().toArray()).find((index) => index.name === "razorpayOrderId_1")?.partialFilterExpression);
  assert.deepEqual(await db.collection("prepaidaccounts").findOne({ tenantId: operator }), operatorBefore);
  assert.deepEqual(await db.collection("businesscreditaccounts").findOne({ businessAccountId: account }), legacyBefore);
  assert.deepEqual(await db.collection("paymenttopups").findOne({ businessAccountId: account }), { ...topupBefore, tenantId: root });
  assert.equal((await applyPrepaidRelease(db)).missingIndexes.length, 0);
});

test("pending Swiftline amendments block the release before ownership or index writes", async () => {
  await db.collection("shipmentamendments").insertOne({ tenantId: root, status: "REQUESTED" });
  await assert.rejects(applyPrepaidRelease(db), /shipmentamendments/);
  assert.equal((await db.collection("prepaidaccounts").findOne({ businessAccountId: account }))?.tenantId, undefined);
  assert.equal((await db.collection("prepaidaccounts").listIndexes().toArray()).length, 1);
});

test("an operator's unowned legacy wallet is rejected instead of assigned to Swiftline", async () => {
  await db.collection("prepaidaccounts").updateOne({ businessAccountId: operatorAccount }, { $unset: { tenantId: "" } });
  await assert.rejects(applyPrepaidRelease(db), /non-Swiftline business/);
});

test("duplicate effective wallet owners block all migration writes", async () => {
  await db.collection("prepaidaccounts").insertOne({ businessAccountId: account, cashBalanceMinor: 99 });
  await assert.rejects(applyPrepaidRelease(db), /duplicate keys/);
  assert.equal(await db.collection("prepaidaccounts").countDocuments({ tenantId: null }), 2);
});

test("the known obsolete cash index is replaced without deleting standalone receipts", async () => {
  await db.collection("cashreceipts").insertOne({ tenantId: root, receiptNumber: "CR-OLD", receiptType: "STANDALONE", status: "FINALIZED" });
  await db.collection("cashreceipts").createIndex({ tenantId: 1, shipmentDraftId: 1, status: 1 }, {
    unique: true, name: "tenant_active_cash_receipt", partialFilterExpression: { status: { $in: ["DRAFT", "FINALIZED"] } }
  });
  await applyPrepaidRelease(db);
  await db.collection("cashreceipts").insertOne({ tenantId: root, receiptNumber: "CR-NEW", receiptType: "STANDALONE", status: "FINALIZED" });
  assert.equal(await db.collection("cashreceipts").countDocuments(), 2);
});

const zeroOpening = { zeroOpeningBalances: true };
async function releaseWalletHold() {
  await db.collection("prepaidaccounts").updateOne({ businessAccountId: account }, { $set: { reservedBalanceMinor: 0 } });
}

test("zero-opening preflight reports the proposed reset without writing balances or audit records", async () => {
  await releaseWalletHold();
  const before = await db.collection("prepaidaccounts").find().toArray();
  const report = await inspectPrepaidRelease(db, zeroOpening);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.zeroOpening?.alreadyApplied, false);
  assert.equal(report.zeroOpening?.walletBalanceToRemoveMinor, 12000);
  assert.equal(report.zeroOpening?.legacyAdvanceToRemoveMinor, 19762000);
  assert.deepEqual(await db.collection("prepaidaccounts").find().toArray(), before);
  assert.equal(await db.collection("auditlogs").countDocuments(), 0);
});

test("explicit zero-opening resets only Swiftline balances and preserves financial documents and captures", async () => {
  await releaseWalletHold();
  await db.collection("businesscreditaccounts").updateOne({ businessAccountId: account }, { $set: {
    approvedCreditLimitMinor: 900000, requestedCreditLimitMinor: 900000, unbilledCreditMinor: 45000,
    invoicedOutstandingMinor: 20000, securityDepositRequiredMinor: 10000
  } });
  await db.collection("businesscreditaccounts").insertOne({ tenantId: operator, businessAccountId: operatorAccount,
    status: "ACTIVE", customerAdvanceBalanceMinor: 3400, approvedCreditLimitMinor: 99900 });
  const operatorWallet = await db.collection("prepaidaccounts").findOne({ tenantId: operator });
  const operatorCredit = await db.collection("businesscreditaccounts").findOne({ tenantId: operator });
  const originalTopup = await db.collection("paymenttopups").findOne({ businessAccountId: account });
  const preserved = ["shipments", "shipmentinvoices", "creditbillingstatements", "creditledgerentries", "cashreceipts"];
  const snapshots = new Map<string, unknown[]>();
  for (const name of preserved) {
    await db.collection(name).insertOne({ tenantId: root, businessAccountId: account,
      amountMinor: 12300, reference: "historical-record", ...(name === "cashreceipts" ? { receiptNumber: "CR-ARCHIVE" } : {}) });
    snapshots.set(name, await db.collection(name).find().toArray());
  }
  const after = await applyPrepaidRelease(db, zeroOpening);
  assert.equal(after.zeroOpening?.alreadyApplied, true);
  const wallet = await db.collection("prepaidaccounts").findOne({ businessAccountId: account });
  assert.equal(wallet?.cashBalanceMinor, 0);
  assert.equal(wallet?.reservedBalanceMinor, 0);
  assert.equal(wallet?.fundingCycleBaselineMinor, 0);
  assert.equal(wallet?.fundingCycleSequence, 0);
  assert.equal(wallet?.version, 5);
  const credit = await db.collection("businesscreditaccounts").findOne({ businessAccountId: account });
  for (const field of ["approvedCreditLimitMinor", "requestedCreditLimitMinor", "unbilledCreditMinor",
    "invoicedOutstandingMinor", "customerAdvanceBalanceMinor", "reservedCreditMinor", "reservedAdvanceMinor"]) {
    assert.equal(credit?.[field], 0);
  }
  assert.equal(credit?.status, "CLOSED");
  assert.equal(credit?.securityDepositRequiredMinor, 10000);
  assert.deepEqual(await db.collection("paymenttopups").findOne({ businessAccountId: account }), { ...originalTopup, tenantId: root });
  assert.deepEqual(await db.collection("prepaidaccounts").findOne({ tenantId: operator }), operatorWallet);
  assert.deepEqual(await db.collection("businesscreditaccounts").findOne({ tenantId: operator }), operatorCredit);
  for (const name of preserved) assert.deepEqual(await db.collection(name).find().toArray(), snapshots.get(name));
  const adjustment = await db.collection("prepaidtransactions").findOne({ tenantId: root });
  assert.equal(adjustment?.amountMinor, 12000);
  assert.equal(adjustment?.transactionType, "ADMIN_DEBIT");
  assert.equal(adjustment?.cashBalanceBeforeMinor, 12000);
  assert.equal(adjustment?.cashBalanceAfterMinor, 0);
  const creditAudit = await db.collection("auditlogs").findOne({ "metadata.collection": "businesscreditaccounts" });
  assert.equal(creditAudit?.metadata.before.customerAdvanceBalanceMinor, 19762000);
  assert.equal(creditAudit?.metadata.after.customerAdvanceBalanceMinor, 0);
  assert.equal(await db.collection("auditlogs").countDocuments({ entityType: "TENANT" }), 1);
});

test("rerunning zero-opening never resets subsequent deposits or newly created wallets", async () => {
  await releaseWalletHold();
  await applyPrepaidRelease(db, zeroOpening);
  await db.collection("prepaidaccounts").updateOne({ businessAccountId: account }, { $set: {
    cashBalanceMinor: 45000, reservedBalanceMinor: 2000, fundingCycleBaselineMinor: 45000, fundingCycleSequence: 1
  } });
  const newAccount = new ObjectId();
  await db.collection("businessaccounts").insertOne({ _id: newAccount, tenantId: root });
  await db.collection("prepaidaccounts").insertOne({ tenantId: root, businessAccountId: newAccount,
    cashBalanceMinor: 7900, reservedBalanceMinor: 0, version: 1, fundingCycleBaselineMinor: 7900, fundingCycleSequence: 1,
    fundingCycleStartedAt: new Date(), lowBalanceAlertedCycle: null });
  const before = await db.collection("prepaidaccounts").find().toArray();
  const auditCount = await db.collection("auditlogs").countDocuments();
  assert.equal((await applyPrepaidRelease(db, zeroOpening)).zeroOpening?.alreadyApplied, true);
  assert.deepEqual(await db.collection("prepaidaccounts").find().toArray(), before);
  assert.equal(await db.collection("auditlogs").countDocuments(), auditCount);
  assert.equal(await db.collection("prepaidtransactions").countDocuments(), 1);
});

test("zero-opening refuses held wallet funds before making any writes", async () => {
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /held funds/);
  assert.equal((await db.collection("prepaidaccounts").findOne({ businessAccountId: account }))?.cashBalanceMinor, 12000);
  assert.equal((await db.collection("prepaidaccounts").findOne({ businessAccountId: account }))?.tenantId, undefined);
  assert.equal(await db.collection("auditlogs").countDocuments(), 0);
});

test("legacy holds and in-flight prepaid funding block zero-opening", async () => {
  await releaseWalletHold();
  await db.collection("businesscreditaccounts").updateOne({ businessAccountId: account }, { $set: { reservedAdvanceMinor: 100 } });
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /held funds/);
  await db.collection("businesscreditaccounts").updateOne({ businessAccountId: account }, { $set: { reservedAdvanceMinor: 0 } });
  await db.collection("shipmentfundings").insertOne({ tenantId: root, status: "SECURED" });
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /in-flight prepaid/);
  assert.equal(await db.collection("auditlogs").countDocuments(), 0);
});

test("zero-opening rejects invalid money and cross-tenant parents", async () => {
  await releaseWalletHold();
  await db.collection("prepaidaccounts").updateOne({ businessAccountId: account }, { $set: { cashBalanceMinor: -1 } });
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /invalid balance/);
  await db.collection("prepaidaccounts").updateOne({ businessAccountId: account }, { $set: { cashBalanceMinor: 12000 } });
  await db.collection("businesscreditaccounts").updateOne({ businessAccountId: account }, { $set: { businessAccountId: operatorAccount } });
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /ownership does not match Swiftline/);
  assert.equal(await db.collection("auditlogs").countDocuments(), 0);
});

test("zero-opening rolls back balances, ownership and snapshots when an audit insert fails", async () => {
  await releaseWalletHold();
  await db.createCollection("auditlogs", { validator: { action: { $ne: "PREPAID_ZERO_OPENING_APPLIED" } } });
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /validation/);
  const wallet = await db.collection("prepaidaccounts").findOne({ businessAccountId: account });
  assert.equal(wallet?.cashBalanceMinor, 12000);
  assert.equal(wallet?.tenantId, undefined);
  assert.equal((await db.collection("businesscreditaccounts").findOne({ businessAccountId: account }))?.customerAdvanceBalanceMinor, 19762000);
  assert.equal(await db.collection("prepaidtransactions").countDocuments(), 0);
  assert.equal(await db.collection("auditlogs").countDocuments(), 0);
});

test("wallets already at zero receive an audit snapshot without a fictitious debit", async () => {
  await releaseWalletHold();
  await db.collection("prepaidaccounts").updateOne({ businessAccountId: account }, { $set: { cashBalanceMinor: 0 } });
  const report = await applyPrepaidRelease(db, zeroOpening);
  assert.equal(report.zeroOpening?.alreadyApplied, true);
  assert.equal(await db.collection("prepaidtransactions").countDocuments(), 0);
  assert.equal(await db.collection("auditlogs").countDocuments(), 3);
});

test("an orphaned zero-opening adjustment blocks a new reset instead of posting another debit", async () => {
  await releaseWalletHold();
  await db.collection("prepaidtransactions").insertOne({ tenantId: root, businessAccountId: account,
    idempotencyKey: "swiftline-prepaid-zero-opening-v1:orphaned-adjustment" });
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /without its completion marker/);
  assert.equal((await db.collection("prepaidaccounts").findOne({ businessAccountId: account }))?.cashBalanceMinor, 12000);
});

test("unreconciled direct captures block zero-opening without changing their provider status", async () => {
  await releaseWalletHold();
  await db.collection("shipmentdirectpayments").insertOne({ tenantId: root, status: "CAPTURED", razorpayPaymentId: "pay_pending" });
  await assert.rejects(applyPrepaidRelease(db, zeroOpening), /in-flight prepaid payments/);
  assert.equal((await db.collection("shipmentdirectpayments").findOne({ tenantId: root }))?.status, "CAPTURED");
  assert.equal(await db.collection("auditlogs").countDocuments(), 0);
});
