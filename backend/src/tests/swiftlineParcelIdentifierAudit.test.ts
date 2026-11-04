import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db } from "mongodb";
import {
  collectSwiftlineParcelAuditRecords,
  formatSafeSwiftlineParcelAuditError,
  redactSwiftlineParcelAuditCollisions,
  resolveSwiftlineParcelAuditTarget
} from "../scripts/auditSwiftlineParcelIdentifierCollisions.js";
import { findSwiftlineParcelIdentifierCollisions } from "../services/swiftlineParcelIdentifier.service.js";

const allowedClusterHost = "cluster.example.mongodb.net";
const readOnlyUri = `mongodb+srv://parcel-audit:private-password@${allowedClusterHost}/swiftline?retryWrites=true&w=majority`;
const auditArguments = ["--expected-database", "swiftline", "--expected-cluster-host", allowedClusterHost];

test("audit requires the dedicated read-only URI instead of falling back to application MONGODB_URI", () => {
  assert.throws(() => resolveSwiftlineParcelAuditTarget({
    NODE_ENV: "production",
    MONGODB_URI: readOnlyUri,
    TENANT_MIGRATION_ALLOWED_CLUSTER_HOST: allowedClusterHost
  }, auditArguments), /TENANT_AUDIT_MONGODB_URI is required/);
});

test("audit requires explicit production database and exact Atlas cluster identity", () => {
  const environment = {
    NODE_ENV: "production",
    TENANT_AUDIT_MONGODB_URI: readOnlyUri,
    TENANT_MIGRATION_ALLOWED_CLUSTER_HOST: allowedClusterHost
  };
  assert.deepEqual(resolveSwiftlineParcelAuditTarget(environment, auditArguments), {
    uri: readOnlyUri,
    database: "swiftline",
    clusterHost: allowedClusterHost
  });
  assert.throws(() => resolveSwiftlineParcelAuditTarget(environment, [
    "--expected-database", "swiftline-staging", "--expected-cluster-host", allowedClusterHost
  ]), /restricted/);
  assert.throws(() => resolveSwiftlineParcelAuditTarget(environment, [
    "--expected-database", "swiftline", "--expected-cluster-host", "other.mongodb.net"
  ]), /must match exactly/);
  assert.throws(() => resolveSwiftlineParcelAuditTarget({ ...environment, NODE_ENV: "test" }, auditArguments), /NODE_ENV=production/);
  assert.throws(() => resolveSwiftlineParcelAuditTarget({ ...environment, TENANT_MIGRATION_ALLOWED_CLUSTER_HOST: undefined }, auditArguments), /ALLOW.*CLUSTER_HOST/i);
  assert.throws(() => resolveSwiftlineParcelAuditTarget(environment, [...auditArguments, "--apply"]), /read-only/);
});

test("native audit reads every unmigrated shipment and label without tenant ownership filters", async () => {
  const bookingAId = new ObjectId();
  const bookingBId = new ObjectId();
  const shipmentAId = new ObjectId();
  const shipmentBId = new ObjectId();
  const queries: Array<{ collection: string; filter: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const documents: Record<string, unknown[]> = {
    dpdshipments: [
      {
        _id: bookingAId,
        shipmentDraftId: shipmentAId,
        swiftlineTrackingNumber: "SLCDEL031126100",
        parcelNumbers: ["SLCDEL031126100-01"]
        // Deliberately no tenantId: this matches the unmigrated production rows.
      },
      {
        _id: bookingBId,
        shipmentDraftId: shipmentBId,
        swiftlineTrackingNumber: "SLCDEL03112610001",
        parcelNumbers: []
      }
    ],
    labeldocuments: [
      { dpdShipmentId: bookingAId, parcelNumber: "SLCDEL031126100-01" }
    ]
  };
  const db = {
    collection(name: string) {
      return {
        find(filter: Record<string, unknown>, options: Record<string, unknown>) {
          queries.push({ collection: name, filter, options });
          const rows = documents[name] ?? [];
          return {
            async *[Symbol.asyncIterator]() {
              for (const row of rows) yield row;
            },
            async close() {}
          };
        }
      };
    }
  } as unknown as Db;

  const result = await collectSwiftlineParcelAuditRecords(db);
  const collisions = findSwiftlineParcelIdentifierCollisions(result.records);

  assert.equal(result.shipmentCount, 2);
  assert.equal(result.records.length, 2);
  assert.equal(collisions.length, 1);
  assert.deepEqual(queries.map(({ collection, filter }) => ({ collection, filter })), [
    { collection: "dpdshipments", filter: {} },
    { collection: "labeldocuments", filter: { voidedAt: null } }
  ]);
  assert.equal("tenantId" in queries[0]!.filter, false);
  const shipmentProjection = queries[0]!.options.projection as Record<string, unknown>;
  assert.equal("tenantId" in shipmentProjection, false);
  assert.equal(shipmentProjection.forwardingNumber, 1);
  assert.equal(shipmentProjection.entryNumber, 1);
});

test("collision diagnostics hide parcel values and full ObjectIds while preserving correlatable references", () => {
  const shipmentAId = "66f100000000000000000001";
  const shipmentBId = "66f100000000000000000002";
  const parcelNumber = "SLCDEL03112610001";
  const collisions = findSwiftlineParcelIdentifierCollisions([
    { shipmentDraftId: shipmentAId, trackingNumber: "SLCDEL031126100", parcelNumbers: ["SLCDEL031126100-01"] },
    { shipmentDraftId: shipmentBId, trackingNumber: parcelNumber, parcelNumbers: [] }
  ]);
  const safeJson = JSON.stringify(redactSwiftlineParcelAuditCollisions(collisions));

  assert.doesNotMatch(safeJson, new RegExp(shipmentAId));
  assert.doesNotMatch(safeJson, new RegExp(shipmentBId));
  assert.doesNotMatch(safeJson, new RegExp(parcelNumber));
  assert.match(safeJson, /identifierRef/);
  assert.match(safeJson, /shipmentRef/);
});

test("connection diagnostics keep an error code and reason but redact credentials, PII, and ObjectIds", () => {
  const objectId = "66f100000000000000000001";
  const error = Object.assign(new Error(
    `MongoDB rejected mongodb+srv://audit:private-password@cluster.example.mongodb.net/swiftline for person@example.com +91 98765 43210 ${objectId}`
  ), { code: 8000, codeName: "AtlasError" });
  const safe = formatSafeSwiftlineParcelAuditError(error);

  assert.match(safe, /MongoServerError|Error/);
  assert.match(safe, /AtlasError|8000/);
  assert.match(safe, /MongoDB URI/);
  assert.doesNotMatch(safe, /private-password|person@example\.com|98765|43210|66f100000000000000000001/);
});
