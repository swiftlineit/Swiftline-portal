// Read-only preflight before switching SWIFTLINE_PARCEL_NUMBER_FORMAT to COMPACT.
// Run with NODE_ENV=production, TENANT_AUDIT_MONGODB_URI set to a dedicated
// read-only Atlas user, TENANT_MIGRATION_ALLOWED_CLUSTER_HOST set to the approved
// production Atlas SRV host, and explicit --expected-database/--expected-cluster-host flags.
import "dotenv/config";
import { createHash } from "node:crypto";
import { MongoClient, type Db, type Document } from "mongodb";
import {
  assertProductionTenantAuditTarget,
  isMainModule,
  parseMongoSrvCredentialUser
} from "./migrationSafety.js";
import {
  findSwiftlineParcelIdentifierCollisions,
  type SwiftlineParcelIdentifierAuditRecord
} from "../services/swiftlineParcelIdentifier.service.js";

type SnapshotReferences = {
  tracking?: { swiftlineTrackingNumber?: string };
  parcels?: Array<{ swiftlineParcelNumber?: string }>;
};

type ShipmentReferences = Document & {
  _id: unknown;
  shipmentDraftId?: unknown;
  swiftlineTrackingNumber?: string;
  dpdShipmentId?: string;
  forwardingNumber?: string;
  entryNumber?: string;
  parcelNumbers?: string[];
  currentShipmentSnapshot?: SnapshotReferences;
  bookingSnapshot?: SnapshotReferences;
};

type LabelReferences = Document & {
  dpdShipmentId?: unknown;
  parcelNumber?: string;
};

export type SwiftlineParcelAuditTarget = {
  uri: string;
  database: string;
  clusterHost: string;
};

const shipmentProjection = {
  _id: 1,
  shipmentDraftId: 1,
  swiftlineTrackingNumber: 1,
  dpdShipmentId: 1,
  forwardingNumber: 1,
  entryNumber: 1,
  parcelNumbers: 1,
  "currentShipmentSnapshot.tracking.swiftlineTrackingNumber": 1,
  "currentShipmentSnapshot.parcels.swiftlineParcelNumber": 1,
  "bookingSnapshot.tracking.swiftlineTrackingNumber": 1,
  "bookingSnapshot.parcels.swiftlineParcelNumber": 1
} as const;

const labelProjection = { dpdShipmentId: 1, parcelNumber: 1 } as const;

function parseArguments(args: readonly string[]) {
  const options: { expectedDatabase?: string; expectedClusterHost?: string } = {};

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--apply") {
      throw new Error("The Swiftline parcel identifier audit is read-only and does not accept --apply.");
    }
    if (option !== "--expected-database" && option !== "--expected-cluster-host") {
      throw new Error("Use --expected-database swiftline and --expected-cluster-host <approved Atlas SRV host>.");
    }

    const value = args[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires an explicit value.`);
    }
    if (option === "--expected-database") {
      if (options.expectedDatabase) throw new Error("--expected-database may be supplied only once.");
      options.expectedDatabase = value;
    } else {
      if (options.expectedClusterHost) throw new Error("--expected-cluster-host may be supplied only once.");
      options.expectedClusterHost = value;
    }
    index += 1;
  }

  if (!options.expectedDatabase || !options.expectedClusterHost) {
    throw new Error("Both --expected-database swiftline and --expected-cluster-host are required.");
  }
  return options as { expectedDatabase: string; expectedClusterHost: string };
}

/** Resolves an explicit audit-only URI and checks it against the production allowlist. */
export function resolveSwiftlineParcelAuditTarget(
  environment: Record<string, string | undefined>,
  args: readonly string[]
): SwiftlineParcelAuditTarget {
  const uri = environment.TENANT_AUDIT_MONGODB_URI?.trim();
  if (!uri) {
    throw new Error("TENANT_AUDIT_MONGODB_URI is required; the application MONGODB_URI is never used.");
  }
  const options = parseArguments(args);
  const allowedClusterHost = environment.TENANT_MIGRATION_ALLOWED_CLUSTER_HOST?.trim();
  if (!allowedClusterHost) {
    throw new Error("TENANT_MIGRATION_ALLOWED_CLUSTER_HOST must identify the approved production Atlas cluster.");
  }

  // Require a named credential on the separate, explicitly supplied audit URI.
  // Its Atlas user must be provisioned with read-only access to the Swiftline DB.
  parseMongoSrvCredentialUser(uri);
  const target = assertProductionTenantAuditTarget({
    nodeEnvironment: environment.NODE_ENV ?? "",
    expectedDatabase: options.expectedDatabase,
    expectedClusterHost: options.expectedClusterHost,
    mongoUri: uri,
    allowedClusterHost,
    applyRequested: false
  });

  return { uri, ...target };
}

function recordId(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const result = String(value).trim();
    return result || null;
  }
  if (!value || typeof value !== "object" || typeof value.toString !== "function") return null;
  const result = value.toString().trim();
  return result && result !== "[object Object]" ? result : null;
}

/** Reads the legacy collections without tenant middleware or schema/index behavior. */
export async function collectSwiftlineParcelAuditRecords(db: Pick<Db, "collection">) {
  const recordByShipmentId = new Map<string, SwiftlineParcelIdentifierAuditRecord>();
  const shipmentDraftIdByBookingId = new Map<string, string>();
  let shipmentCount = 0;

  // No tenantId predicate is intentional: legacy production rows predate ownership.
  // Native collection reads have no Mongoose query middleware and never create indexes.
  const shipments = db.collection<ShipmentReferences>("dpdshipments").find({}, {
    projection: shipmentProjection,
    batchSize: 500
  });
  try {
    for await (const shipment of shipments) {
      const bookingId = recordId(shipment._id);
      if (!bookingId) continue;
      const shipmentDraftId = recordId(shipment.shipmentDraftId) ?? bookingId;
      const snapshots = [shipment.currentShipmentSnapshot, shipment.bookingSnapshot]
        .filter((snapshot): snapshot is SnapshotReferences => Boolean(snapshot));
      const parcelNumbers = [
        ...(shipment.parcelNumbers ?? []),
        ...snapshots.flatMap((snapshot) => (snapshot.parcels ?? [])
          .map((parcel) => parcel.swiftlineParcelNumber ?? ""))
      ].filter(Boolean);
      const trackingNumbers = [
        shipment.swiftlineTrackingNumber,
        ...snapshots.map((snapshot) => snapshot.tracking?.swiftlineTrackingNumber)
      ].filter((value): value is string => Boolean(value?.trim()));
      const carrierShipmentIds = [shipment.dpdShipmentId, shipment.forwardingNumber, shipment.entryNumber]
        .filter((value): value is string => Boolean(value?.trim()));
      const record = recordByShipmentId.get(shipmentDraftId) ?? {
        shipmentDraftId,
        trackingNumbers: [],
        carrierShipmentIds: [],
        parcelNumbers: []
      };
      recordByShipmentId.set(shipmentDraftId, {
        ...record,
        trackingNumbers: [...(record.trackingNumbers ?? []), ...trackingNumbers],
        carrierShipmentIds: [...(record.carrierShipmentIds ?? []), ...carrierShipmentIds],
        parcelNumbers: [...record.parcelNumbers, ...parcelNumbers]
      });
      shipmentDraftIdByBookingId.set(bookingId, shipmentDraftId);
      shipmentCount += 1;
    }
  } finally {
    await shipments.close();
  }

  // `voidedAt: null` matches both null and absent legacy fields in MongoDB.
  const labels = db.collection<LabelReferences>("labeldocuments").find({ voidedAt: null }, {
    projection: labelProjection,
    batchSize: 500
  });
  try {
    for await (const label of labels) {
      const bookingId = recordId(label.dpdShipmentId);
      const shipmentDraftId = bookingId ? shipmentDraftIdByBookingId.get(bookingId) : undefined;
      if (!shipmentDraftId || !label.parcelNumber) continue;
      const record = recordByShipmentId.get(shipmentDraftId);
      if (!record) continue;
      recordByShipmentId.set(shipmentDraftId, {
        ...record,
        parcelNumbers: [...record.parcelNumbers, label.parcelNumber]
      });
    }
  } finally {
    await labels.close();
  }

  return { shipmentCount, records: [...recordByShipmentId.values()] };
}

function opaqueReference(kind: string, value: string) {
  return `${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Collision details remain correlatable without printing shipment IDs or parcel numbers. */
export function redactSwiftlineParcelAuditCollisions(
  collisions: ReturnType<typeof findSwiftlineParcelIdentifierCollisions>
) {
  return collisions.map((collision) => ({
    identifierRef: opaqueReference("identifier", collision.identifier),
    shipments: collision.shipments.map((shipment) => ({
      shipmentRef: opaqueReference("shipment", shipment.shipmentDraftId),
      sources: shipment.sources
    }))
  }));
}

function redactSensitiveText(value: string) {
  return value
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[MongoDB URI]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, "[phone]")
    .replace(/\b[a-f\d]{24}\b/gi, "[ObjectId]")
    .replace(/\b(password|passwd|pwd|token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 320);
}

/** Safe error text for operators; never emits URI credentials, emails, or ObjectIds. */
export function formatSafeSwiftlineParcelAuditError(error: unknown) {
  const candidate = error instanceof Error ? error : undefined;
  const errorName = candidate?.name && /^[A-Za-z][A-Za-z0-9_$.-]{0,79}$/.test(candidate.name)
    ? candidate.name
    : "Error";
  const details = error as { code?: unknown; codeName?: unknown } | null;
  const rawCode = details && typeof details === "object" ? details.codeName ?? details.code : undefined;
  const code = typeof rawCode === "number"
    ? String(rawCode)
    : typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(rawCode)
      ? rawCode
      : undefined;
  const rawMessage = candidate?.message ?? (typeof error === "string" ? error : "Audit failed without an Error message.");
  const message = redactSensitiveText(rawMessage) || "Audit failed without an Error message.";
  return `${errorName}${code ? ` (${code})` : ""}: ${message}`;
}

async function runAudit(args: readonly string[]) {
  const target = resolveSwiftlineParcelAuditTarget(process.env, args);
  const client = new MongoClient(target.uri, {
    readPreference: "primary",
    serverSelectionTimeoutMS: 15_000
  });

  try {
    await client.connect();
    const { shipmentCount, records } = await collectSwiftlineParcelAuditRecords(client.db(target.database));
    const collisions = findSwiftlineParcelIdentifierCollisions(records);
    process.stdout.write(`${JSON.stringify({
      target: { database: target.database, atlasClusterHost: target.clusterHost },
      shipmentCount,
      collisionCount: collisions.length,
      collisions: redactSwiftlineParcelAuditCollisions(collisions)
    }, null, 2)}\n`);
    if (collisions.length) process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (isMainModule(import.meta.url)) {
  void runAudit(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Swiftline parcel identifier audit failed: ${formatSafeSwiftlineParcelAuditError(error)}`);
    process.exitCode = 1;
  });
}
