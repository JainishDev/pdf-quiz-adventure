import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { extractTextFromPDF } from "../services/pdfService.js";
import { generateQuizWithAI } from "../services/aiService.js";
import { generateQuizFallback } from "../services/fallbackService.js";
import { ocrPdfBuffer, looksLikeScannedPdf } from "../services/ocrService.js";

const router = express.Router();

// ─── Multer setup ─────────────────────────────────────────────────────────────
const upload = multer({
  dest: process.env.VERCEL ? path.join("/tmp", "uploads") : path.join(process.cwd(), "uploads"),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") return cb(new Error("Only PDF files are allowed"));
    cb(null, true);
  },
});

// ─── Simple LRU cache (PDF hash → extracted text) ─────────────────────────────
// Avoids re-extracting / re-OCR-ing the same PDF on repeated requests
const TEXT_CACHE_MAX = 20;
const textCache = new Map(); // hash → { text, usedOCR, ts }

function cacheGet(hash) {
  const entry = textCache.get(hash);
  if (!entry) return null;
  // LRU: move to end
  textCache.delete(hash);
  textCache.set(hash, entry);
  return entry;
}
function cacheSet(hash, value) {
  if (textCache.size >= TEXT_CACHE_MAX) {
    // Evict oldest (first key)
    textCache.delete(textCache.keys().next().value);
  }
  textCache.set(hash, value);
}

// ─── Quiz-result cache (PDF hash + params → finished quiz) ────────────────────
// The text cache above still pays for a full AI generation call every time.
// Same PDF + same count/difficulty/type (a page refresh, a retry, a second
// student uploading the same handout) is extremely common — cache the final
// quiz object too. This is the real cost + latency win: a hit skips the
// Anthropic/Gemini call entirely (0ms, $0) instead of just skipping OCR.
const QUIZ_CACHE_MAX = 40;
const QUIZ_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — long enough to help, short enough to stay fresh
const quizCache = new Map(); // key → { quiz, usedFallback, usedOCR, ts }

function quizCacheKey(hash, count, difficulty, questionType) {
  return `${hash}:${count}:${difficulty}:${questionType}`;
}
function quizCacheGet(key) {
  const entry = quizCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > QUIZ_CACHE_TTL_MS) {
    quizCache.delete(key);
    return null;
  }
  quizCache.delete(key);
  quizCache.set(key, entry); // LRU touch
  return entry;
}
function quizCacheSet(key, value) {
  if (quizCache.size >= QUIZ_CACHE_MAX) quizCache.delete(quizCache.keys().next().value);
  quizCache.set(key, { ...value, ts: Date.now() });
}

// ─── POST /generate ──────────────────────────────────────────────────────────
router.post("/generate", upload.single("pdf"), async (req, res) => {
  const filePath = req.file?.path;
  const t0 = Date.now();
  const requestAbort = new AbortController();
  req.on("aborted", () => requestAbort.abort());

  const throwIfAborted = () => {
    if (requestAbort.signal.aborted) {
      const err = new Error("Quiz generation cancelled");
      err.name = "AbortError";
      throw err;
    }
  };

  try {
    if (!req.file) return res.status(400).json({ error: "No PDF file uploaded" });

    const count = Math.min(Math.max(parseInt(req.body.count) || 10, 3), 25);
    const difficulty = ["easy", "medium", "hard", "mixed"].includes(req.body.difficulty)
      ? req.body.difficulty
      : "mixed";
    const questionType = ["mixed", "mcq", "true_false"].includes(req.body.questionType)
      ? req.body.questionType
      : "mixed";

    // ── Hash the PDF buffer for caching ──────────────────────────────────────
    const pdfBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(pdfBuffer).digest("hex").slice(0, 16);
    throwIfAborted();

    // ── Full-result cache: same file + same params = skip extraction, OCR,
    // and the AI call entirely. This is the big cost/latency win. ─────────────
    const qKey = quizCacheKey(hash, count, difficulty, questionType);
    const cachedQuiz = quizCacheGet(qKey);
    if (cachedQuiz) {
      const elapsed = Date.now() - t0;
      console.log(`[quiz] Full-result cache hit for ${qKey} (${elapsed}ms, $0 AI cost)`);
      return res.json({
        ...cachedQuiz.quiz,
        usedFallback: cachedQuiz.usedFallback,
        usedOCR: cachedQuiz.usedOCR,
        questionCount: cachedQuiz.quiz.questions.length,
        difficulty,
        questionType,
        generatedInMs: elapsed,
        cached: true,
      });
    }

    let text, usedOCR;

    const cached = cacheGet(hash);
    if (cached) {
      text = cached.text;
      usedOCR = cached.usedOCR;
      console.log(`[quiz] Cache hit for ${hash} (${text.length} chars)`);
    } else {
      // ── Extract text (pdf-parse is sync-like, fast) ───────────────────────
      const { text: raw, numPages } = await extractTextFromPDF(filePath);
      text = raw;
      usedOCR = false;

      // ── OCR if sparse — run in parallel-ish (can't avoid waiting) ────────
      if (looksLikeScannedPdf(text, numPages)) {
        try {
          console.log(`[quiz] Sparse text (${text.length} chars / ${numPages} pages) — running OCR`);
          const ocrText = await ocrPdfBuffer(pdfBuffer);
          if (ocrText && ocrText.length > text.length) {
            text = [text, ocrText].filter((t) => t && t.trim().length > 0).join("\n\n");
            usedOCR = true;
          }
        } catch (ocrErr) {
          console.warn("[quiz] OCR failed:", ocrErr.message);
        }
      }

      cacheSet(hash, { text, usedOCR });
    }
    throwIfAborted();

    if (!text || text.length < 80) {
      return res.status(422).json({
        error: "Couldn't extract enough text from this PDF, even with OCR. Try a clearer scan or a text-based PDF.",
      });
    }

    // ── Generate quiz ─────────────────────────────────────────────────────────
    let quiz;
    let usedFallback = false;

    try {
      quiz = await generateQuizWithAI(text, count, difficulty, questionType, { signal: requestAbort.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      console.warn("[quiz] AI failed, using rule-based fallback:", err.message);
      usedFallback = true;
      throwIfAborted();
      quiz = generateQuizFallback(text, count, difficulty, hash, questionType);
    }
    throwIfAborted();

    quizCacheSet(qKey, { quiz, usedFallback, usedOCR });

    const elapsed = Date.now() - t0;
    console.log(`[quiz] Done in ${elapsed}ms — ${quiz.questions.length} Qs, fallback=${usedFallback}, ocr=${usedOCR}`);

    return res.json({
      ...quiz,
      usedFallback,
      usedOCR,
      questionCount: quiz.questions.length,
      difficulty,
      questionType,
      generatedInMs: elapsed,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("[quiz] request cancelled");
      return res.status(499).json({ error: "Quiz generation cancelled" });
    }
    console.error("[quiz] generate error:", err);
    return res.status(500).json({ error: err.message || "Failed to generate quiz" });
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    textCacheSize: textCache.size,
    quizCacheSize: quizCache.size,
  });
});

export default router;
