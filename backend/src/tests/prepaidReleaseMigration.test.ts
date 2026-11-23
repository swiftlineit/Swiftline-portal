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
