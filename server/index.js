import "./env.js";
import express from "express";
import compression from "compression";
import cors from "cors";
import fs from "fs";
import path from "path";
import quizRouter from "./routes/quiz.js";
import leaderboardRouter from "./routes/leaderboard.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure uploads dir exists
const uploadsDir = process.env.VERCEL ? path.join("/tmp", "uploads") : path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ─── Middleware ───────────────────────────────────────────────────────────────
// gzip/brotli-eligible responses (JSON quiz payloads can be 20-80KB — this
// cuts that by ~70% over the wire, which matters most on mobile/slow links)
app.use(compression());

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "*",
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "1mb" }));

// Basic request timing header (helps frontend show real latency)
app.use((req, _res, next) => {
  req._startTime = Date.now();
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

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    const ai = process.env.ANTHROPIC_API_KEY ? "Anthropic Claude" : process.env.GEMINI_API_KEY ? "Gemini" : "Rule-based fallback";
    console.log(`Quiz server running on http://localhost:${PORT} — AI: ${ai}`);
  });
}

export default app;
