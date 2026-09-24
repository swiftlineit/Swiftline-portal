import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmptyParcelItem,
  composeShipmentDescription,
  getShipmentDescriptionLimitMessage,
  isUntouchedParcelItem,
  mergeSavedParcelItemsWithLocalRows,
  maxParcelItems,
  type ParcelItem
} from "./parcelItems";

function item(overrides: Partial<ParcelItem> = {}): ParcelItem {
  return { ...createEmptyParcelItem(), ...overrides };
}

test("supports up to 50 item lines per parcel", () => {
  assert.equal(maxParcelItems, 50);
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
