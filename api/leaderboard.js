import express from "express";
import "../server/env.js";
import leaderboardRouter from "../server/routes/leaderboard.js";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/leaderboard")) {
    const stripped = req.url.slice("/api/leaderboard".length);
    req.url = stripped.startsWith("?") ? `/${stripped}` : stripped || "/";
  }
  next();
});
app.use("/", leaderboardRouter);

export default app;
