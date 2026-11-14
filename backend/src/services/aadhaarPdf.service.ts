import { PDFDocument } from "pdf-lib";

const maxAadhaarPdfBytes = 5 * 1024 * 1024;

export class AadhaarPdfInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AadhaarPdfInputError";
  }
}

/** Prepares a complete Aadhaar PDF for Surepass's required front and back fields. */
export async function prepareCompleteAadhaarPdf(buffer: Buffer): Promise<{
  front: { buffer: Buffer; originalname: string; mimetype: string };
  back: { buffer: Buffer; originalname: string; mimetype: string };
}> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(buffer);
  } catch {
    throw new AadhaarPdfInputError("This PDF could not be opened. Use a valid, unlocked Aadhaar PDF.");
  }

  if (source.isEncrypted) {
    throw new AadhaarPdfInputError("Use an unlocked Aadhaar PDF to scan the document.");
  }
  const pageCount = source.getPageCount();
  if (pageCount !== 1 && pageCount !== 2) {
    throw new AadhaarPdfInputError("Upload a one-page PDF with both sides, or a two-page PDF with the front first.");
  }

  const splitPage = async (pageIndex: number, side: "front" | "back") => {
    try {
      const pageDocument = await PDFDocument.create();
      const [page] = await pageDocument.copyPages(source, [pageIndex]);
      pageDocument.addPage(page);
      const bytes = await pageDocument.save({ useObjectStreams: false });
      if (bytes.byteLength > maxAadhaarPdfBytes) {
        throw new AadhaarPdfInputError("A page is larger than the 5 MB file limit after preparation. Use a smaller PDF.");
      }
      return {
        buffer: Buffer.from(bytes),
        originalname: `aadhaar-${side}.pdf`,
        mimetype: "application/pdf",
      };
    } catch (error) {
      if (error instanceof AadhaarPdfInputError) throw error;
      throw new AadhaarPdfInputError("This PDF could not be prepared for scanning. Try another PDF.");
    }
  };

  const front = await splitPage(0, "front");
  return {
    front,
    back: pageCount === 1 ? front : await splitPage(1, "back"),
  };
}
