import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { mock, test } from "node:test";
import mongoose from "mongoose";
import {
  submitBusinessAccount,
  updateOperatorNoCompanyBillingAddress
} from "../controllers/businessAccount.controller.js";
import { AuditLog } from "../models/auditLog.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { runWithTenantContext } from "../services/tenantScope.service.js";

function responseRecorder() {
  const result: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const response = {
    status(code: number) {
      result.statusCode = code;
      return response;
    },
    json(body: unknown) {
      result.body = body;
      return response;
    }
  };
  return { response: response as unknown as Response, result };
}

function requestFor(userId: mongoose.Types.ObjectId, billingAddress: unknown): Request {
  return {
    params: { accountId: "BA-2026-123456" },
    body: { billingAddress },
    user: { _id: userId }
  } as unknown as Request;
}

function noCompanyDraftAccount() {
  return {
    accountId: "BA-2026-123456",
    status: "draft",
    contact: {
      title: "mr.",
      firstName: "Aman",
      lastName: "Negi",
      email: "aman@example.com",
      mobileType: "mobile",
      countryCode: "+91",
      mobileNumber: "8745654567",
      jobTitle: "Owner",
      department: "Logistics",
      shipmentTypes: ["international_courier"]
    },
    company: {
      registrationCountry: "India",
      registrationIdType: "pan",
      registrationId: "",
      gstin: "",
      gstExempt: false,
      gstExemptReason: "",
      secondaryRegistrationId: "",
      noCompanyRegistration: true,
      noCompany: true,
      companyType: "",
      companyName: "",
      registeredAddress: "",
      addressLine2: "",
      city: "",
      stateOrProvince: "",
      postalCode: "",
      addressCountry: "India",
      useCompanyAddressAsBillingAddress: true,
      billingAddress: null,
      operatingCountries: [],
      website: null,
      industry: "",
      monthlyShipmentVolume: "",
      requestedCreditLimit: { currency: "INR", amount: null }
    },
    gstBilling: { requestedTreatment: "GST_APPLICABLE", requestReason: "" },
    documents: {}
  };
}

test("operator billing address updates are tenant-gated and audited without storing address values in the audit", async () => {
  const tenantId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const account = {
    _id: new mongoose.Types.ObjectId(),
    accountId: "BA-2026-123456",
    status: "draft",
    company: {
      noCompany: true,
      useCompanyAddressAsBillingAddress: true,
      billingAddress: null
    },
    updatedBy: null as mongoose.Types.ObjectId | null,
    creditLimitStatus: undefined,
    depositStatus: undefined,
    agreementStatus: undefined,
    ledgerViewedAt: null as Date | null,
    gstBilling: undefined,
    updatedAt: new Date(),
    async save() { return undefined; }
  };
  const address = {
    addressLine1: "12 Market Road",
    addressLine2: "",
    city: "New Delhi",
    stateOrProvince: "Delhi",
    postalCode: "110001",
    country: "India"
  };
  let findOneCalls = 0;
  const auditEntries: Array<Record<string, unknown>> = [];

  try {
    mock.method(BusinessAccount, "findOne", (filter: unknown) => {
      findOneCalls += 1;
      assert.deepEqual(filter, { accountId: "BA-2026-123456" });
      if (findOneCalls === 1) return { exec: async () => account } as never;

      const query = {
        populate() { return query; },
        lean() { return query; },
        exec: async () => ({ ...account, company: { ...account.company, billingAddress: { ...address } } })
      };
      return query as never;
    });
    mock.method(AuditLog, "create", async (entry: unknown) => {
      auditEntries.push(entry as Record<string, unknown>);
      return {} as never;
    });

    const { response, result } = responseRecorder();
    await runWithTenantContext({ tenantId, kind: "OPERATOR" }, () =>
      updateOperatorNoCompanyBillingAddress(requestFor(userId, address), response)
    );

    assert.equal(result.statusCode, 200);
    assert.deepEqual(account.company.billingAddress, address);
    assert.equal(account.company.useCompanyAddressAsBillingAddress, false);
    assert.equal(String(account.updatedBy), String(userId));
    const changes = (auditEntries[0]?.metadata as { changes: Record<string, { from: string; to: string }> }).changes;
    assert.deepEqual(changes["company.billingAddress"], {
      from: "[not set]",
      to: "[updated address]"
    });
    assert.equal(JSON.stringify(auditEntries).includes("12 Market Road"), false);
  } finally {
    mock.restoreAll();
  }
});

test("billing address endpoint rejects calls outside an operator tenant before querying accounts", async () => {
  const { response, result } = responseRecorder();
  await updateOperatorNoCompanyBillingAddress(
    requestFor(new mongoose.Types.ObjectId(), {
      addressLine1: "12 Market Road",
      city: "New Delhi",
      stateOrProvince: "Delhi",
      postalCode: "110001",
      country: "India"
    }),
    response
  );

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.body, {
    success: false,
    message: "Operator workspace access is required."
  });
});

test("operator draft submission requires a no-company billing address while Swiftline does not", async () => {
  const userId = new mongoose.Types.ObjectId();
  const account = noCompanyDraftAccount();

  try {
    mock.method(BusinessAccount, "findOne", () => ({ exec: async () => account }) as never);

    const operatorResult = responseRecorder();
    await runWithTenantContext({ tenantId: new mongoose.Types.ObjectId(), kind: "OPERATOR" }, () =>
      submitBusinessAccount(requestFor(userId, {}), operatorResult.response)
    );
    assert.equal(operatorResult.result.statusCode, 400);
    assert.match(JSON.stringify(operatorResult.result.body), /Billing address is required/);

    const swiftlineResult = responseRecorder();
    await runWithTenantContext({ tenantId: new mongoose.Types.ObjectId(), kind: "SWIFTLINE" }, () =>
      submitBusinessAccount(requestFor(userId, {}), swiftlineResult.response)
    );
    assert.equal(swiftlineResult.result.statusCode, 400);
    assert.doesNotMatch(JSON.stringify(swiftlineResult.result.body), /Billing address is required/);
  } finally {
    mock.restoreAll();
  }
});
