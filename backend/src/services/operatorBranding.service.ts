import PDFDocument from "pdfkit";
import { matchesDeclaredType } from "./storage/fileSignature.js";
import {
  operatorBrandBannerKey,
  operatorBrandBannerPrefix,
  operatorBrandLogoKey,
  operatorBrandLogoPrefix
} from "./storage/keys.js";
import { assertValidStorageKey, getObjectBuffer } from "./storage/storage.service.js";

export const operatorBrandLogoMaxBytes = 2 * 1024 * 1024;
const maximumLogoDimension = 4096;

type ImageDimensions = { width: number; height: number };

function pngDimensions(buffer: Buffer): ImageDimensions | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4
    || !matchesDeclaredType(buffer, "image/jpeg")
    || buffer[buffer.length - 2] !== 0xff
    || buffer[buffer.length - 1] !== 0xd9) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let dimensions: ImageDimensions | null = null;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset++]!;
    if (marker === 0xda) return dimensions;
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buffer.length) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 8) return null;
      dimensions = {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += segmentLength;
  }

  return null;
}

function hasSafeDimensions(dimensions: ImageDimensions | null): boolean {
  if (!dimensions) return false;
  const { width, height } = dimensions;
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= maximumLogoDimension
    && height <= maximumLogoDimension
    && width * height <= maximumLogoDimension * maximumLogoDimension;
}

/** Rejects MIME spoofing, malformed headers, and decompression-sized logo images. */
export function isValidOperatorBrandLogo(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length === 0 || buffer.length > operatorBrandLogoMaxBytes || !matchesDeclaredType(buffer, mimeType)) {
    return false;
  }
  if (mimeType === "image/png") return hasSafeDimensions(pngDimensions(buffer));
  if (mimeType === "image/jpeg") return hasSafeDimensions(jpegDimensions(buffer));
  return false;
}

/** Asks the same PDF renderer used for invoices to parse the uploaded image. */
export async function isRenderableOperatorBrandLogo(buffer: Buffer, mimeType: string): Promise<boolean> {
  if (!isValidOperatorBrandLogo(buffer, mimeType)) return false;
  return new Promise<boolean>((resolve) => {
    const document = new PDFDocument({ size: [128, 128], margin: 0 });
    let completed = false;
    const finish = (result: boolean) => {
      if (completed) return;
      completed = true;
      resolve(result);
    };
    document.on("data", () => undefined);
    document.on("error", () => finish(false));
    document.on("end", () => finish(true));
    try {
      document.image(buffer, 8, 8, { fit: [112, 112] });
      document.end();
    } catch {
      finish(false);
      try { document.end(); } catch { /* image parsing may already have closed the document */ }
    }
  });
}

export function operatorBrandLogoStorageKey(tenantId: string, originalName: string) {
  return operatorBrandLogoKey(tenantId, originalName);
}

export function isOperatorBrandLogoStorageKey(tenantId: string, storageKey: string) {
  return storageKey.startsWith(operatorBrandLogoPrefix(tenantId));
}

export function operatorBrandBannerStorageKey(tenantId: string, originalName: string) {
  return operatorBrandBannerKey(tenantId, originalName);
}

export function isOperatorBrandBannerStorageKey(tenantId: string, storageKey: string) {
  return storageKey.startsWith(operatorBrandBannerPrefix(tenantId));
}

/** Loads a logo only when its stored key belongs to the requesting operator. */
export async function loadOperatorBrandLogo(tenantId: string, storageKey: string): Promise<Buffer | undefined> {
  if (!isOperatorBrandLogoStorageKey(tenantId, storageKey)) return undefined;
  try {
    assertValidStorageKey(storageKey);
    return await getObjectBuffer(storageKey);
  } catch {
    return undefined;
  }
}
