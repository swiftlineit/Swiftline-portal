import { readFile } from "node:fs/promises";
import type { EmailContent } from "./layout.js";
import type { OutboundAttachment } from "./transport.js";
import { pickupEmailImageCid } from "./templates/pickupUpdates.js";

const pickupImagePath = new URL("../../../assets/pickup-email-parcel.png", import.meta.url);

export async function resolveInlineEmailImages(content: EmailContent): Promise<OutboundAttachment[]> {
  if (content.heroImage?.url !== `cid:${pickupEmailImageCid}`) return [];
  return [{
    filename: "pickup-email-parcel.png",
    content: await readFile(pickupImagePath),
    contentType: "image/png",
    cid: pickupEmailImageCid,
    contentDisposition: "inline"
  }];
}
