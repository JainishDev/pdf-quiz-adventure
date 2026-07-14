import express from "express";

const router = express.Router();

const BOARD_KEY = "leaderboard:global"; // sorted set: member -> score
const ENTRY_PREFIX = "leaderboard:entry:"; // hash per player-id: full entry JSON

function redisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// Upstash REST helper — sends a Redis command as a JSON array, e.g. ["ZADD", key, score, member]
async function redis(...command) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const res = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ─── GET /api/leaderboard — top N players, globally shared ───────────────────
router.get("/", async (req, res) => {
  if (!redisConfigured()) {
    return res.status(503).json({ error: "Leaderboard backend not configured (missing Upstash env vars)" });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    // ZREVRANGE gives highest score first
    const raw = await redis("ZREVRANGE", BOARD_KEY, 0, limit - 1, "WITHSCORES");
    // raw = [member1, score1, member2, score2, ...]
    const playerIds = [];
    for (let i = 0; i < raw.length; i += 2) playerIds.push(raw[i]);

    if (playerIds.length === 0) return res.json({ leaderboard: [] });

    const entries = await Promise.all(
      playerIds.map((id) => redis("GET", ENTRY_PREFIX + id))
    );

    const leaderboard = entries
      .map((e) => (e ? JSON.parse(e) : null))
      .filter(Boolean);

    res.json({ leaderboard });
  } catch (err) {
    console.error("[leaderboard:get]", err.message);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

// ─── POST /api/leaderboard — submit/update a player's best score ─────────────
// body: { playerId, name, score, total, xp, title }
router.post("/", async (req, res) => {
  if (!redisConfigured()) {
    return res.status(503).json({ error: "Leaderboard backend not configured (missing Upstash env vars)" });
  }
  try {
    const { playerId, name, score, total, xp, title } = req.body || {};
    if (!playerId || typeof score !== "number" || typeof total !== "number") {
      return res.status(400).json({ error: "playerId, score, total are required" });
    }

    const pct = total > 0 ? Math.round((score / total) * 100) : 0;
    const safeName = String(name || "Trainer").slice(0, 20);
    const safeTitle = String(title || "Quiz").slice(0, 28);

    // Only overwrite this player's entry if the new score is a new best (rank by pct, then xp)
    const existingRaw = await redis("GET", ENTRY_PREFIX + playerId);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    const isBetter = !existing || pct > existing.pct || (pct === existing.pct && xp > existing.xp);

    if (isBetter) {
      const entry = { playerId, name: safeName, score, total, pct, xp, title: safeTitle, date: Date.now() };
      await redis("SET", ENTRY_PREFIX + playerId, JSON.stringify(entry));
      // Composite sort score: pct dominates, xp breaks ties, both packed into one number
      const sortScore = pct * 1_000_000 + Math.min(xp, 999_999);
      await redis("ZADD", BOARD_KEY, sortScore, playerId);
    }

    const raw = await redis("ZREVRANGE", BOARD_KEY, 0, 19, "WITHSCORES");
    const playerIds = [];
    for (let i = 0; i < raw.length; i += 2) playerIds.push(raw[i]);
    const entries = await Promise.all(playerIds.map((id) => redis("GET", ENTRY_PREFIX + id)));
    const leaderboard = entries.map((e) => (e ? JSON.parse(e) : null)).filter(Boolean);

    res.json({ leaderboard, updated: isBetter });
  } catch (err) {
    console.error("[leaderboard:post]", err.message);
    res.status(500).json({ error: "Failed to submit score" });
  }
});

export default router;
