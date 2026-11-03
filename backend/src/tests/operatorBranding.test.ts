import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  isOperatorBrandLogoStorageKey,
  isRenderableOperatorBrandLogo,
  isValidOperatorBrandLogo,
  operatorBrandLogoStorageKey
} from "../services/operatorBranding.service.js";

function png(width: number, height: number) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width: number, height: number) {
  const buffer = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x08, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9
  ]);
  return buffer;
}

describe("operator company logo policy", () => {
  test("accepts correctly signed JPG and PNG files within the pixel limit", () => {
    assert.equal(isValidOperatorBrandLogo(png(512, 256), "image/png"), true);
    assert.equal(isValidOperatorBrandLogo(jpeg(256, 512), "image/jpeg"), true);
  });

  test("rejects MIME spoofing, malformed images, and excessive pixel dimensions", () => {
    assert.equal(isValidOperatorBrandLogo(png(512, 256), "image/jpeg"), false);
    assert.equal(isValidOperatorBrandLogo(png(0, 256), "image/png"), false);
    assert.equal(isValidOperatorBrandLogo(png(4097, 1), "image/png"), false);
    assert.equal(isValidOperatorBrandLogo(Buffer.from("not an image"), "image/png"), false);
    assert.equal(isValidOperatorBrandLogo(Buffer.alloc(2 * 1024 * 1024 + 1), "image/png"), false);
  });

  test("confirms supported images can be parsed by the invoice PDF renderer", async () => {
    const valid = readFileSync(new URL("../../assets/swiftline-label-logo.png", import.meta.url));
    assert.equal(await isRenderableOperatorBrandLogo(valid, "image/png"), true);
    assert.equal(await isRenderableOperatorBrandLogo(png(512, 256), "image/png"), false);
  });

  test("stores logos under a generated key owned by the operator tenant", () => {
    const key = operatorBrandLogoStorageKey("tenant-123", "../../company-logo.png");
    assert.equal(isOperatorBrandLogoStorageKey("tenant-123", key), true);
    assert.equal(isOperatorBrandLogoStorageKey("other-tenant", key), false);
    assert.match(key, /^operator-branding\/tenant-123\/logo\/[0-9a-f-]+\.png$/);
    assert.equal(key.includes("company-logo"), false);
  });
});
