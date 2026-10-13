import { createMemoryUpload } from "./memoryUpload.js";

export const dpdLabelUpload = createMemoryUpload({
  field: "dpdLabel",
  maxBytes: 5 * 1024 * 1024,
  accept: ["text/html", "application/xhtml+xml"],
  validate: (file) => /\.html?$/i.test(file.originalname)
    ? null
    : "Upload the HTML label page downloaded from ALS.",
  messages: {
    tooLarge: "The ALS label HTML file must be 5 MB or smaller.",
    wrongType: "Upload an HTML label page downloaded from ALS."
  }
});
