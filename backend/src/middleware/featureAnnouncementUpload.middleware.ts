import { createMemoryUpload } from "./memoryUpload.js";

export const featureAnnouncementUpload = createMemoryUpload({
  field: [{ name: "images", maxCount: 4 }],
  maxBytes: 5 * 1024 * 1024,
  maxFiles: 4,
  accept: ["image/jpeg", "image/png", "image/webp"],
  messages: {
    tooLarge: "Each guide image must be 5 MB or smaller.",
    tooMany: "An announcement can include up to four images.",
    unexpectedField: "Upload guide images using the images field.",
    wrongType: "Choose JPG, PNG, or WebP images.",
    failed: "Guide image upload failed."
  }
});
