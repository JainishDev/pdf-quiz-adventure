// OCR pipeline for scanned / image-only PDFs.
// Flow: rasterize each PDF page to a canvas image with pdfjs-dist,
// then run Tesseract.js OCR on each page image and stitch the text together.
//
// This only kicks in when normal text-layer extraction (pdf-parse) returns
// too little text — i.e. the PDF is likely scanned/image-based.

import { createCanvas, Image, ImageData } from "canvas";
import { createWorker, PSM } from "tesseract.js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

if (typeof globalThis.Image === "undefined") globalThis.Image = Image;
if (typeof globalThis.ImageData === "undefined") globalThis.ImageData = ImageData;

// pdfjs-dist legacy build works in Node without a DOM.
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsLib;
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

/**
 * Renders each page of a PDF buffer to a PNG canvas and OCRs it.
 * @param {Buffer} buffer raw PDF bytes
 * @param {object} opts
 * @param {number} opts.maxPages cap pages processed (OCR is slow) - default 15
 * @param {(info:{page:number,total:number,status:string})=>void} opts.onProgress
 * @returns {Promise<string>} combined OCR text
 */
export async function ocrPdfBuffer(buffer, opts = {}) {
  const {
    maxPages = Number.parseInt(process.env.OCR_MAX_PAGES || "30", 10),
    onProgress,
    minCharsPerPage = Number.parseInt(process.env.OCR_MIN_CHARS_PER_PAGE || "80", 10),
    renderScale = Number.parseFloat(process.env.OCR_RENDER_SCALE || "3.2"),
    workerCount = Number.parseInt(process.env.OCR_WORKERS || "2", 10),
    lang = process.env.OCR_LANG || "eng",
    mode = process.env.OCR_MODE || "advanced",
  } = opts;
  const pdfjs = await getPdfjs();

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
  });
  const pdfDoc = await loadingTask.promise;

  const pageCount = Math.min(pdfDoc.numPages, Number.isFinite(maxPages) ? maxPages : 20);
  const pageTexts = new Array(pageCount);
  const ocrJobs = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const nativeText = await extractPageText(page);

    if (nativeText.length >= minCharsPerPage) {
      pageTexts[pageNum - 1] = nativeText;
      continue;
    }

    onProgress?.({ page: pageNum, total: pageCount, status: "rendering" });
    const images = await renderPageImages({ page, buffer, pageNum, renderScale, advanced: mode !== "fast" });
    ocrJobs.push({ pageNum, images });
  }

  if (ocrJobs.length === 0) {
    return pageTexts.map((t, i) => `[Page ${i + 1}]\n${t}`).join("\n\n").trim();
  }

  // ── Rendering (canvas) is fast; recognition is the slow part. OCR only the
  // sparse pages, then run them through a small worker pool.
  const POOL_SIZE = Math.max(1, Math.min(workerCount || 2, 4, ocrJobs.length));
  const workers = await Promise.all(
    Array.from({ length: POOL_SIZE }, () => createWorker(lang))
  );
  await Promise.all(workers.map((worker) => configureWorker(worker)));

  let nextIndex = 0;

  async function runWorker(worker) {
    while (true) {
      const i = nextIndex++;
      if (i >= ocrJobs.length) return;
      const job = ocrJobs[i];
      onProgress?.({ page: job.pageNum, total: pageCount, status: "ocr" });
      pageTexts[job.pageNum - 1] = await recognizeBestPage(worker, job.images);
    }
  }

  try {
    await Promise.all(workers.map(runWorker));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }

  return pageTexts
    .map((t, i) => ({ page: i + 1, text: cleanOcrText(t || "") }))
    .filter((p) => p.text)
    .map((p) => `[Page ${p.page}]\n${p.text}`)
    .join("\n\n")
    .trim();
}

async function configureWorker(worker) {
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
}

async function recognizeBestPage(worker, images) {
  const attempts = [];
  for (const image of images) {
    try {
      const { data } = await worker.recognize(image.buffer);
      attempts.push({
        text: cleanOcrText(data.text),
        confidence: Number(data.confidence) || 0,
        variant: image.variant,
      });
    } catch (err) {
      console.warn(`[quiz] OCR ${image.variant} variant failed:`, err.message);
    }
  }

  const scored = attempts
    .filter((item) => item.text)
    .map((item) => ({
      ...item,
      score: item.confidence + Math.min(item.text.length / 18, 35) + uniqueWordScore(item.text),
    }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.text || "";
}

function uniqueWordScore(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  if (!words.length) return 0;
  return Math.min(new Set(words).size / 8, 18);
}

async function renderPageImages({ page, buffer, pageNum, renderScale, advanced }) {
  try {
    const viewport = page.getViewport({ scale: renderScale }); // higher scale = better OCR accuracy
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx,
      viewport,
      canvas,
      canvasFactory: new NodeCanvasFactory(),
    }).promise;
    return makeOcrVariants(canvas, advanced);
  } catch (err) {
    const fallback = await renderPageWithImageMagick(buffer, pageNum).catch(() => null);
    if (fallback) return [{ variant: "imagemagick", buffer: fallback }];
    throw err;
  }
}

async function renderPageWithImageMagick(buffer, pageNum) {
  const id = crypto.randomBytes(8).toString("hex");
  const input = path.join(os.tmpdir(), `ocr-${id}.pdf`);
  const output = path.join(os.tmpdir(), `ocr-${id}.png`);
  await fs.writeFile(input, buffer);
  try {
    await execFileAsync("convert", [
      "-density", "300",
      `${input}[${pageNum - 1}]`,
      "-alpha", "remove",
      "-colorspace", "Gray",
      "-auto-orient",
      "-deskew", "40%",
      "-normalize",
      "-sharpen", "0x1",
      output,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 * 8 });
    return await fs.readFile(output);
  } finally {
    await fs.unlink(input).catch(() => {});
    await fs.unlink(output).catch(() => {});
  }
}

async function extractPageText(page) {
  try {
    const content = await page.getTextContent();
    return cleanOcrText(content.items.map((item) => item.str || "").join(" "));
  } catch {
    return "";
  }
}

function cleanOcrText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function makeOcrVariants(canvas, advanced) {
  const variants = [
    { variant: "balanced", buffer: preprocessCanvas(canvas, { mode: "balanced" }) },
  ];
  if (advanced) {
    variants.push(
      { variant: "high-contrast", buffer: preprocessCanvas(canvas, { mode: "threshold", contrast: 1.42 }) },
      { variant: "soft-handwriting", buffer: preprocessCanvas(canvas, { mode: "gray", contrast: 1.18 }) }
    );
  }
  return variants;
}

function preprocessCanvas(sourceCanvas, opts = {}) {
  const canvas = createCanvas(sourceCanvas.width, sourceCanvas.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  let sum = 0;
  const pixels = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += gray;
  }

  const avg = sum / Math.max(pixels, 1);
  const threshold = Math.max(110, Math.min(218, avg * 0.9));
  const contrast = opts.contrast || 1.28;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
    const value = opts.mode === "threshold"
      ? contrasted < threshold ? 0 : 255
      : opts.mode === "gray"
        ? contrasted
        : contrasted < threshold ? 18 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer("image/png");
}

/**
 * Decide whether a PDF likely needs OCR: very little extractable text
 * relative to its page count usually means it's a scanned image PDF.
 */
export function looksLikeScannedPdf(extractedText, numPages = 1) {
  const charsPerPage = extractedText.length / Math.max(numPages, 1);
  return charsPerPage < 80; // text-based PDFs typically have hundreds+ chars/page
}
