import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BusinessAccount } from "../models/businessAccount.model.js";
import {
  businessAccountLegacyUniqueKeys,
  duplicateTenantIdentityPipeline,
  sameIndexKey,
  tenantScopedUniqueIndexes
} from "../scripts/tenantIdentityIndexMigration.js";

describe("business account tenant identity indexes", () => {
  test("enforces account and live identity uniqueness inside each tenant", () => {
    const plans = tenantScopedUniqueIndexes(BusinessAccount);
    const keys = plans.map((plan) => plan.key);
    for (const key of [
      { tenantId: 1, accountId: 1 },
      { tenantId: 1, "contact.email": 1 },
      { tenantId: 1, "contact.countryCode": 1, "contact.mobileNumber": 1 },
      { tenantId: 1, "company.registrationIdKey": 1 }
    ]) {
      assert.ok(keys.some((actual) => sameIndexKey(actual, key)), `missing tenant unique index ${JSON.stringify(key)}`);
    }
  });

  test("keeps the existing live-status and blank-registration exclusions", () => {
    const plans = tenantScopedUniqueIndexes(BusinessAccount);
    const email = plans.find((plan) => plan.key["contact.email"] === 1);
    const registration = plans.find((plan) => plan.key["company.registrationIdKey"] === 1);
    assert.deepEqual(email?.options.partialFilterExpression, {
      status: { $in: ["draft", "pending_review", "approved", "active", "suspended"] }
    });
    assert.deepEqual(registration?.options.partialFilterExpression, {
      status: { $in: ["draft", "pending_review", "approved", "active", "suspended"] },
      "company.registrationIdKey": { $type: "string", $gt: "" }
    });
  });

  test("groups duplicate checks by tenant and includes every indexed field", () => {
    const plans = tenantScopedUniqueIndexes(BusinessAccount);
    const mobile = plans.find((plan) => plan.key["contact.countryCode"] === 1);
    assert.ok(mobile);
    const pipeline = duplicateTenantIdentityPipeline(mobile);
    assert.deepEqual(pipeline[1], {
      $group: {
        _id: {
          key0: "$tenantId",
          key1: "$contact.countryCode",
          key2: "$contact.mobileNumber"
        },
        count: { $sum: 1 }
      }
    });
    assert.deepEqual(businessAccountLegacyUniqueKeys, [
      { accountId: 1 },
      { "contact.email": 1 },
      { "contact.countryCode": 1, "contact.mobileNumber": 1 },
      { "company.registrationIdKey": 1 }
    ]);
  });

  test("does not retain global unique identity indexes in the model schema", () => {
    const indexes = BusinessAccount.schema.indexes() as Array<[Record<string, number>, { unique?: boolean }]>;
    const globalUniqueIdentityIndexes = indexes.filter(([key, options]) =>
      options.unique === true && key.tenantId !== 1 &&
      ["accountId", "contact.email", "contact.countryCode", "company.registrationIdKey"].some((field) => key[field] === 1)
    );
    assert.deepEqual(globalUniqueIdentityIndexes, []);
  });
});
