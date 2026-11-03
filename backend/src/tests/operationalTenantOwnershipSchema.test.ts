import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { CancellationDocumentCounter } from "../models/cancellationDocumentCounter.model.js";
import { CancellationFeeInvoice } from "../models/cancellationFeeInvoice.model.js";
import { CountryRateCard } from "../models/countryRateCard.model.js";
import { CountryRouteCharge } from "../models/countryRouteCharge.model.js";
import { EmailOutbox } from "../models/emailOutbox.model.js";
import { IdempotencyKey } from "../models/idempotencyKey.model.js";
import { PortalNotification } from "../models/portalNotification.model.js";
import { ShipmentCreditNote } from "../models/shipmentCreditNote.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentInvoiceCounter } from "../models/shipmentInvoiceCounter.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { ShipmentManifestCounter } from "../models/shipmentManifestCounter.model.js";
import { indexSatisfiesPlan } from "../scripts/tenantMigrationIndexHelpers.js";

type ModelWithIndexes = mongoose.Model<any>;
type SchemaIndex = [Record<string, unknown>, mongoose.IndexOptions];

function schemaIndexes(model: ModelWithIndexes): SchemaIndex[] {
  return model.schema.indexes() as SchemaIndex[];
}

const tenantOwnedModels: ModelWithIndexes[] = [
  AuditLog,
  CancellationDocumentCounter,
  CancellationFeeInvoice,
  CountryRateCard,
  CountryRouteCharge,
  EmailOutbox,
  IdempotencyKey,
  PortalNotification,
  ShipmentCreditNote,
  ShipmentInvoice,
  ShipmentInvoiceCounter,
  ShipmentManifest,
  ShipmentManifestCounter
];

function hasUniqueIndex(model: ModelWithIndexes, fields: Record<string, number>) {
  return schemaIndexes(model).some(([keys, options]) =>
    options.unique === true &&
    Object.keys(fields).length === Object.keys(keys).length &&
    Object.entries(fields).every(([field, direction]) => keys[field] === direction)
  );
}

function hasIndex(model: ModelWithIndexes, fields: Record<string, number>) {
  return schemaIndexes(model).some(([keys, options]) =>
    options.unique !== true &&
    Object.keys(fields).length === Object.keys(keys).length &&
    Object.entries(fields).every(([field, direction]) => keys[field] === direction)
  );
}

describe("operational tenant-owned model schemas", () => {
  test("every release-critical support model declares tenant ownership", () => {
    for (const model of tenantOwnedModels) {
      const tenantId = model.schema.path("tenantId");
      assert.equal(tenantId?.instance, "ObjectId", `${model.modelName} tenantId type`);
      assert.equal(tenantId?.options.ref, "Tenant", `${model.modelName} tenantId reference`);
      assert.ok(
        schemaIndexes(model).some(([keys, options]) =>
          keys.tenantId === 1 && options.name === "tenant_id"
        ),
        `${model.modelName} tenant lookup index`
      );
    }
  });

  test("an existing equivalent SES callback index satisfies the additional index plan", () => {
    const plan = { key: { sesMessageId: 1 }, options: { name: "email_outbox_ses_message_id" } };
    assert.equal(indexSatisfiesPlan(
      { name: "sesMessageId_1", key: { sesMessageId: 1 }, unique: false },
      plan
    ), true);
    assert.equal(indexSatisfiesPlan(
      { name: "sesMessageId_1", key: { sesMessageId: 1 }, unique: true },
      plan
    ), false);
  });

  test("business and document uniqueness is tenant-local", () => {
    const expected: Array<[ModelWithIndexes, Record<string, number>]> = [
      [CountryRouteCharge, { tenantId: 1, businessAccountId: 1, band: 1, countryCode: 1, service: 1 }],
      [EmailOutbox, { tenantId: 1, idempotencyKey: 1 }],
      [CancellationDocumentCounter, { tenantId: 1, financialYear: 1, documentType: 1 }],
      [CancellationFeeInvoice, { tenantId: 1, invoiceNumber: 1 }],
      [CancellationFeeInvoice, { tenantId: 1, cancellationId: 1 }],
      [IdempotencyKey, { tenantId: 1, scope: 1, userId: 1, key: 1 }],
      [PortalNotification, { tenantId: 1, idempotencyKey: 1 }],
      [ShipmentCreditNote, { tenantId: 1, creditNoteNumber: 1 }],
      [ShipmentCreditNote, { tenantId: 1, cancellationId: 1 }],
      [ShipmentInvoice, { tenantId: 1, invoiceNumber: 1 }],
      [ShipmentInvoice, { tenantId: 1, shipmentDraftId: 1 }],
      [ShipmentInvoice, { tenantId: 1, dpdShipmentId: 1 }],
      [ShipmentInvoiceCounter, { tenantId: 1, financialYear: 1 }],
      [ShipmentManifest, { tenantId: 1, manifestNumber: 1 }],
      [ShipmentManifest, { tenantId: 1, shipmentDraftIds: 1, actorRole: 1, manifestType: 1 }]
    ];

    for (const [model, fields] of expected) {
      assert.ok(hasUniqueIndex(model, fields), `${model.modelName} unique index ${Object.keys(fields).join(",")}`);
    }
    const queryIndexes: Array<[ModelWithIndexes, Record<string, number>]> = [
      [CountryRateCard, { tenantId: 1, band: 1, countryCode: 1, service: 1, fromKg: 1, toKg: 1 }],
      [CountryRateCard, { tenantId: 1, businessAccountId: 1, countryCode: 1, service: 1, fromKg: 1, toKg: 1 }],
      [PortalNotification, { tenantId: 1, recipientUserId: 1, createdAt: -1 }],
      [PortalNotification, { tenantId: 1, recipientUserId: 1, readAt: 1 }],
      [EmailOutbox, { tenantId: 1, status: 1, nextAttemptAt: 1, priority: -1 }],
      [EmailOutbox, { tenantId: 1, businessAccountId: 1, createdAt: -1 }],
      [EmailOutbox, { tenantId: 1, toEmail: 1, createdAt: -1 }],
      [EmailOutbox, { sesMessageId: 1 }]
    ];
    for (const [model, fields] of queryIndexes) {
      assert.ok(hasIndex(model, fields), `${model.modelName} query index ${Object.keys(fields).join(",")}`);
    }
    for (const model of tenantOwnedModels) {
      const unscopedUnique = schemaIndexes(model).find(([keys, options]) =>
        options.unique === true && keys.tenantId !== 1
      );
      assert.equal(unscopedUnique, undefined, `${model.modelName} has no tenant-global unique index`);
    }
  });
});
