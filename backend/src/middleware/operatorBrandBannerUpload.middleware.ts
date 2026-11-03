import { createMemoryUpload } from "./memoryUpload.js";

export const operatorBrandBannerUpload = createMemoryUpload({
  field: "banner",
  maxBytes: 2 * 1024 * 1024,
  accept: ["image/jpeg", "image/png"],
  messages: {
    tooLarge: "Choose a JPG or PNG banner no larger than 2 MB.",
    unexpectedField: "Upload one banner image using the banner field.",
    wrongType: "Choose a JPG or PNG banner image.",
    failed: "Operator banner upload failed."
  }
});
