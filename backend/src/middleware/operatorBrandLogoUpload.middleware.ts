import { createMemoryUpload } from "./memoryUpload.js";

export const operatorBrandLogoUpload = createMemoryUpload({
  field: "logo",
  maxBytes: 2 * 1024 * 1024,
  accept: ["image/jpeg", "image/png"],
  messages: {
    tooLarge: "Choose a JPG or PNG logo no larger than 2 MB.",
    unexpectedField: "Upload one logo using the logo field.",
    wrongType: "Choose a JPG or PNG logo.",
    failed: "Company logo upload failed."
  }
});
