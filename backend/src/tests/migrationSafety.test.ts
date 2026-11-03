import assert from "node:assert/strict";
import test from "node:test";
import { assertExpectedDatabaseName, assertNonProductionEnvironment } from "../scripts/migrationSafety.js";

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

test("migration safety requires the connected database to match the explicit target", () => {
  assert.doesNotThrow(() => assertExpectedDatabaseName("swiftline-test", "swiftline-test"));
  assert.throws(() => assertExpectedDatabaseName("swiftline-test", "swiftline-prod"), /did not match/);
  assert.throws(() => assertExpectedDatabaseName("swiftline-test", undefined), /did not match/);
  assert.throws(() => assertExpectedDatabaseName("  ", "swiftline-test"), /did not match/);
});
