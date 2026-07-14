import express from "express";
import "../../server/env.js";
import quizRouter from "../../server/routes/quiz.js";

const app = express();

app.use((req, _res, next) => {
  if (req.url.startsWith("/api/quiz")) {
    req.url = req.url.slice("/api/quiz".length) || "/";
  }
  next();
});

app.use("/", quizRouter);

export default app;
