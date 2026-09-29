import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmptyParcelItem,
  composeShipmentDescription,
  getParcelItemAmountError,
  getPositiveNumberError,
  getShipmentDescriptionLimitMessage,
  isUntouchedParcelItem,
  mergeSavedParcelItemsWithLocalRows,
  maxParcelItems,
  maxParcelItemAmountExclusive,
  maxShipmentItemQuantity,
  maxShipmentItemUnitRate,
  type ParcelItem
} from "./parcelItems";

function item(overrides: Partial<ParcelItem> = {}): ParcelItem {
  return { ...createEmptyParcelItem(), ...overrides };
}

test("supports up to 50 item lines per parcel", () => {
  assert.equal(maxParcelItems, 50);
});

test("allows item amounts below 5001 and rejects 5001 or more", () => {
  assert.equal(maxParcelItemAmountExclusive, 5001);
  assert.equal(getParcelItemAmountError(item({ quantity: "1", unitRate: "5000" })), "");
  assert.equal(getParcelItemAmountError(item({ quantity: "1", unitRate: "5000.99" })), "");
  assert.equal(getParcelItemAmountError(item({ quantity: "2", unitRate: "2500" })), "");
  assert.equal(getParcelItemAmountError(item({ quantity: "1", unitRate: "5001" })), "Item amount must be below 5001.");
  assert.equal(getParcelItemAmountError(item({ quantity: "2", unitRate: "2500.5" }), false), "");
});

test("names the field and limit before an item exceeds the draft API bounds", () => {
  assert.equal(getPositiveNumberError("1000000", "Quantity", maxShipmentItemQuantity), "");
  assert.equal(getPositiveNumberError("1000001", "Quantity", maxShipmentItemQuantity), "Quantity must be 1,000,000 or less.");
  assert.equal(getPositiveNumberError("10000000", "Unit rate", maxShipmentItemUnitRate), "");
  assert.equal(getPositiveNumberError("10000000.01", "Unit rate", maxShipmentItemUnitRate), "Unit rate must be 10,000,000 or less.");
  assert.equal(getPositiveNumberError("0", "Quantity", maxShipmentItemQuantity), "Quantity must be greater than zero.");
  assert.equal(getPositiveNumberError("", "Unit rate", maxShipmentItemUnitRate), "Unit rate is required.");
  assert.equal(getPositiveNumberError("10000000.01", "Unit rate", 100_000_000), "");
});

test("counts all parcel item descriptions with comma separators", () => {
  const description = composeShipmentDescription([
    { items: [item({ description: "A" }), item({ description: "B" })] },
    { items: [item({ description: "C" })] }
  ]);

  assert.equal(description, "A, B, C");
  assert.equal(description.length, 7);
  assert.equal(getShipmentDescriptionLimitMessage([{ items: [item({ description: "A" })] }]), "");
});

test("reports the exact excess only above the 240-character shipment limit", () => {
  assert.equal(
    getShipmentDescriptionLimitMessage([{ items: [item({ description: "x".repeat(240) })] }]),
    ""
  );

  const items = [item({ description: "x".repeat(120) }), item({ description: "y".repeat(120) }), item({ description: "z" })];
  const message = getShipmentDescriptionLimitMessage([{ items }]);

  assert.match(message, /current combined description is 245 characters/);
  assert.match(message, /exceeds the limit by 5/);
  assert.equal(getShipmentDescriptionLimitMessage([{ items }], false), "");
});

test("recognizes only a completely untouched item row as UI-only", () => {
  assert.equal(isUntouchedParcelItem(createEmptyParcelItem()), true);
  assert.equal(isUntouchedParcelItem(item({ description: "BOOKS" })), false);
  assert.equal(isUntouchedParcelItem(item({ hsnCode: "4901" })), false);
  assert.equal(isUntouchedParcelItem(item({ quantity: "2" })), false);
  assert.equal(isUntouchedParcelItem(item({ unitRate: "10" })), false);
  assert.equal(isUntouchedParcelItem(item({ unitType: "Box" })), false);
});

test("keeps an appended blank row when autosave returns persisted items", () => {
  const localItems = [
    item({ description: "BOOKS", hsnCode: "4901", quantity: "2", unitRate: "10" }),
    createEmptyParcelItem()
  ];
  const savedItems = [
    item({ description: "BOOKS", hsnCode: "4901", quantity: "2", unitRate: "10" })
  ];

  assert.deepEqual(
    mergeSavedParcelItemsWithLocalRows(savedItems, localItems),
    localItems
  );
});

test("keeps every blank row when an empty draft response supplies one placeholder", () => {
  const localItems = [createEmptyParcelItem(), createEmptyParcelItem()];

  assert.deepEqual(
    mergeSavedParcelItemsWithLocalRows(
      [createEmptyParcelItem()],
      localItems
    ),
    localItems
  );
});

test("keeps an incomplete local row in place while applying saved values", () => {
  const incomplete = item({ quantity: "3", unitRate: "25" });
  const localSaved = item({ description: "SHIRTS", hsnCode: "6105", quantity: "02", unitRate: "15" });
  const normalizedSaved = item({ description: "SHIRTS", hsnCode: "6105", quantity: "2", unitRate: "15" });

  assert.deepEqual(
    mergeSavedParcelItemsWithLocalRows(
      [normalizedSaved],
      [incomplete, localSaved]
    ),
    [incomplete, normalizedSaved]
  );
});
