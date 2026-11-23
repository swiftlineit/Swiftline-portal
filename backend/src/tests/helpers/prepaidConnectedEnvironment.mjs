// Explicitly invoked development verification. Uses only MONGODB_URI from .env.
import "dotenv/config";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";

if (process.env.NODE_ENV === "production" || process.env.PREPAID_CONNECTED_TEST !== "1" || !process.env.MONGODB_URI) {
  throw new Error("Connected prepaid verification requires explicit PREPAID_CONNECTED_TEST=1 in a non-production environment.");
}
const uri = process.env.MONGODB_URI;
process.env.DOTENV_CONFIG_PATH = "__prepaid_connected_no_reload__";
Object.assign(process.env, {
  NODE_ENV: "test", MONGODB_URI: uri, CLIENT_URL: "http://127.0.0.1:3001",
  RAZORPAY_KEY_ID: "rzp_test_offline", RAZORPAY_KEY_SECRET: "offline-razorpay-secret",
  RAZORPAY_WEBHOOK_SECRET: "offline-webhook-secret", MAIL_DRIVER: "noop", MAIL_FROM: "",
  STORAGE_DRIVER: "local", DPD_BOOKING_ENABLED: "false", ALS_TRACKING_SWEEP_ENABLED: "false",
  EMAIL_DOMAIN_CHECK: "false", OPERATOR_PORTAL_ENABLED: "true"
});
const deny = () => { throw new Error("External HTTP services are blocked during connected prepaid verification."); };
http.request = deny; http.get = deny; https.request = deny; https.get = deny;
globalThis.fetch = async () => deny();

// Track only newly inserted ids; never delete or rewrite pre-existing data.
export const inserted = new Map();
const prototype = mongoose.mongo.Collection.prototype;
function remember(name, ids) {
  const set = inserted.get(name) ?? new Map();
  for (const id of ids) if (id) set.set(String(id), id);
  inserted.set(name, set);
}
function suppressEmail(name, document) {
  if (name !== "emailoutboxes") return;
  // Persist cancelled rows so a separately running application worker cannot send them.
  if (document) { document.status = "CANCELLED"; document.toEmail = "prepaid-qa@example.test"; }
}
for (const method of ["insertOne", "insertMany", "updateOne", "bulkWrite", "findOneAndUpdate"]) {
  const original = prototype[method];
  prototype[method] = async function (...args) {
    const returnMetadata = args[2]?.includeResultMetadata === true;
    const trackUpsert = method === "findOneAndUpdate" && args[2]?.upsert === true;
    if (trackUpsert) args[2] = { ...args[2], includeResultMetadata: true };
    if (method === "insertOne") suppressEmail(this.collectionName, args[0]);
    if (method === "insertMany") for (const doc of args[0]) suppressEmail(this.collectionName, doc);
    if (method === "updateOne") suppressEmail(this.collectionName, args[1]?.$setOnInsert);
    if (method === "bulkWrite") for (const op of args[0]) {
      suppressEmail(this.collectionName, op.insertOne?.document);
      suppressEmail(this.collectionName, op.updateOne?.update?.$setOnInsert);
    }
    const result = await original.apply(this, args);
    if (result) remember(this.collectionName, [result.insertedId, result.upsertedId, result.lastErrorObject?.upserted, ...Object.values(result.insertedIds ?? {}), ...Object.values(result.upsertedIds ?? {})]);
    return trackUpsert && !returnMetadata ? result.value : result;
  };
}
