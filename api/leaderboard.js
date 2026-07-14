import express from "express";
import "../server/env.js";
import leaderboardRouter from "../server/routes/leaderboard.js";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use("/", leaderboardRouter);

export default app;
