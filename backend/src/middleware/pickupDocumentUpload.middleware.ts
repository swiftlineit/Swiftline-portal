import { createMemoryUpload } from "./memoryUpload.js";

export const pickupDocumentUpload = createMemoryUpload({
  field: [{ name: "documents", maxCount: 5 }],
  maxBytes: 8 * 1024 * 1024,
  maxFiles: 5,
  accept: ["application/pdf", "image/jpeg", "image/png", "image/webp"],
  messages: {
    tooLarge: "Each pickup document must be 8 MB or smaller.",
    tooMany: "Upload no more than five pickup documents.",
    unexpectedField: "Use the pickup documents field for uploads.",
    wrongType: "Pickup documents must be PDF, JPG, PNG, or WebP files.",
    failed: "Pickup document upload failed."
  }
});
