import { createMemoryUpload } from "./memoryUpload.js";

const acceptedTypes = ["application/pdf", "image/jpeg", "image/png"] as const;

export const aadhaarOcrUpload = createMemoryUpload({
  field: [
    { name: "front", maxCount: 1 },
    { name: "back", maxCount: 1 },
  ],
  maxBytes: 5 * 1024 * 1024,
  maxFiles: 2,
  accept: { front: acceptedTypes, back: acceptedTypes },
  messages: {
    tooLarge: "Each Aadhaar side must be 5 MB or smaller.",
    tooMany: "Upload one front and one back file.",
    unexpectedField: "Upload the Aadhaar sides as \"front\" and \"back\".",
    wrongType: "Only PDF, JPG, JPEG, and PNG files are supported.",
    failed: "Aadhaar upload failed.",
  },
});
