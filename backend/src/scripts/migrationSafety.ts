import path from "node:path";
import { pathToFileURL } from "node:url";

export const productionTenantMigrationSteps = [
  "swiftline-root-ownership",
  "account-credit-tenant-ownership",
  "operational-tenant-ownership",
  "shipment-tenant-ownership",
  "business-account-tenant-indexes",
  "tenant-registry-indexes",
  "operator-support-indexes"
] as const;

/** Narrow post-activation migrations that must never join the ownership cutover sequence. */
export const standaloneProductionTenantMigrationSteps = [
  "operator-counter-payment-indexes"
] as const;

export type ProductionTenantMigrationStep =
  | typeof productionTenantMigrationSteps[number]
  | typeof standaloneProductionTenantMigrationSteps[number];
export type ProductionTenantMigrationAuthorization = object;
export type TenantMigrationNodeEnvironment = "development" | "test" | "production";

type ProductionMigrationGrant = {
  database: string;
  clusterHost: string;
  changeId: string;
  backupReference: string;
  runId: string;
};

const productionMigrationGrants = new WeakMap<object, ProductionMigrationGrant>();

export function isEnvironmentFlagEnabled(value: string | undefined) {
  return Boolean(value?.trim() && !["false", "0", "no", "off"].includes(value.trim().toLowerCase()));
}

export function parseTenantMigrationNodeEnvironment(value: string | undefined): TenantMigrationNodeEnvironment {
  const environment = value?.trim() || "development";
  if (environment !== "development" && environment !== "test" && environment !== "production") {
    throw new Error("Tenant migration tools require NODE_ENV to be development, test, or production.");
  }
  return environment;
}

export function assertNonProductionEnvironment(environment: string, operation: string) {
  if (environment === "production") {
    throw new Error(`${operation} is restricted to a non-production environment.`);
  }
}

export function assertExpectedDatabaseName(expectedDatabase: string, actualDatabase: string | undefined) {
  if (!expectedDatabase.trim() || !actualDatabase || actualDatabase !== expectedDatabase.trim()) {
    throw new Error("Connected database did not match the expected database name.");
  }
}

export function isMainModule(moduleUrl: string): boolean {
  const entryPath = process.argv[1];
  return Boolean(entryPath) && pathToFileURL(path.resolve(entryPath!)).href === moduleUrl;
}

export type MongoSrvTarget = { clusterHost: string; database: string };

/** Restrict production tooling to explicit Atlas SRV URIs with a named database. */
export function parseMongoSrvTarget(uri: string): MongoSrvTarget {
  if (typeof uri !== "string" || !uri.toLowerCase().startsWith("mongodb+srv://")) {
    throw new Error("Production tenant tooling requires an explicit mongodb+srv URI.");
  }

  let parsed: URL;
  try {
    parsed = new URL(uri.replace(/^mongodb\+srv:/i, "https:"));
  } catch {
    throw new Error("Production tenant tooling could not parse the configured MongoDB URI.");
  }

  const clusterHost = parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
  let database = "";
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "").trim();
  } catch {
    throw new Error("MongoDB URI contains an invalid database name.");
  }
  if (!clusterHost || !database) {
    throw new Error("MongoDB URI must include an Atlas cluster host and explicit database name.");
  }
  return { clusterHost, database };
}

export function parseMongoSrvCredentialUser(uri: string): string {
  parseMongoSrvTarget(uri);
  const parsed = new URL(uri.replace(/^mongodb\+srv:/i, "https:"));
  let username = "";
  try {
    username = decodeURIComponent(parsed.username).trim();
  } catch {
    throw new Error("MongoDB URI contains an invalid credential username.");
  }
  if (!username) throw new Error("Production tenant tooling requires a named MongoDB credential user.");
  return username;
}

function assertProductionAtlasTarget(input: {
  nodeEnvironment: string;
  expectedDatabase: string;
  expectedClusterHost: string;
  mongoUri: string;
  allowedClusterHost: string | undefined;
}) {
  if (input.nodeEnvironment !== "production") {
    throw new Error("Production tenant tooling requires NODE_ENV=production.");
  }
  const expectedDatabase = input.expectedDatabase.trim();
  const expectedClusterHost = input.expectedClusterHost.trim().toLowerCase().replace(/\.$/, "");
  const allowedClusterHost = input.allowedClusterHost?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  const uriTarget = parseMongoSrvTarget(input.mongoUri);

  if (expectedDatabase !== "swiftline" || uriTarget.database !== expectedDatabase) {
    throw new Error("Production tenant tooling is restricted to the explicitly named swiftline database.");
  }
  if (!expectedClusterHost || expectedClusterHost !== allowedClusterHost || expectedClusterHost !== uriTarget.clusterHost) {
    throw new Error("Expected cluster host, migration allowlist, and MongoDB URI host must match exactly.");
  }
  return { database: expectedDatabase, clusterHost: expectedClusterHost };
}

export function assertProductionTenantAuditTarget(input: {
  nodeEnvironment: string;
  expectedDatabase: string;
  expectedClusterHost: string;
  mongoUri: string;
  allowedClusterHost: string | undefined;
  applyRequested: boolean;
}) {
  if (input.applyRequested) throw new Error("The production tenant audit is read-only and does not accept --apply.");
  return assertProductionAtlasTarget(input);
}

export function createProductionTenantMigrationAuthorization(input: {
  nodeEnvironment: string;
  ci: string | undefined;
  expectedDatabase: string;
  expectedClusterHost: string;
  mongoUri: string;
  allowedClusterHost: string | undefined;
  apply: boolean;
  confirmation: string;
  changeId: string;
  backupReference: string;
  runId: string;
}): ProductionTenantMigrationAuthorization {
  const target = assertProductionAtlasTarget(input);
  if (isEnvironmentFlagEnabled(input.ci)) {
    throw new Error("Production tenant migrations cannot run from CI/CD.");
  }
  if (!input.apply) throw new Error("Production tenant migration requires explicit --apply.");
  if (input.confirmation !== "APPLY SWIFTLINE TENANT MIGRATION swiftline") {
    throw new Error("Production tenant migration confirmation did not match the required phrase.");
  }
  const changeId = input.changeId.trim();
  const backupReference = input.backupReference.trim();
  const runId = input.runId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(changeId)) {
    throw new Error("A valid change ID is required for production tenant migration.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(backupReference)) {
    throw new Error("A valid backup or point-in-time recovery reference is required.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(runId)) {
    throw new Error("A valid unique migration run ID is required.");
  }

  const authorization = Object.freeze({});
  productionMigrationGrants.set(authorization, {
    ...target,
    changeId,
    backupReference,
    runId
  });
  return authorization;
}

export function assertProductionTenantMigrationAuthorization(
  authorization: ProductionTenantMigrationAuthorization | undefined,
  step: ProductionTenantMigrationStep,
  expectedDatabase: string,
  expectedClusterHost: string
) {
  const grant = authorization && productionMigrationGrants.get(authorization);
  if (!grant) throw new Error("This production migration step was not authorized by the manual production runner.");
  if (![...productionTenantMigrationSteps, ...standaloneProductionTenantMigrationSteps].includes(step)) {
    throw new Error("Unknown production tenant migration step.");
  }
  if (grant.database !== expectedDatabase || grant.clusterHost !== expectedClusterHost.toLowerCase().replace(/\.$/, "")) {
    throw new Error("Migration step target does not match the approved production database and cluster.");
  }
  return grant;
}

export function assertTenantMigrationExecutionAllowed(input: {
  nodeEnvironment: string;
  step: ProductionTenantMigrationStep;
  expectedDatabase: string;
  mongoUri: string;
  authorization?: ProductionTenantMigrationAuthorization;
}) {
  if (!input.mongoUri.trim()) {
    throw new Error("A MongoDB URI is required for the tenant migration step.");
  }
  if (input.nodeEnvironment !== "production") {
    if (input.authorization) throw new Error("Production migration authorization cannot be used outside production.");
    assertNonProductionEnvironment(input.nodeEnvironment, `Tenant migration ${input.step}`);
    return null;
  }
  const target = parseMongoSrvTarget(input.mongoUri);
  return assertProductionTenantMigrationAuthorization(
    input.authorization,
    input.step,
    input.expectedDatabase,
    target.clusterHost
  );
}
