import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { updateShipmentDraft } from "../controllers/shipmentDraft.controller.js";

async function itemPatchErrors(item: Record<string, unknown>): Promise<string[]> {
  let status = 0;
  let payload: { errors?: string[] } = {};
  const response = {
    status(code: number) { status = code; return this; },
    json(body: { errors?: string[] }) { payload = body; return this; }
  } as unknown as Response;
  const request = {
    user: { _id: "507f1f77bcf86cd799439011" },
    params: { id: "507f1f77bcf86cd799439012" },
    body: {
      parcelList: [{
        sequence: 1,
        weightKg: 1,
        shipmentContentType: "PARCEL",
        contentsDescription: "BOOKS",
        items: [{ description: "BOOKS", hsnCode: "4901", unitType: "Pcs", quantity: 1, unitRate: 1, ...item }]
      }]
    }
  } as unknown as Request;

  await updateShipmentDraft(request, response);
  assert.equal(status, 400);
  return payload.errors ?? [];
}

test("draft item value limits name the parcel, item, and field", async () => {
  const errors = await itemPatchErrors({ quantity: 1_000_001, unitRate: 10_000_000.01 });
  assert.ok(errors.includes("Parcel 1 item 1: Quantity must be 1,000,000 or less"));
  assert.ok(errors.includes("Parcel 1 item 1: Unit rate must be 10,000,000 or less"));
  assert.ok(errors.every((error) => !error.startsWith("Too big")));
});

test("other item field errors also identify the field", async () => {
  const errors = await itemPatchErrors({
    description: "B".repeat(121),
    hsnCode: "1".repeat(11),
    quantity: -1,
    unitRate: -1
  });
  assert.ok(errors.includes("Parcel 1 item 1: Description must be 120 characters or fewer"));
  assert.ok(errors.includes("Parcel 1 item 1: HS code must be 10 characters or fewer"));
  assert.ok(errors.includes("Parcel 1 item 1: Quantity must be zero or greater"));
  assert.ok(errors.includes("Parcel 1 item 1: Unit rate must be zero or greater"));
});
