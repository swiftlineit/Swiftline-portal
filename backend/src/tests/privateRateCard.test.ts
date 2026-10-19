import assert from "node:assert/strict";
import test from "node:test";
import { accountRateCardScope, rateCardFilter } from "../services/rateCardScope.service.js";
import { assertRateCardSource, rateCardChecksum } from "../services/privateRateCardMigration.service.js";

test("private ownership always wins over a retained legacy source band", () => {
  const id = "507f1f77bcf86cd799439011";
  const scope = accountRateCardScope({ _id: id, rateCardBand: "BAND_C", privateRateCardVersion: 3 });
  assert.equal(String(rateCardFilter(scope).businessAccountId), id);
  assert.equal(rateCardFilter(scope).band, undefined);
  assert.deepEqual(accountRateCardScope({ _id: id, accountKind: "INDIVIDUAL_SENTINEL" }), { band: "BAND_D" });
});
test("migration verifies commercial fields and refuses overlaps or duplicate charges", () => {
  const rate = { countryCode: "GB", countryName: "United Kingdom", service: "COURIER", fromKg: 0, toKg: 10, chargesPerKg: 420, maxBoxKg: 30 };
  assert.throws(() => assertRateCardSource([rate, { ...rate, fromKg: 5, toKg: 15 }], []), /overlap/i);
  const charge = { countryCode: "GB", service: "COURIER", handlingCharge: 25 };
  assert.throws(() => assertRateCardSource([rate], [charge, charge]), /duplicate/i);
  assert.notEqual(rateCardChecksum([rate], [charge]), rateCardChecksum([rate], [{ ...charge, handlingCharge: 30 }]));
  assert.equal(rateCardChecksum([rate], [charge]), rateCardChecksum([{ ...rate, gstTreatment: "EXCLUDED", gstRatePercent: 0, gstApplyToAllRates: false }], [charge]));
});
