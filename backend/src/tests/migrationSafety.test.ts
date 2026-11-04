import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExpectedDatabaseName,
  assertNonProductionEnvironment,
  assertProductionTenantAuditTarget,
  assertTenantMigrationExecutionAllowed,
  createProductionTenantMigrationAuthorization,
  parseTenantMigrationNodeEnvironment,
  parseMongoSrvCredentialUser,
  parseMongoSrvTarget
} from "../scripts/migrationSafety.js";

test("migration safety allows non-production environments", () => {
  assert.doesNotThrow(() => assertNonProductionEnvironment("development", "Tenant migration"));
  assert.doesNotThrow(() => assertNonProductionEnvironment("test", "Tenant migration"));
});

test("migration safety refuses production", () => {
  assert.throws(
    () => assertNonProductionEnvironment("production", "Tenant migration"),
    /restricted to a non-production environment/
  );
});

test("tenant migration environment accepts only the supported modes", () => {
  assert.equal(parseTenantMigrationNodeEnvironment(undefined), "development");
  assert.equal(parseTenantMigrationNodeEnvironment("test"), "test");
  assert.equal(parseTenantMigrationNodeEnvironment("production"), "production");
  assert.throws(() => parseTenantMigrationNodeEnvironment("prod"), /NODE_ENV to be/);
});

test("migration safety requires the connected database to match the explicit target", () => {
  assert.doesNotThrow(() => assertExpectedDatabaseName("swiftline-test", "swiftline-test"));
  assert.throws(() => assertExpectedDatabaseName("swiftline-test", "swiftline-prod"), /did not match/);
  assert.throws(() => assertExpectedDatabaseName("swiftline-test", undefined), /did not match/);
  assert.throws(() => assertExpectedDatabaseName("  ", "swiftline-test"), /did not match/);
});

test("production target parser requires explicit Atlas SRV host and database", () => {
  assert.deepEqual(parseMongoSrvTarget("mongodb+srv://readonly:secret@cluster.example.mongodb.net/swiftline?retryWrites=true"), {
    clusterHost: "cluster.example.mongodb.net",
    database: "swiftline"
  });
  assert.throws(() => parseMongoSrvTarget("mongodb://localhost/swiftline"), /requires an explicit mongodb\+srv/);
  assert.throws(() => parseMongoSrvTarget("mongodb+srv://cluster.example.mongodb.net/"), /explicit database name/);
  assert.equal(
    parseMongoSrvCredentialUser("mongodb+srv://readonly%2Daudit:secret@cluster.example.mongodb.net/swiftline"),
    "readonly-audit"
  );
  assert.throws(
    () => parseMongoSrvCredentialUser("mongodb+srv://cluster.example.mongodb.net/swiftline"),
    /named MongoDB credential user/
  );
});

test("production read-only audit requires exact approved target and rejects apply", () => {
  const input = {
    nodeEnvironment: "production",
    expectedDatabase: "swiftline",
    expectedClusterHost: "cluster.example.mongodb.net",
    mongoUri: "mongodb+srv://readonly:secret@cluster.example.mongodb.net/swiftline",
    allowedClusterHost: "cluster.example.mongodb.net"
  };
  assert.deepEqual(assertProductionTenantAuditTarget({ ...input, applyRequested: false }), {
    database: "swiftline",
    clusterHost: "cluster.example.mongodb.net"
  });
  assert.throws(() => assertProductionTenantAuditTarget({ ...input, applyRequested: true }), /read-only/);
  assert.throws(() => assertProductionTenantAuditTarget({ ...input, expectedClusterHost: "other.mongodb.net", applyRequested: false }), /must match exactly/);
  assert.throws(() => assertProductionTenantAuditTarget({ ...input, expectedDatabase: "swiftline-test", applyRequested: false }), /restricted/);
  assert.throws(() => assertProductionTenantAuditTarget({ ...input, allowedClusterHost: undefined, applyRequested: false }), /must match exactly/);
});

test("manual migration authorization requires production target, CI off, backup, change, run ID and exact confirmation", () => {
  const input = {
    nodeEnvironment: "production",
    ci: undefined,
    expectedDatabase: "swiftline",
    expectedClusterHost: "cluster.example.mongodb.net",
    mongoUri: "mongodb+srv://migration:secret@cluster.example.mongodb.net/swiftline",
    allowedClusterHost: "cluster.example.mongodb.net",
    apply: true,
    confirmation: "APPLY SWIFTLINE TENANT MIGRATION swiftline",
    changeId: "CHG-2026-1234",
    backupReference: "backup-2026-11-04-001",
    runId: "tenant-cutover-2026-11-04"
  };
  const authorization = createProductionTenantMigrationAuthorization(input);
  assert.doesNotThrow(() => assertTenantMigrationExecutionAllowed({
    nodeEnvironment: "production",
    step: "swiftline-root-ownership",
    expectedDatabase: "swiftline",
    mongoUri: input.mongoUri,
    authorization
  }));
  assert.throws(() => assertTenantMigrationExecutionAllowed({
    nodeEnvironment: "production",
    step: "swiftline-root-ownership",
    expectedDatabase: "swiftline",
    mongoUri: input.mongoUri,
    authorization: {}
  }), /not authorized/);
  assert.throws(() => assertTenantMigrationExecutionAllowed({
    nodeEnvironment: "production",
    step: "shipment-tenant-ownership",
    expectedDatabase: "swiftline-test",
    mongoUri: input.mongoUri,
    authorization
  }), /does not match/);
  assert.throws(() => createProductionTenantMigrationAuthorization({ ...input, ci: "true" }), /CI\/CD/);
  assert.throws(() => createProductionTenantMigrationAuthorization({ ...input, ci: "1" }), /CI\/CD/);
  assert.throws(() => createProductionTenantMigrationAuthorization({ ...input, apply: false }), /explicit --apply/);
  assert.throws(() => createProductionTenantMigrationAuthorization({ ...input, confirmation: "yes" }), /confirmation/);
  assert.throws(() => createProductionTenantMigrationAuthorization({ ...input, backupReference: "" }), /backup or point-in-time/);
});
