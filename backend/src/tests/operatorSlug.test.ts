import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { updateOperatorCompanyProfile, updateOperatorPortalSlug } from "../controllers/operatorSettings.controller.js";
import {
  normalizeTenantSlug,
  resolveOperatorSlugForCompanyNameChange,
  TenantRegistryError
} from "../services/tenantRegistry.service.js";

describe("operator portal slug validation", () => {
  test("normalizes an operator-edited identifier consistently", () => {
    assert.equal(normalizeTenantSlug("  Northstar Logistics  "), "northstar-logistics");
    assert.equal(normalizeTenantSlug("Acme Cargo & Express"), "acme-cargo-express");
  });

  test("rejects reserved and overlong identifiers", () => {
    for (const invalid of ["swiftline", "platform", "a".repeat(64)]) {
      assert.throws(() => normalizeTenantSlug(invalid), TenantRegistryError);
    }
  });

  test("updates a default slug with its company name and preserves custom slugs", () => {
    assert.equal(resolveOperatorSlugForCompanyNameChange({
      oldCompanyName: "Northstar Cargo",
      currentSlug: "northstar-cargo",
      newCompanyName: "Northstar Express"
    }), "northstar-express");
    assert.equal(resolveOperatorSlugForCompanyNameChange({
      oldCompanyName: "Northstar Cargo",
      currentSlug: "northstar-portal",
      newCompanyName: "Northstar Express"
    }), "northstar-portal");
  });

  test("rejects extra client-supplied ownership fields before changing a slug", async () => {
    let statusCode = 200;
    let body: unknown;
    const request = {
      body: { slug: "northstar", tenantId: new mongoose.Types.ObjectId().toString() },
      user: { _id: new mongoose.Types.ObjectId() },
      operatorContext: {
        tenantId: new mongoose.Types.ObjectId(),
        slug: "northstar-cargo",
        role: "OPERATOR_ADMIN",
        assignedBranches: []
      }
    } as unknown as Request;
    const response = {
      status(code: number) { statusCode = code; return this; },
      json(payload: unknown) { body = payload; return this; }
    } as unknown as Response;

    await updateOperatorPortalSlug(request, response);

    assert.equal(statusCode, 400);
    assert.deepEqual(body, { success: false, message: "Enter a valid URL identifier." });
  });

  test("rejects extra client-supplied ownership fields before changing company settings", async () => {
    let statusCode = 200;
    let body: unknown;
    const request = {
      body: { companyName: "Northstar Express", tenantId: new mongoose.Types.ObjectId().toString() },
      user: { _id: new mongoose.Types.ObjectId() },
      operatorContext: {
        tenantId: new mongoose.Types.ObjectId(),
        slug: "northstar-cargo",
        role: "OPERATOR_ADMIN",
        assignedBranches: []
      }
    } as unknown as Request;
    const response = {
      status(code: number) { statusCode = code; return this; },
      json(payload: unknown) { body = payload; return this; }
    } as unknown as Response;

    await updateOperatorCompanyProfile(request, response);

    assert.equal(statusCode, 400);
    assert.deepEqual(body, { success: false, message: "Enter a company name with 1 to 160 characters." });
  });
});
