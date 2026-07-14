import express from "express";
import "../../server/env.js";
import quizRouter from "../../server/routes/quiz.js";

const app = express();

app.use((req, _res, next) => {
  if (req.url.startsWith("/api/quiz")) {
    const stripped = req.url.slice("/api/quiz".length);
    req.url = stripped.startsWith("?") ? `/${stripped}` : stripped || "/";
  }
  next();
});

app.use("/", quizRouter);
app.use((err, _req, res, _next) => {
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : err.status || 500;
  res.status(status).json({
    error: err.code === "LIMIT_FILE_SIZE"
      ? "PDF is too large for this deployment"
      : err.message || "Server error",
  });
});

export default app;
