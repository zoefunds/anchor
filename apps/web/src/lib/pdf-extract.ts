// PDF text extraction — runs here (Anchor's own backend) rather than
// inside the GenLayer contract, since GenVM's sandbox has no PDF-parsing
// capability at all: the contract can only confirm a file URL is
// reachable (_web_get in adjudicator.py), never read what's actually in
// it. Extracting at upload time means the contract receives real
// document content as plain text evidence instead of an opaque "this URL
// exists" fact.

const MAX_EXTRACTED_CHARS = 50_000; // generous for a real contract/PO/invoice; keeps the prompt bounded regardless of PDF size

export async function extractPdfText(bytes: Buffer): Promise<string | null> {
  // Lazy import: pdf-parse pulls in a fair bit of code that only ever
  // needs to load for the (relatively rare) PDF upload path, not every
  // cold start of this route.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  let text: string;
  try {
    const result = await parser.getText();
    text = result.text.trim();
  } finally {
    await parser.destroy();
  }
  if (!text) return null; // a scanned PDF with no text layer — nothing to extract, not an error
  return text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
}
