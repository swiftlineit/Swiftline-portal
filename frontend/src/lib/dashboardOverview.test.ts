import assert from "node:assert/strict";
import { test } from "node:test";
import { quickLinksForRole } from "./dashboardOverview";

test("admin quick access contains each destination once", () => {
  const links = quickLinksForRole("admin");
  const hrefs = links.map((link) => link.href);

  assert.equal(new Set(hrefs).size, hrefs.length);
  assert.equal(hrefs.filter((href) => href === "/dashboard/business-accounts").length, 1);
});
