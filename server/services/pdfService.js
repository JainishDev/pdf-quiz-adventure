import fs from "fs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/**
 * Extract clean text from an uploaded PDF file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function extractTextFromPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);

  // Basic cleanup: collapse whitespace, drop empty lines, strip page-number noise
  const text = data.text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\d+$/.test(l))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { text, numPages: data.numpages || 1, buffer };
}

/**
 * Split extracted text into reasonably sized chunks (for large PDFs)
 * so we don't blow past model context limits.
 */
export function chunkText(text, maxChars = 12000) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxChars));
    start += maxChars;
  }
  return chunks;
}
