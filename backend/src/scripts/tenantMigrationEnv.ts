import "dotenv/config";
import { parseTenantMigrationNodeEnvironment } from "./migrationSafety.js";

/** Environment settings used only by the manual tenant audit and migration tools. */
export const tenantMigrationEnv = {
  nodeEnvironment: parseTenantMigrationNodeEnvironment(process.env.NODE_ENV),
  applicationMongoUri: process.env.MONGODB_URI?.trim() || "",
  auditMongoUri: process.env.TENANT_AUDIT_MONGODB_URI?.trim() || undefined,
  migrationMongoUri: process.env.TENANT_MIGRATION_MONGODB_URI?.trim() || undefined,
  allowedClusterHost: process.env.TENANT_MIGRATION_ALLOWED_CLUSTER_HOST?.trim() || undefined
};
