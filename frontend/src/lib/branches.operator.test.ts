import assert from "node:assert/strict";
import { test } from "node:test";
import { branchDocumentUrl, branchImageUrl } from "@/lib/branches";

test("branch file URLs preserve the Swiftline endpoint by default", () => {
  assert.equal(branchImageUrl("507f1f77bcf86cd799439011", 2), "/api/v1/branches/507f1f77bcf86cd799439011/images/2");
  assert.equal(branchDocumentUrl("507f1f77bcf86cd799439011", 1), "/api/v1/branches/507f1f77bcf86cd799439011/documents/1");
});

test("branch file URLs include the operator slug and tenant route", () => {
  assert.equal(branchImageUrl("507f1f77bcf86cd799439011", 2, "northstar-cargo"), "/api/v1/operators/northstar-cargo/branches/507f1f77bcf86cd799439011/images/2");
  assert.equal(branchDocumentUrl("507f1f77bcf86cd799439011", 1, "north star"), "/api/v1/operators/north%20star/branches/507f1f77bcf86cd799439011/documents/1");
});
