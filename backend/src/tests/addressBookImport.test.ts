import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildAddressBookTemplateCsv,
  buildAddressBookTemplateWorkbook,
  parseAddressBookImport
} from "../services/addressBookImport.service.js";

describe("address book CSV and Excel imports", () => {
  test("builds templates that parse into the same valid example row", async () => {
    const [xlsx, csv] = await Promise.all([
      parseAddressBookImport(await buildAddressBookTemplateWorkbook(), ".xlsx"),
      parseAddressBookImport(buildAddressBookTemplateCsv(), ".csv")
    ]);
    assert.equal(xlsx.rows.length, 1);
    assert.equal(csv.rows.length, 1);
    assert.deepEqual(xlsx.rows[0]?.errors, []);
    assert.deepEqual(csv.rows[0]?.errors, []);
    assert.equal(xlsx.rows[0]?.data?.postcode, "UB4 0QR");
    assert.equal(csv.rows[0]?.data?.contactName, "JANE SMITH");
  });

  test("rejects a sender outside India", async () => {
    const csv = buildAddressBookTemplateCsv().toString("utf8").replace("Recipient", "Sender");
    const parsed = await parseAddressBookImport(Buffer.from(csv), ".csv");
    assert.ok(parsed.rows[0]?.errors.some((issue) => issue.includes("must be in India")));
  });

  test("rejects a dial code from a different country than the address", async () => {
    const csv = buildAddressBookTemplateCsv().toString("utf8").replace("+44", "+1").replace("7911123456", "2025550123");
    const parsed = await parseAddressBookImport(Buffer.from(csv), ".csv");
    assert.ok(parsed.rows[0]?.errors.some((issue) => issue.includes("must match the address country")));
  });
});
