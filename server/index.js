import "./env.js";
import express from "express";
import compression from "compression";
import cors from "cors";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import quizRouter from "./routes/quiz.js";
import leaderboardRouter from "./routes/leaderboard.js";

const app = express();
const PORT = process.env.PORT || 5000;

app.disable("x-powered-by");
app.set("etag", "strong");

// Ensure uploads dir exists
const uploadsDir = process.env.VERCEL ? path.join("/tmp", "uploads") : path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ─── Middleware ───────────────────────────────────────────────────────────────
// gzip/brotli-eligible responses (JSON quiz payloads can be 20-80KB — this
// cuts that by ~70% over the wire, which matters most on mobile/slow links)
app.use(compression({ threshold: 1024 }));

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "*",
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "1mb" }));

// Basic request timing header (helps frontend show real latency)
app.use((req, res, next) => {
  req._startTime = Date.now();
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader("X-Request-Id", requestId);
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/quiz", quizRouter);
app.use("/api/leaderboard", leaderboardRouter);

app.get("/", (_req, res) => {
  res.json({
    status: "Quiz backend running",
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY),
    aiEngine: process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.GEMINI_API_KEY ? "gemini" : "fallback-only",
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("[server]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!process.env.VERCEL && isDirectRun) {
  app.listen(PORT, () => {
    const ai = process.env.ANTHROPIC_API_KEY ? "Anthropic Claude" : process.env.GEMINI_API_KEY ? "Gemini" : "Rule-based fallback";
    console.log(`Quiz server running on http://localhost:${PORT} — AI: ${ai}`);
  });
}

export default app;
