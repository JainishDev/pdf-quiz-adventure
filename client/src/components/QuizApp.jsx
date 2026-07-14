import { useState, useRef, useCallback, useEffect, useMemo, useTransition, memo } from "react";
import { sfx, setMuted, isMuted } from "./sfx.js";
import { loadProfile, recordQuizResult, levelFromXP, badgeLabel, spendXP } from "./trainerProfile.js";
import { burstConfetti } from "./confetti.js";
import { pickRival, battleIntroLine, hitLine, missLine, victoryLine, defeatLine } from "./rivalBattle.js";

// ─── Constants ───────────────────────────────────────────────────────────────
const LOADING_LINES = [
  "WILD QUIZ APPEARED!",
  "Reading your PDF...",
  "Running OCR on scanned pages...",
  "Consulting the PROFESSOR (AI)...",
  "Generating questions...",
  "Almost ready, trainer...",
];

const TIME_PER_QUESTION = 20;
const XP_BY_DIFFICULTY = { easy: 10, medium: 20, hard: 30 };
const FREEZE_BONUS_SECONDS = 10;
const STARTING_POWERUPS = { fiftyFifty: 2, skip: 2, freeze: 2, hint: 1 };
const QUESTION_TYPES = [
  { id: "mixed", label: "MIXED" },
  { id: "mcq", label: "MCQ" },
  { id: "true_false", label: "TRUE/FALSE" },
];
const MODIFIER_SHOP = [
  { id: "fiftyFifty", label: "+1 50/50", icon: "🔀", cost: 80, penalty: 2 },
  { id: "freeze", label: "+1 FREEZE", icon: "❄️", cost: 70, penalty: 2 },
  { id: "skip", label: "+1 SKIP", icon: "⏭", cost: 110, penalty: 3 },
  { id: "hint", label: "+1 HINT", icon: "💡", cost: 60, penalty: 1 },
];
const THEME_KEY = "pdfQuizAdventure.theme.v1";
const LEADERBOARD_KEY = "pdfQuizAdventure.leaderboard.v1";
const DAILY_STREAK_KEY = "pdfQuizAdventure.dailyStreak.v1";
const SAVED_REVIEWS_KEY = "pdfQuizAdventure.savedReviews.v1";

const FEATURES = [
  { icon: "🧠", title: "AI QUESTIONS", desc: "Any PDF becomes a real quiz in seconds" },
  { icon: "⚡", title: "COMBO XP", desc: "Chain correct answers for bonus streaks" },
  { icon: "🎒", title: "POWER-UPS", desc: "50/50, freeze, skip & hint per run" },
  { icon: "🏆", title: "LEADERBOARD", desc: "Compete for the top trainer spot" },
];

const HOW_IT_WORKS = [
  { title: "UPLOAD YOUR PDF", desc: "Drop in any PDF — notes, textbook chapters, slides, even scanned pages." },
  { title: "AI BUILDS YOUR QUIZ", desc: "Questions are generated automatically, with OCR as a fallback for scanned docs." },
  { title: "PLAY & LEVEL UP", desc: "Answer against the clock, chain combos, spend power-ups, and climb the leaderboard." },
];

const FAQS = [
  { q: "Is this free to use?", a: "Yes — generating quizzes, tracking XP, and the leaderboard are all free." },
  { q: "What kind of PDFs work best?", a: "Text-based PDFs work great out of the box. Scanned or image-based PDFs are run through OCR automatically, so those work too." },
  { q: "Is my PDF stored anywhere?", a: "No. Your file is used only to generate the quiz, then deleted from the server right after processing." },
  { q: "How accurate are the AI-generated questions?", a: "Quality depends on how clear the source PDF is — dense, well-formatted text produces the sharpest questions. You can always regenerate with a different question count or difficulty." },
  { q: "Does it work on my phone?", a: "Yes, the whole game — including timers, power-ups, and the leaderboard — works on mobile, tablet, and desktop." },
  { q: "Can I practice without a timer?", a: "Yep — toggle PRACTICE MODE before generating your quiz to turn the timer off." },
];

// ─── Storage Helpers ──────────────────────────────────────────────────────────
const ls = {
  get: (k, fallback = null) => {
    try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set: (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
  },
};

function loadTheme() { return ls.get(THEME_KEY, "day") === "night" ? "night" : "day"; }
function saveTheme(t) { ls.set(THEME_KEY, t); }

// ─── Leaderboard helpers ──────────────────────────────────────────────────────
// Same-origin by default for production/Vercel. In local dev, Astro proxies
// /api to the Express server; PUBLIC_API_BASE remains available for split
// frontend/backend deployments.
const API_BASE = import.meta.env.PUBLIC_API_BASE || "";
const PLAYER_ID_KEY = "pdfQuizAdventure.playerId.v1";

function getPlayerId() {
  let id = ls.get(PLAYER_ID_KEY, null);
  if (!id) {
    id = crypto.randomUUID();
    ls.set(PLAYER_ID_KEY, id);
  }
  return id;
}

// Local-only fallback board, used when the server is unreachable/not configured yet
function loadLocalLeaderboard() {
  return ls.get(LEADERBOARD_KEY, []);
}
function saveLocalLeaderboardEntry(name, score, total, xp, title, modifierPenalty = 0) {
  const board = loadLocalLeaderboard();
  const pct = Math.round((score / total) * 100);
  const rankPct = Math.max(0, pct - modifierPenalty);
  const entry = { name, score, total, pct, rankPct, modifierPenalty, xp, title: title?.slice(0, 28) || "Quiz", date: Date.now() };
  const updated = [entry, ...board]
    .sort((a, b) => (b.rankPct ?? b.pct) - (a.rankPct ?? a.pct) || b.xp - a.xp || b.date - a.date)
    .slice(0, 50);
  ls.set(LEADERBOARD_KEY, updated);
  return updated;
}

// Real, shared, cross-device leaderboard — hits the server, falls back to local storage on failure
async function loadLeaderboard() {
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard?limit=20`);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    return data.leaderboard || [];
  } catch {
    return loadLocalLeaderboard(); // offline / server not set up yet
  }
}

async function saveLeaderboardEntry(name, score, total, xp, title, modifierPenalty = 0) {
  const playerId = getPlayerId();
  try {
    const res = await fetch(`${API_BASE}/api/leaderboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, name, score, total, xp, title, modifierPenalty }),
    });
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    return data.leaderboard || [];
  } catch {
    return saveLocalLeaderboardEntry(name, score, total, xp, title, modifierPenalty); // offline fallback
  }
}

// ─── Daily Streak helpers ─────────────────────────────────────────────────────
function getDailyStreak() {
  const data = ls.get(DAILY_STREAK_KEY, { streak: 0, lastDate: null });
  const today = new Date().toDateString();
  if (!data.lastDate) return { streak: 0, isNewDay: true };
  if (data.lastDate === today) return { streak: data.streak, isNewDay: false };
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (data.lastDate === yesterday) return { streak: data.streak, isNewDay: true };
  return { streak: 0, isNewDay: true }; // streak broken
}
function updateDailyStreak() {
  const today = new Date().toDateString();
  const { streak, isNewDay } = getDailyStreak();
  const newStreak = isNewDay ? streak + 1 : streak;
  ls.set(DAILY_STREAK_KEY, { streak: newStreak, lastDate: today });
  return { streak: newStreak, wasNewDay: isNewDay };
}

function loadSavedReviews() {
  return ls.get(SAVED_REVIEWS_KEY, []);
}

function saveReviewAttempt({ quiz, answers, summary, xp, bestStreak }) {
  if (!quiz?.questions?.length || !answers?.length) return loadSavedReviews();
  const entry = {
    id: crypto.randomUUID(),
    title: quiz.title || "Quiz",
    date: Date.now(),
    score: summary.correct,
    total: summary.total,
    xp,
    bestStreak,
    avgTime: summary.avgTime,
    questions: quiz.questions,
    answers,
    topics: summary.topics,
  };
  const updated = [entry, ...loadSavedReviews()].slice(0, 12);
  ls.set(SAVED_REVIEWS_KEY, updated);
  return updated;
}

// ─── Fixed stars ──────────────────────────────────────────────────────────────
function useStars(count = 36) {
  return useMemo(
    () => Array.from({ length: count }, (_, i) => ({
      top: `${(i * 7.13 + 11) % 100}%`,
      left: `${(i * 13.37 + 5) % 100}%`,
      delay: `${((i * 0.41) % 3.2).toFixed(2)}s`,
      size: i % 7 === 0 ? 4 : 2.5,
    })),
    [count]
  );
}

// ─── Memoized presentational sub-components ──────────────────────────────────
// These live OUTSIDE QuizApp (module scope) and are wrapped in React.memo so:
//  1) They have a STABLE component identity across renders — React never
//     unmounts/remounts their DOM subtree, so CSS animations (stars, clouds,
//     fireflies, hills) never restart mid-flight. This was the "background
//     replays on theme toggle" bug.
//  2) React.memo lets React SKIP re-rendering (and re-diffing) them entirely
//     when their own props are unchanged — e.g. a timer tick or score update
//     no longer touches SceneBackdrop/TopBar at all. That's the CPU-side win.
//  3) Everything they animate (transform, opacity) is GPU-compositable, so the
//     actual frame-to-frame work happens on the compositor thread, not layout/paint.

const SceneBackdrop = memo(function SceneBackdrop({ theme, stars, clouds, fireflies }) {
  return (
    <div className="scene-backdrop" aria-hidden="true">
      <div className="starfield">
        {stars.map((s, i) => (
          <span key={i} style={{ top: s.top, left: s.left, animationDelay: s.delay, width: s.size, height: s.size }} />
        ))}
      </div>
      {theme === "day" ? (
        <div className="cloud-layer">
          {clouds.map((c, i) => (
            <div key={i} className="pixel-cloud" style={{ top: c.top, "--s": c.scale, animationDuration: c.duration, animationDelay: c.delay }} />
          ))}
        </div>
      ) : (
        <>
          <div className="aurora" />
          <div className="firefly-layer">
            {fireflies.map((f, i) => (
              <span key={i} className="firefly" style={{ left: f.left, bottom: f.bottom, animationDuration: f.duration, animationDelay: f.delay }} />
            ))}
          </div>
        </>
      )}
      <div className="hill-layer">
        <div className="hill hill-back" />
        <div className="hill hill-front" />
      </div>
    </div>
  );
});

const TopBar = memo(function TopBar({ stage, dailyStreak, theme, muted, onHome, onTrainer, onToggleTheme, onToggleMute, onToggleLeaderboard }) {
  return (
    <div className="top-bar">
      <div className="icon-btn-group">
        {stage !== "upload" && (
          <button className="icon-btn" onClick={onHome} title="Back to home (Esc)">
            🏠 <span className="label">HOME</span>
          </button>
        )}
        <button className="icon-btn" onClick={onTrainer} title="Trainer Card">
          🎖️ <span className="label">CARD</span>
        </button>
        {dailyStreak > 0 && (
          <span className="icon-btn streak-badge" title={`${dailyStreak}-day login streak`}>
            🗓️ <span className="label">{dailyStreak}d</span>
          </span>
        )}
      </div>
      <div className="icon-btn-group">
        <button className="icon-btn" onClick={onToggleLeaderboard} title="Leaderboard">🏅</button>
        <button className="icon-btn" onClick={onToggleTheme} title="Toggle day/night">{theme === "day" ? "🌙" : "☀️"}</button>
        <button className="icon-btn" onClick={onToggleMute} title={muted ? "Unmute" : "Mute"}>{muted ? "🔇" : "🔊"}</button>
      </div>
    </div>
  );
});

const BootIris = memo(function BootIris({ bootPhase }) {
  return bootPhase !== "done" && (
    <div
      className={`iris-overlay boot-iris ${bootPhase === "covered" ? "iris-cover" : ""}`}
      style={{ "--iris-x": "50%", "--iris-y": "38%" }}
      aria-hidden="true"
    >
      <div className="iris-mark boot-mark">
        <div className="mark-pokeball">
          <span className="mark-pokeball-shine" />
        </div>
      </div>
    </div>
  );
});

const ThemeWipeOverlay = memo(function ThemeWipeOverlay({ wipe }) {
  return wipe && (
    <div
      className={`iris-overlay theme-wipe ${wipe.phase === "closing" ? "iris-cover" : ""}`}
      data-wipe-theme={wipe.next}
      style={{ "--iris-x": `${wipe.x}%`, "--iris-y": `${wipe.y}%` }}
      aria-hidden="true"
    >
      {wipe.next === "night" ? (
        <div className="iris-mark moon-mark">
          <span className="mark-star" style={{ top: "4%", left: "70%", animationDelay: "0s" }} />
          <span className="mark-star" style={{ top: "66%", left: "82%", animationDelay: "0.5s" }} />
          <span className="mark-star" style={{ top: "80%", left: "16%", animationDelay: "1s" }} />
          <span className="mark-star" style={{ top: "8%", left: "8%", animationDelay: "1.4s" }} />
        </div>
      ) : (
        <div className="iris-mark sun-mark" />
      )}
    </div>
  );
});

const HomeConfirmModal = memo(function HomeConfirmModal({ open, stage, onCancel, onConfirm }) {
  return open && (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="pixel-box modal-box" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>🏠</div>
        <p style={{ fontSize: 11, lineHeight: 1.8, marginBottom: 4 }}>
          {stage === "loading" ? "CANCEL QUIZ GENERATION?" : "RETURN TO TITLE SCREEN?"}
        </p>
        <p style={{ fontSize: 8, opacity: 0.75 }}>
          {stage === "quiz" ? "Your current progress will be lost." : "You can always start a new adventure."}
        </p>
        <div className="modal-actions">
          <button className="pixel-btn" onClick={onCancel}>STAY</button>
          <button className="pixel-btn primary" onClick={onConfirm}>GO HOME</button>
        </div>
      </div>
    </div>
  );
});

const LeaderboardPanel = memo(function LeaderboardPanel({ open, leaderboard, onClose }) {
  return open && (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="pixel-box modal-box leaderboard-box" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 12, marginBottom: 14, textAlign: "center" }}>🏅 HALL OF FAME</h2>
        {leaderboard.length === 0 ? (
          <p style={{ fontSize: 9, textAlign: "center", opacity: 0.7 }}>Complete a quiz to appear here!</p>
        ) : (
          leaderboard.slice(0, 10).map((e, i) => (
            <div key={i} className={`stat-row leaderboard-row ${i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : ""}`}>
              <span>{i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`} {e.name}</span>
              <span>{e.pct}%{e.modifierPenalty ? ` (-${e.modifierPenalty})` : ""} (+{e.xp}xp)</span>
            </div>
          ))
        )}
        <button className="pixel-btn primary" style={{ width: "100%", marginTop: 14 }} onClick={onClose}>CLOSE</button>
      </div>
    </div>
  );
});

const PopupToast = memo(function PopupToast({ popup }) {
  return popup && (
    <div className="toast-popup" role="status" aria-live="polite">
      {popup}
    </div>
  );
});

// ─── Component ────────────────────────────────────────────────────────────────
export default function QuizApp() {
  const [stage, setStage] = useState("upload");
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState("mixed");
  const [questionType, setQuestionType] = useState("mixed");
  const [error, setError] = useState("");
  const [quiz, setQuiz] = useState(null);
  const [loadingLine, setLoadingLine] = useState(LOADING_LINES[0]);
  const [loadingPct, setLoadingPct] = useState(4);
  const [muted, setMutedState] = useState(false);
  const [theme, setTheme] = useState("day");

  // Quiz state
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [xp, setXp] = useState(0);
  const [timeLeft, setTimeLeft] = useState(TIME_PER_QUESTION);
  const [popup, setPopup] = useState(null);
  const [levelUpInfo, setLevelUpInfo] = useState(null);
  const [shake, setShake] = useState(false);
  const [sparkles, setSparkles] = useState([]);
  const [powerups, setPowerups] = useState({ ...STARTING_POWERUPS });
  const [runModifiers, setRunModifiers] = useState({ fiftyFifty: 0, skip: 0, freeze: 0, hint: 0 });
  const [modifierPenalty, setModifierPenalty] = useState(0);
  const [activeModifierPenalty, setActiveModifierPenalty] = useState(0);
  const [eliminated, setEliminated] = useState([]);
  const [fiftyUsedFor, setFiftyUsedFor] = useState(new Set());
  const [homeConfirmOpen, setHomeConfirmOpen] = useState(false);
  const [shared, setShared] = useState(false);
  const [stageAnimKey, setStageAnimKey] = useState(0);
  const [hintText, setHintText] = useState(null);
  const [timerFrozen, setTimerFrozen] = useState(false);

  // Rival battle
  const [rival, setRival] = useState(null); // { type, name }
  const [rivalHit, setRivalHit] = useState(false);
  const [rivalFlavor, setRivalFlavor] = useState("");

  // Competitive features
  const [playerName, setPlayerName] = useState(() => ls.get("pdfQuizAdventure.playerName", ""));
  const [nameInput, setNameInput] = useState("");
  const [leaderboard, setLeaderboard] = useState([]);
  const [dailyStreak, setDailyStreak] = useState(() => getDailyStreak().streak);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [savedReviews, setSavedReviews] = useState(() => loadSavedReviews());
  const [selectedSavedReview, setSelectedSavedReview] = useState(null);

  // Load the shared, cross-device leaderboard on mount
  useEffect(() => {
    loadLeaderboard().then(setLeaderboard);
  }, []);
  const [speedBonus, setSpeedBonus] = useState(0); // for result screen
  const [totalTimeUsed, setTotalTimeUsed] = useState(0);
  const [questionTimings, setQuestionTimings] = useState([]);
  const [questionStartTime, setQuestionStartTime] = useState(null);
  const [practiceMode, setPracticeMode] = useState(false);

  // Smooth option reveal animation
  const [optionsVisible, setOptionsVisible] = useState(false);

  // Boot intro + theme-switch "iris wipe" (see styles: .iris-overlay)
  const [bootPhase, setBootPhase] = useState("covered"); // covered -> open -> done
  const [wipe, setWipe] = useState(null); // { x, y, next, phase: 'closing' | 'opening' }

  const [, startTrans] = useTransition();

  const fileInputRef = useRef(null);
  const loadingIntervalRef = useRef(null);
  const loadingPctIntervalRef = useRef(null);
  const timerRafRef = useRef(null);
  const timerDeadlineRef = useRef(0);
  const timerBarRef = useRef(null);
  const generateAbortRef = useRef(null);
  const lastWholeSecRef = useRef(TIME_PER_QUESTION);
  const cancelledRef = useRef(false);
  const sparkleIdRef = useRef(0);
  const popupTimeoutRef = useRef(null);
  const freezeTimeoutRef = useRef(null);
  const hasMountedRef = useRef(false);
  const wipeTimeoutRef = useRef(null);

  const stars = useStars(36);

  const buyModifier = (item) => {
    const result = spendXP(item.cost);
    if (!result.ok) {
      showPopup(`NEED ${item.cost} XP FOR ${item.label}`, 1800);
      sfx.wrong();
      return;
    }
    setRunModifiers((m) => ({ ...m, [item.id]: (m[item.id] || 0) + 1 }));
    setModifierPenalty((p) => p + item.penalty);
    showPopup(`${item.icon} ${item.label} READY (-${item.penalty}% RANK)`, 1800);
    sfx.badge?.();
  };

  const prefersReducedMotion = () =>
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // ─── Effects ────────────────────────────────────────────────────────────────
  useEffect(() => {
    setMutedState(isMuted());
    // Theme was already applied synchronously by the inline <head> script
    // (avoids a flash of the wrong theme on load) — just sync React state to it.
    const initial = document.documentElement.dataset.theme === "night" ? "night" : loadTheme();
    setTheme(initial);
    document.documentElement.dataset.theme = initial;

    // Boot iris: open shortly after mount, then remove the overlay entirely.
    if (prefersReducedMotion()) {
      setBootPhase("done");
    } else {
      const openTimer = setTimeout(() => setBootPhase("open"), 160);
      const doneTimer = setTimeout(() => setBootPhase("done"), 160 + 460);
      return () => { clearTimeout(openTimer); clearTimeout(doneTimer); };
    }
  }, []);

  // Only replay the stage-enter animation on *actual* stage changes, not on
  // the initial mount (that was the "animation plays twice / loads twice" bug —
  // this effect used to fire once on mount and once on every real change).
  useEffect(() => {
    if (!hasMountedRef.current) { hasMountedRef.current = true; return; }
    setStageAnimKey((k) => k + 1);
  }, [stage]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Options reveal: small delay after question loads for smoother feel
  useEffect(() => {
    setOptionsVisible(false);
    const t = setTimeout(() => setOptionsVisible(true), 60);
    return () => clearTimeout(t);
  }, [current, stage]);

  // ─── Toast helper (deduped) ──────────────────────────────────────────────────
  const showPopup = useCallback((msg, duration = 1400) => {
    if (popupTimeoutRef.current) clearTimeout(popupTimeoutRef.current);
    setPopup(msg);
    popupTimeoutRef.current = setTimeout(() => setPopup(null), duration);
  }, []);

  // ─── Theme & Mute ───────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) sfx.uiBlip();
  }, [muted]);

  const toggleTheme = useCallback((e) => {
    sfx.theme?.();
    const next = theme === "day" ? "night" : "day";

    if (prefersReducedMotion()) {
      setTheme(next);
      saveTheme(next);
      return;
    }

    const rect = e?.currentTarget?.getBoundingClientRect?.();
    const x = rect ? ((rect.left + rect.width / 2) / window.innerWidth) * 100 : 82;
    const y = rect ? ((rect.top + rect.height / 2) / window.innerHeight) * 100 : 6;

    clearTimeout(wipeTimeoutRef.current);
    // Mount uncovered first, then flip to "closing" a frame later so the
    // clip-path transition actually has something to animate from.
    setWipe({ x, y, next, phase: "start" });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setWipe((w) => (w ? { ...w, phase: "closing" } : w));
    }));
  }, [theme]);

  // Sequence the iris wipe: close over the screen, swap the theme while
  // fully hidden (this is what eliminates the color-swap glitch), then open
  // back up in the new theme.
  useEffect(() => {
    if (!wipe) return undefined;
    if (wipe.phase === "closing") {
      wipeTimeoutRef.current = setTimeout(() => {
        setTheme(wipe.next);
        saveTheme(wipe.next);
        setWipe((w) => (w ? { ...w, phase: "opening" } : w));
      }, 420);
      return () => clearTimeout(wipeTimeoutRef.current);
    }
    if (wipe.phase === "opening") {
      wipeTimeoutRef.current = setTimeout(() => setWipe(null), 420);
      return () => clearTimeout(wipeTimeoutRef.current);
    }
    return undefined;
  }, [wipe?.phase]);

  const vibrate = (pattern) => {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
  };

  // ─── File handling ───────────────────────────────────────────────────────────
  const handleFile = useCallback((f) => {
    if (!f) return;
    if (f.type !== "application/pdf") {
      setError("Only PDF files are supported, trainer!");
      return;
    }
    setError("");
    setFile(f);
    sfx.select();
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  // ─── Loading ─────────────────────────────────────────────────────────────────
  const startLoadingCycle = () => {
    let i = 0;
    setLoadingLine(LOADING_LINES[0]);
    setLoadingPct(4);
    loadingIntervalRef.current = setInterval(() => {
      i = (i + 1) % LOADING_LINES.length;
      setLoadingLine(LOADING_LINES[i]);
    }, 1800);
    loadingPctIntervalRef.current = setInterval(() => {
      setLoadingPct((p) => p >= 92 ? 92 : p + Math.random() * 6 + 2);
    }, 500);
  };

  const stopLoadingCycle = () => {
    clearInterval(loadingIntervalRef.current);
    clearInterval(loadingPctIntervalRef.current);
  };

  // ─── Timer ──────────────────────────────────────────────────────────────────
  // Anchored to a wall-clock deadline (not "tick N times") so it's immune to
  // setInterval drift and background-tab throttling: whenever this runs, it
  // recomputes remaining time from Date.now(), so it self-corrects instead of
  // accumulating error. The visual bar is written straight to the DOM via a
  // ref on every animation frame (compositor-only, no React re-render), which
  // is what makes it butter-smooth even on low-end devices; React state
  // (timeLeft) only updates once per whole second, just for the number/sfx.
  const clearQuestionTimer = () => {
    if (timerRafRef.current) cancelAnimationFrame(timerRafRef.current);
    timerRafRef.current = null;
  };

  const startQuestionTimer = () => {
    clearQuestionTimer();
    const totalMs = TIME_PER_QUESTION * 1000;
    timerDeadlineRef.current = Date.now() + totalMs;
    lastWholeSecRef.current = TIME_PER_QUESTION;
    setTimeLeft(TIME_PER_QUESTION);
    setTimerFrozen(false);
    if (timerBarRef.current) timerBarRef.current.style.transform = "scaleX(1)";

    const tick = () => {
      const remainingMs = Math.max(0, timerDeadlineRef.current - Date.now());
      const remainingSec = Math.ceil(remainingMs / 1000);
      const frac = Math.max(0, Math.min(1, remainingMs / totalMs));

      if (timerBarRef.current) timerBarRef.current.style.transform = `scaleX(${frac})`;

      if (remainingSec !== lastWholeSecRef.current) {
        lastWholeSecRef.current = remainingSec;
        setTimeLeft(remainingSec);
        if (remainingSec <= 6 && remainingSec > 0) sfx.tick();
      }

      if (remainingMs <= 0) {
        clearQuestionTimer();
        autoTimeout();
        return;
      }
      timerRafRef.current = requestAnimationFrame(tick);
    };
    timerRafRef.current = requestAnimationFrame(tick);
  };

  const autoTimeout = () => {
    const q = quiz.questions[current];
    setAnswered(true);
    setStreak(0);
    sfx.wrong();
    triggerShake();
    vibrate([30, 40, 30]);
    setAnswers((prev) => [...prev, {
      question: q.question,
      selected: null,
      correct: q.correctAnswer,
      isCorrect: false,
      timedOut: true,
      timeUsed: TIME_PER_QUESTION,
      difficulty: q.difficulty,
      topic: q.topic || "General",
    }]);
    setQuestionTimings((prev) => [...prev, TIME_PER_QUESTION]);
    setTotalTimeUsed((t) => t + TIME_PER_QUESTION);
  };

  useEffect(() => {
    if (stage === "quiz" && quiz) {
      if (!practiceMode) startQuestionTimer();
      setEliminated([]);
      setHintText(null);
      setQuestionStartTime(Date.now());
    }
    return clearQuestionTimer;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, stage]);

  // ─── Generate Quiz ───────────────────────────────────────────────────────────
  const generateQuiz = async () => {
    if (!file) { setError("Choose a PDF first!"); return; }
    setError("");
    cancelledRef.current = false;
    startTrans(() => setStage("loading"));
    sfx.upload();
    startLoadingCycle();
    generateAbortRef.current?.abort();
    generateAbortRef.current = new AbortController();

    try {
      const formData = new FormData();
      formData.append("pdf", file);
      formData.append("count", String(count));
      formData.append("difficulty", difficulty);
      formData.append("questionType", questionType);

      const res = await fetch("/api/quiz/generate", {
        method: "POST",
        body: formData,
        signal: generateAbortRef.current.signal,
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Failed to generate quiz");
      if (cancelledRef.current) return;

      setLoadingPct(100);
      setQuiz(data);
      setRival(pickRival(data.title || file.name));
      setCurrent(0);
      setSelected(null);
      setAnswered(false);
      setScore(0);
      setAnswers([]);
      setStreak(0);
      setBestStreak(0);
      setXp(0);
      setSpeedBonus(0);
      setTotalTimeUsed(0);
      setQuestionTimings([]);
      setPowerups({
        fiftyFifty: STARTING_POWERUPS.fiftyFifty + runModifiers.fiftyFifty,
        skip: STARTING_POWERUPS.skip + runModifiers.skip,
        freeze: STARTING_POWERUPS.freeze + runModifiers.freeze,
        hint: STARTING_POWERUPS.hint + runModifiers.hint,
      });
      setActiveModifierPenalty(modifierPenalty);
      setRunModifiers({ fiftyFifty: 0, skip: 0, freeze: 0, hint: 0 });
      setModifierPenalty(0);
      setFiftyUsedFor(new Set());
      setShared(false);
      setHintText(null);
      stopLoadingCycle();
      sfx.confirm();
      startTrans(() => setStage("vs"));
    } catch (err) {
      stopLoadingCycle();
      if (cancelledRef.current) return;
      if (err.name === "AbortError") return;
      setError(err.message || "Something went wrong");
      sfx.wrong();
      startTrans(() => setStage("upload"));
    }
  };

  // ─── VS screen → battle ─────────────────────────────────────────────────────
  const enterBattle = () => {
    sfx.confirm();
    startTrans(() => setStage("quiz"));
  };

  useEffect(() => {
    if (stage !== "vs") return;
    const t = setTimeout(enterBattle, 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // ─── Animations ─────────────────────────────────────────────────────────────
  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  const fireSparkles = () => {
    const id = sparkleIdRef.current++;
    const icons = ["✨", "⭐", "💫", "✦", "🌟"];
    const burst = Array.from({ length: 8 }, (_, i) => ({
      id: `${id}-${i}`,
      icon: icons[i % icons.length],
      top: `${25 + Math.random() * 50}%`,
      left: `${15 + Math.random() * 70}%`,
      sx: `${(Math.random() - 0.5) * 120}px`,
      sy: `${-50 - Math.random() * 60}px`,
      rot: `${(Math.random() - 0.5) * 360}deg`,
    }));
    setSparkles(burst);
    setTimeout(() => setSparkles([]), 900);
  };

  // ─── Answer logic ────────────────────────────────────────────────────────────
  const selectOption = (opt) => {
    if (answered || eliminated.includes(opt)) return;
    setSelected(opt);
    sfx.uiBlip();
  };

  const confirmAnswer = () => {
    if (!selected || answered) return;
    if (!practiceMode) clearQuestionTimer();

    const timeUsed = questionStartTime
      ? Math.round((Date.now() - questionStartTime) / 1000)
      : TIME_PER_QUESTION;

    const q = quiz.questions[current];
    const isCorrect = selected === q.correctAnswer;
    setAnswered(true);
    setAnswers((prev) => [...prev, {
      question: q.question,
      selected,
      correct: q.correctAnswer,
      isCorrect,
      timeUsed,
      difficulty: q.difficulty,
      topic: q.topic || "General",
    }]);
    setQuestionTimings((prev) => [...prev, timeUsed]);

    if (isCorrect) {
      const base = XP_BY_DIFFICULTY[q.difficulty] || 15;
      const speed = Math.round(((TIME_PER_QUESTION - Math.min(timeUsed, TIME_PER_QUESTION)) / TIME_PER_QUESTION) * 12);
      const newStreak = streak + 1;
      const comboMult = newStreak >= 5 ? 2.5 : newStreak >= 3 ? 1.75 : 1;
      const earned = Math.round((base + speed) * comboMult);

      setScore((s) => s + 1);
      setXp((x) => x + earned);
      setStreak(newStreak);
      setBestStreak((b) => Math.max(b, newStreak));
      setSpeedBonus((sb) => sb + speed);
      sfx.correct();
      fireSparkles();
      vibrate(25);
      if (rival) {
        setRivalHit(true);
        setRivalFlavor(hitLine(rival, newStreak));
        setTimeout(() => setRivalHit(false), 400);
      }

      if (newStreak >= 5) {
        sfx.streak?.();
        showPopup(`🔥 UNSTOPPABLE x${newStreak}! +${earned} XP`);
      } else if (newStreak >= 3) {
        sfx.streak?.();
        showPopup(`⚡ COMBO x${newStreak}! +${earned} XP`);
      } else {
        showPopup(`+${earned} XP${speed > 0 ? ` (⚡+${speed} speed)` : ""}`);
      }
    } else {
      setStreak(0);
      sfx.wrong();
      triggerShake();
      vibrate([30, 40, 30]);
      if (rival) setRivalFlavor(missLine(rival));
    }
    setTotalTimeUsed((t) => t + timeUsed);
  };

  const nextQuestion = () => {
    if (current + 1 >= quiz.questions.length) {
      finishQuiz();
      return;
    }
    setHintText(null);
    startTrans(() => {
      setCurrent((c) => c + 1);
      setSelected(null);
      setAnswered(false);
    });
    sfx.select();
  };

  const getQuizSummary = (list = answers) => {
    const total = quiz?.questions?.length || list.length || 1;
    const correct = list.filter((a) => a.isCorrect).length;
    const skipped = list.filter((a) => a.skipped).length;
    const timedOut = list.filter((a) => a.timedOut).length;
    const avgTime = list.length
      ? Math.round(list.reduce((sum, a) => sum + (Number(a.timeUsed) || 0), 0) / list.length)
      : 0;
    const topicMap = new Map();
    list.forEach((a) => {
      const topic = a.topic || "General";
      const item = topicMap.get(topic) || { topic, total: 0, correct: 0 };
      item.total += 1;
      if (a.isCorrect) item.correct += 1;
      topicMap.set(topic, item);
    });
    const topics = [...topicMap.values()]
      .sort((a, b) => (a.correct / a.total) - (b.correct / b.total))
      .slice(0, 3);
    return { total, correct, skipped, timedOut, avgTime, topics };
  };

  const finishQuiz = (finalAnswers = answers) => {
    sfx.levelUp();
    const summary = getQuizSummary(finalAnswers);

    // Update daily streak
    const { streak: ds, wasNewDay } = updateDailyStreak();
    if (wasNewDay) {
      setDailyStreak(ds);
      if (ds > 1) setTimeout(() => showPopup(`🗓️ DAY ${ds} STREAK!`, 2200), 400);
    }

    const { profile, leveledUp, newlyUnlocked } = recordQuizResult({
      xpEarned: xp,
      correct: summary.correct,
      total: summary.total,
      bestStreakThisQuiz: bestStreak,
      title: quiz.title,
    });
    setSavedReviews(saveReviewAttempt({ quiz, answers: finalAnswers, summary, xp, bestStreak }));

    if (leveledUp || newlyUnlocked.length) {
      setTimeout(() => sfx.badge?.(), 500);
      setTimeout(() => burstConfetti(), 550);
    }

    // Save to leaderboard if player has name
    const name = playerName || "TRAINER";
    saveLeaderboardEntry(name, summary.correct, summary.total, xp, quiz.title, activeModifierPenalty).then(setLeaderboard);

    const pct = Math.round((summary.correct / summary.total) * 100);
    if (pct === 100) {
      setTimeout(() => { burstConfetti({ particleCount: 140 }); }, 200);
      setTimeout(() => { burstConfetti({ particleCount: 90 }); }, 460);
      setTimeout(() => { burstConfetti({ particleCount: 90 }); }, 720);
    } else if (pct >= 80) {
      setTimeout(() => burstConfetti({ particleCount: 130 }), 200);
    }

    setLevelUpInfo({ profile, leveledUp, newlyUnlocked });
    startTrans(() => setStage("result"));
  };

  const restart = () => {
    startTrans(() => setStage("upload"));
    setFile(null);
    setQuiz(null);
    sfx.select();
  };

  // ─── Power-ups ──────────────────────────────────────────────────────────────
  const useFiftyFifty = () => {
    if (answered || powerups.fiftyFifty <= 0 || fiftyUsedFor.has(current)) return;
    const q = quiz.questions[current];
    const wrong = q.options.filter((o) => o !== q.correctAnswer && !eliminated.includes(o));
    const toRemove = wrong.slice(0, Math.max(0, wrong.length - 1));
    setEliminated((prev) => [...prev, ...toRemove]);
    setFiftyUsedFor((prev) => new Set(prev).add(current));
    setPowerups((p) => ({ ...p, fiftyFifty: p.fiftyFifty - 1 }));
    sfx.powerup?.();
    showPopup("🔀 50/50 — 2 WRONG ANSWERS REMOVED");
  };

  const useFreeze = () => {
    if (answered || powerups.freeze <= 0) return;
    const maxMs = (TIME_PER_QUESTION + FREEZE_BONUS_SECONDS) * 1000;
    const now = Date.now();
    const currentRemaining = Math.max(0, timerDeadlineRef.current - now);
    const newRemaining = Math.min(currentRemaining + FREEZE_BONUS_SECONDS * 1000, maxMs);
    timerDeadlineRef.current = now + newRemaining;
    setTimerFrozen(true);
    if (freezeTimeoutRef.current) clearTimeout(freezeTimeoutRef.current);
    freezeTimeoutRef.current = setTimeout(() => setTimerFrozen(false), 3000);
    setPowerups((p) => ({ ...p, freeze: p.freeze - 1 }));
    sfx.freeze?.();
    showPopup(`❄️ +${FREEZE_BONUS_SECONDS}s TIME FREEZE!`);
  };

  const useSkip = () => {
    if (answered || powerups.skip <= 0) return;
    clearQuestionTimer();
    const q = quiz.questions[current];
    const skippedAnswer = {
      question: q.question,
      selected: null,
      correct: q.correctAnswer,
      isCorrect: false,
      skipped: true,
      timeUsed: 0,
      difficulty: q.difficulty,
      topic: q.topic || "General",
    };
    const nextAnswers = [...answers, skippedAnswer];
    setAnswers(nextAnswers);
    setQuestionTimings((prev) => [...prev, 0]);
    setPowerups((p) => ({ ...p, skip: p.skip - 1 }));
    sfx.skip?.();
    setHintText(null);
    if (current + 1 >= quiz.questions.length) {
      finishQuiz(nextAnswers);
    } else {
      startTrans(() => {
        setCurrent((c) => c + 1);
        setSelected(null);
        setAnswered(false);
      });
    }
  };

  const useHint = () => {
    if (answered || powerups.hint <= 0 || hintText) return;
    const q = quiz.questions[current];
    // Show explanation as a partial hint (first sentence)
    const hint = q.explanation?.split(".")[0] + "." || "Think carefully about the context!";
    setHintText(hint);
    setPowerups((p) => ({ ...p, hint: p.hint - 1 }));
    sfx.powerup?.();
    showPopup("💡 HINT REVEALED!");
  };

  // ─── Home / exit ─────────────────────────────────────────────────────────────
  const requestHome = useCallback(() => {
    sfx.home?.();
    if (stage === "upload") return;
    setHomeConfirmOpen(true);
  }, [stage]);

  const confirmGoHome = useCallback(() => {
    if (stage === "loading") {
      cancelledRef.current = true;
      generateAbortRef.current?.abort();
      stopLoadingCycle();
    }
    clearQuestionTimer();
    setHomeConfirmOpen(false);
    sfx.select();
    startTrans(() => setStage("upload"));
    setFile(null);
    setQuiz(null);
    setPopup(null);
  }, [stage]);

  const cancelGoHome = useCallback(() => {
    setHomeConfirmOpen(false);
    sfx.uiBlip();
  }, []);

  // ─── Leaderboard panel ───────────────────────────────────────────────────────
  const toggleLeaderboard = useCallback(() => {
    sfx.select();
    setShowLeaderboard((v) => {
      const next = !v;
      if (next) loadLeaderboard().then(setLeaderboard); // refresh live standings on open
      return next;
    });
  }, []);

  const closeLeaderboard = useCallback(() => {
    setShowLeaderboard(false);
  }, []);

  const openTrainerCard = useCallback(() => {
    sfx.select();
    setHomeConfirmOpen(false);
    setShowLeaderboard(false);
    startTrans(() => setStage("trainer"));
  }, []);

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    if (stage !== "quiz" || !quiz || homeConfirmOpen) return;
    const onKey = (e) => {
      const q = quiz.questions[current];
      if (!answered) {
        const idx = ["1", "2", "3", "4"].indexOf(e.key);
        if (idx !== -1 && q.options[idx] && !eliminated.includes(q.options[idx])) {
          selectOption(q.options[idx]);
          return;
        }
        if (e.key === "Enter" && selected) { confirmAnswer(); return; }
        if (e.key === "h" || e.key === "H") { useHint(); return; }
      } else if (e.key === "Enter") {
        nextQuestion();
        return;
      }
      if (e.key === "Escape") requestHome();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, quiz, current, answered, selected, eliminated, homeConfirmOpen]);

  // ─── Share ──────────────────────────────────────────────────────────────────
  const shareResult = async () => {
    if (!quiz) return;
    const summary = getQuizSummary();
    const pct = Math.round((summary.correct / summary.total) * 100);
    const text = `🎮 PDF Quiz Adventure\n📄 "${quiz.title}"\n🏆 ${summary.correct}/${summary.total} (${pct}%)\n⚡ XP: +${xp} | Streak: ${bestStreak}x | Avg: ${summary.avgTime}s/Q\n🗓️ Daily Streak: ${dailyStreak} day${dailyStreak !== 1 ? "s" : ""}`;
    try {
      if (navigator.share) {
        await navigator.share({ text });
      } else {
        await navigator.clipboard.writeText(text);
      }
      setShared(true);
      sfx.uiBlip();
      setTimeout(() => setShared(false), 2500);
    } catch {
      setError("Couldn't share — try copying manually.");
    }
  };

  // ─── Static memoized scene elements ─────────────────────────────────────────
  const clouds = useMemo(
    () => Array.from({ length: 5 }, (_, i) => ({
      top: `${6 + i * 11}%`,
      scale: 0.75 + (i % 3) * 0.25,
      duration: `${34 + i * 6}s`,
      delay: `${-i * 7}s`,
    })),
    []
  );

  const fireflies = useMemo(
    () => Array.from({ length: 14 }, (_, i) => ({
      left: `${(i * 7.7) % 100}%`,
      bottom: `${10 + (i * 6.1) % 45}%`,
      duration: `${4 + (i % 4)}s`,
      delay: `${(i * 0.37) % 4}s`,
    })),
    []
  );

  // ─── UPLOAD STAGE ────────────────────────────────────────────────────────────
  if (stage === "upload") {
    const profile = loadProfile();
    const { level, xpIntoLevel, xpForNext } = levelFromXP(profile.totalXP);

    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <BootIris bootPhase={bootPhase} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <LeaderboardPanel open={showLeaderboard} leaderboard={leaderboard} onClose={closeLeaderboard} />
        <PopupToast popup={popup} />
        <div className="stage-enter" key={stageAnimKey}>
          <div className="title-wrap">
            <span className="hero-orbit left" aria-hidden="true" />
            <span className="hero-orbit right" aria-hidden="true" />
            <h1 className="pixel-title">PDF QUIZ<br />ADVENTURE</h1>
            <span className="pixel-subtitle">▶ PRESS START</span>
            <div className="tagline-pills">
              {["🧠 AI-Powered", "⚡ Gamified", "🏆 Leaderboard", "🔥 Daily Streaks"].map((t, i) => (
                <span key={t} className="tagline-pill" style={{ animationDelay: `${i * 0.08}s` }}>{t}</span>
              ))}
            </div>
          </div>

          {profile.quizzesCompleted > 0 && (
            <div className="pixel-box dark trainer-preview" onClick={() => { sfx.select(); setStage("trainer"); }}>
              <div className="question-meta" style={{ color: "var(--gb-cream)" }}>
                <span>TRAINER LV.{level}</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {dailyStreak > 0 && <span className="badge-tag">🗓️ {dailyStreak}d</span>}
                  <span className="badge-tag">VIEW CARD ▶</span>
                </div>
              </div>
              <div className="hp-bar-outer">
                <div className="hp-bar-inner shimmer" style={{ width: `${(xpIntoLevel / xpForNext) * 100}%` }} />
              </div>
              <div style={{ fontSize: 9, marginTop: 4, opacity: 0.7, color: "var(--gb-cream)" }}>
                {xpIntoLevel} / {xpForNext} XP TO NEXT LEVEL
              </div>
            </div>
          )}

          {/* Player Name */}
          <div className="pixel-box" style={{ marginTop: 14 }}>
            <label style={{ fontSize: 10, display: "block", marginBottom: 8 }}>YOUR TRAINER NAME</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="pixel-input"
                type="text"
                maxLength={16}
                placeholder="TRAINER"
                value={nameInput || playerName}
                onChange={(e) => setNameInput(e.target.value.toUpperCase())}
                onBlur={() => {
                  if (nameInput) {
                    setPlayerName(nameInput);
                    ls.set("pdfQuizAdventure.playerName", nameInput);
                    setNameInput("");
                  }
                }}
                style={{ flex: 1 }}
              />
              {playerName && <span className="badge-tag" style={{ alignSelf: "center" }}>✓ {playerName}</span>}
            </div>
          </div>

          <div className="pixel-box" style={{ marginTop: 12 }}>
            <div
              className={`dropzone ${dragging ? "dragging" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <div className="pokeball" />
              {file ? (
                <p>📄 {file.name}<br /><span style={{ fontSize: 9 }}>Tap to change</span></p>
              ) : (
                <p>Drop your PDF here<br />or tap to browse</p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                style={{ display: "none" }}
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </div>

            <div style={{ marginTop: 18 }}>
              <label style={{ fontSize: 10, display: "block", marginBottom: 8 }}>
                QUESTIONS: {count}
              </label>
              <input
                type="range" min="5" max="20" value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 10, display: "block", marginBottom: 8 }}>DIFFICULTY</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {["easy", "medium", "hard", "mixed"].map((d) => (
                  <button
                    key={d}
                    className={`pixel-btn ${difficulty === d ? "selected" : ""}`}
                    style={{ flex: "1 1 auto", fontSize: 10, padding: "9px 6px" }}
                    onClick={() => { setDifficulty(d); sfx.uiBlip(); }}
                  >
                    {d.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 10, display: "block", marginBottom: 8 }}>QUESTION TYPE</label>
              <div className="segmented-grid question-type-grid">
                {QUESTION_TYPES.map((t) => (
                  <button
                    key={t.id}
                    className={`pixel-btn ${questionType === t.id ? "selected" : ""}`}
                    style={{ fontSize: 9, padding: "9px 6px", textAlign: "center" }}
                    onClick={() => { setQuestionType(t.id); sfx.uiBlip(); }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Practice Mode toggle */}
            <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 10 }}>
              <button
                className={`pixel-btn ${practiceMode ? "selected" : ""}`}
                style={{ fontSize: 9, padding: "9px 10px" }}
                onClick={() => { setPracticeMode((v) => !v); sfx.uiBlip(); }}
              >
                {practiceMode ? "✓ PRACTICE MODE (no timer)" : "PRACTICE MODE"}
              </button>
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: 10, display: "block", marginBottom: 8 }}>POWER-UPS THIS RUN</label>
              <div style={{ display: "flex", gap: 8, fontSize: 9, flexWrap: "wrap" }}>
                <span className="badge-tag">🔀 50/50 x{STARTING_POWERUPS.fiftyFifty}</span>
                <span className="badge-tag">❄️ FREEZE x{STARTING_POWERUPS.freeze}</span>
                <span className="badge-tag">⏭ SKIP x{STARTING_POWERUPS.skip}</span>
                <span className="badge-tag">💡 HINT x{STARTING_POWERUPS.hint}</span>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 10, display: "block", marginBottom: 8 }}>
                MODIFIER SHOP · RANK -{modifierPenalty}%
              </label>
              <div className="shop-grid">
                {MODIFIER_SHOP.map((item) => (
                  <button key={item.id} className="pixel-btn shop-btn" onClick={() => buyModifier(item)}>
                    <span>{item.icon} {item.label}</span>
                    <span>{item.cost}XP · -{item.penalty}%</span>
                  </button>
                ))}
              </div>
              {Object.values(runModifiers).some(Boolean) && (
                <div className="badge-wrap bag-wrap">
                  {MODIFIER_SHOP.filter((item) => runModifiers[item.id] > 0).map((item) => (
                    <span key={item.id} className="badge-tag">{item.icon} x{runModifiers[item.id]}</span>
                  ))}
                </div>
              )}
            </div>

            {error && <div className="error-box">⚠ {error}</div>}

            <button
              className="pixel-btn primary"
              style={{ width: "100%", marginTop: 18, fontSize: 12 }}
              onClick={generateQuiz}
            >
              <span className="menu-cursor">▶</span> GENERATE QUIZ
            </button>
          </div>

          <h2 className="section-heading">WHY TRAINERS LOVE IT</h2>
          <p className="section-subheading">What you get every time you generate a quiz</p>
          <div className="feature-grid">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="feature-card" style={{ animationDelay: `${i * 0.07}s` }}>
                <span className="feature-icon">{f.icon}</span>
                <div className="feature-title">{f.title}</div>
                <div className="feature-desc">{f.desc}</div>
              </div>
            ))}
          </div>

          <h2 className="section-heading">HOW IT WORKS</h2>
          <p className="section-subheading">Three steps from PDF to Pokémon-style quiz battle</p>
          <div className="steps-wrap">
            {HOW_IT_WORKS.map((s, i) => (
              <div key={s.title} className="step-row" style={{ animationDelay: `${i * 0.08}s` }}>
                <span className="step-num">{i + 1}</span>
                <div className="step-body">
                  <div className="step-title">{s.title}</div>
                  <div className="step-desc">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <h2 className="section-heading">FREQUENTLY ASKED</h2>
          <p className="section-subheading">Everything trainers usually ask before starting</p>
          <div className="faq-list">
            {FAQS.map((item) => (
              <details key={item.q} className="faq-item">
                <summary>{item.q}</summary>
                <div className="faq-answer">{item.a}</div>
              </details>
            ))}
          </div>

          <div className="cta-band">
            <div className="cta-title">READY TO START YOUR ADVENTURE?</div>
            <div className="cta-desc">Upload a PDF above and get a full quiz in seconds — no sign-up required.</div>
            <button
              className="pixel-btn primary"
              onClick={() => {
                sfx.uiBlip();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <span className="menu-cursor">▶</span> BACK TO TOP
            </button>
          </div>

          <p className="footer-note">
            AI QUIZ ENGINE · Timer · Combo XP · Power-ups · Leaderboard<br />
            Keys 1-4 select · Enter confirms · H hint · Esc home
          </p>
        </div>
      </div>
    );
  }

  // ─── TRAINER CARD ────────────────────────────────────────────────────────────
  if (stage === "trainer") {
    const profile = loadProfile();
    const { level, xpIntoLevel, xpForNext } = levelFromXP(profile.totalXP);
    const accuracy = profile.totalQuestions
      ? Math.round((profile.totalCorrect / profile.totalQuestions) * 100) : 0;

    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <LeaderboardPanel open={showLeaderboard} leaderboard={leaderboard} onClose={closeLeaderboard} />
        <div className="pixel-box stage-enter" key={stageAnimKey} style={{ textAlign: "center" }}>
          <div className="result-badge">🎖️</div>
          <h2 style={{ fontSize: 14, marginBottom: 4 }}>TRAINER CARD</h2>
          <p style={{ fontSize: 10, marginBottom: 4 }}>
            {playerName || "TRAINER"} · LEVEL {level}
          </p>
          {dailyStreak > 0 && (
            <p style={{ fontSize: 8, marginBottom: 14, color: "var(--gb-yellow)" }}>🗓️ {dailyStreak}-DAY STREAK</p>
          )}

          <div className="hp-bar-outer" style={{ marginBottom: 8 }}>
            <div className="hp-bar-inner shimmer" style={{ width: `${(xpIntoLevel / xpForNext) * 100}%` }} />
          </div>
          <p style={{ fontSize: 8, marginBottom: 18 }}>{xpIntoLevel} / {xpForNext} XP</p>

          <div className="stat-row"><span>TOTAL XP</span><span>{profile.totalXP}</span></div>
          <div className="stat-row"><span>QUIZZES DONE</span><span>{profile.quizzesCompleted}</span></div>
          <div className="stat-row"><span>BEST STREAK</span><span>{profile.bestStreak}🔥</span></div>
          <div className="stat-row"><span>ACCURACY</span><span>{accuracy}%</span></div>

          {profile.badges.length > 0 && (
            <div style={{ marginTop: 16, textAlign: "left" }}>
              <p style={{ fontSize: 9, marginBottom: 8 }}>BADGES EARNED:</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {profile.badges.map((b, i) => (
                  <span key={b} className="badge-tag pop" style={{ animationDelay: `${i * 0.08}s` }}>🏅 {badgeLabel(b)}</span>
                ))}
              </div>
            </div>
          )}

          {profile.history.length > 0 && (
            <div style={{ marginTop: 18, textAlign: "left" }}>
              <p style={{ fontSize: 9, marginBottom: 8 }}>RECENT QUIZZES:</p>
              {profile.history.slice(0, 5).map((h, i) => (
                <div key={i} className="stat-row" style={{ fontSize: 8 }}>
                  <span>{h.title?.slice(0, 20) || "Quiz"}</span>
                  <span>{h.score}/{h.total} (+{h.xp}xp)</span>
                </div>
              ))}
            </div>
          )}

          {savedReviews.length > 0 && (
            <div style={{ marginTop: 18, textAlign: "left" }}>
              <p style={{ fontSize: 9, marginBottom: 8 }}>SAVED REVIEWS:</p>
              {savedReviews.slice(0, 5).map((h) => (
                <button
                  key={h.id}
                  className="pixel-btn saved-review-row"
                  onClick={() => {
                    setSelectedSavedReview(h);
                    sfx.select();
                    setStage("savedReview");
                  }}
                >
                  <span>{h.title?.slice(0, 22) || "Quiz"}</span>
                  <span>{h.score}/{h.total} · REVIEW ▶</span>
                </button>
              ))}
            </div>
          )}

          <button className="pixel-btn" style={{ width: "100%", marginTop: 14 }} onClick={() => { setShowLeaderboard(true); sfx.select(); }}>
            🏅 VIEW LEADERBOARD
          </button>
          <button className="pixel-btn primary" style={{ width: "100%", marginTop: 10 }} onClick={() => { sfx.select(); setStage("upload"); }}>
            ◀ BACK
          </button>
        </div>
        <LeaderboardPanel open={showLeaderboard} leaderboard={leaderboard} onClose={closeLeaderboard} />
      </div>
    );
  }

  // ─── LOADING STAGE ────────────────────────────────────────────────────────────
  if (stage === "loading") {
    const r = 40;
    const circumference = 2 * Math.PI * r;
    const offset = circumference - (Math.min(loadingPct, 100) / 100) * circumference;

    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <div className="pixel-box dark loading-wrap stage-enter" key={stageAnimKey}>
          <div className="loading-ring-wrap">
            <svg className="loading-ring-svg" width="90" height="90" viewBox="0 0 90 90">
              <circle className="loading-ring-bg" cx="45" cy="45" r={r} />
              <circle
                className="loading-ring-fg"
                cx="45" cy="45" r={r}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
              />
            </svg>
            <div className="pokeball" style={{ animationDuration: "0.8s" }} />
          </div>
          <p className="loading-pct">{Math.round(Math.min(loadingPct, 100))}%</p>
          <p style={{ fontSize: 11, lineHeight: 2 }}>{loadingLine}</p>
          <p className="loading-dots" style={{ fontSize: 20 }}>
            <span>●</span> <span>●</span> <span>●</span>
          </p>
        </div>
      </div>
    );
  }

  // ─── VS SCREEN ────────────────────────────────────────────────────────────────
  if (stage === "vs" && rival) {
    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <div className="vs-screen stage-enter" key={stageAnimKey} onClick={enterBattle} style={{ "--rival-color": rival.type.color, "--rival-glow": rival.type.glow }}>
          <div className="vs-side vs-player">
            <div className="vs-portrait">🎒</div>
            <div className="vs-name">{playerName || "TRAINER"}</div>
          </div>
          <div className="vs-burst">VS</div>
          <div className="vs-side vs-rival">
            <div className="vs-portrait vs-portrait-rival">{rival.type.icon}</div>
            <div className="vs-name">{rival.name}</div>
            <span className="badge-tag vs-type-badge" style={{ background: rival.type.color, color: "#1a1330" }}>
              {rival.type.label} TYPE
            </span>
          </div>
          <p className="vs-line">{battleIntroLine(rival)}</p>
          <button className="pixel-btn primary vs-start-btn" onClick={enterBattle}>
            <span className="menu-cursor">▶</span> BATTLE START
          </button>
        </div>
      </div>
    );
  }

  // ─── QUIZ STAGE ───────────────────────────────────────────────────────────────
  if (stage === "quiz" && quiz) {
    const q = quiz.questions[current];
    const progress = ((current + 1) / quiz.questions.length) * 100;
    const timePct = (timeLeft / TIME_PER_QUESTION) * 100;
    const fireCount = Math.min(streak, 5);

    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <LeaderboardPanel open={showLeaderboard} leaderboard={leaderboard} onClose={closeLeaderboard} />
        <PopupToast popup={popup} />

        <div className="stage-enter" key={stageAnimKey}>
          {/* Rival battle strip */}
          {rival && (
            <div className="pixel-box dark rival-hud" style={{ "--rival-color": rival.type.color, "--rival-glow": rival.type.glow }}>
              <div className={`rival-avatar ${rivalHit ? "rival-hit" : ""}`}>{rival.type.icon}</div>
              <div className="rival-info">
                <div className="question-meta" style={{ color: "var(--gb-cream)" }}>
                  <span>RIVAL {rival.name.toUpperCase()}</span>
                  <span className="badge-tag" style={{ background: rival.type.color, color: "#1a1330", borderColor: "var(--gb-dark)" }}>
                    {rival.type.icon} {rival.type.label}
                  </span>
                </div>
                <div className="hp-bar-outer rival-hp-outer">
                  <div
                    className="hp-bar-inner rival-hp-inner"
                    style={{ width: `${Math.max(0, 100 - (score / quiz.questions.length) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* HUD */}
          <div className="pixel-box dark hud-box">
            <div className="question-meta" style={{ color: "var(--gb-cream)" }}>
              <span>Q{current + 1}/{quiz.questions.length}</span>
              <span>
                ⭐{score} · ✨{xp}xp ·{" "}
                {streak > 0 ? (
                  <span className="streak-fire">{streak >= 5 ? "🔥🔥" : "🔥"}{streak}</span>
                ) : "no streak"}
              </span>
            </div>
            {/* Progress */}
            <div className="hp-bar-outer" style={{ marginBottom: 6 }}>
              <div className={`hp-bar-inner ${progress < 66 ? "mid" : ""} ${progress < 33 ? "low" : ""}`} style={{ width: `${progress}%` }} />
            </div>
            <div className="question-meta" style={{ color: "var(--gb-cream)", marginBottom: 4 }}>
              <div style={{ display: "flex", gap: 5 }}>
                <span className="badge-tag">{quiz.usedFallback ? "RULE-BASED" : "AI"}</span>
                {quiz.usedOCR && <span className="badge-tag">📷 OCR</span>}
                <span className="badge-tag">{(q.difficulty || "med").toUpperCase()}</span>
                {practiceMode && <span className="badge-tag">📖 PRACTICE</span>}
              </div>
              <span style={{ fontSize: 8 }}>⏱ {timeLeft}s</span>
            </div>
            {/* Timer bar */}
            {!practiceMode && (
              <div className="hp-bar-outer">
                <div
                  ref={timerBarRef}
                  className={`hp-bar-inner timer-bar ${timerFrozen ? "frozen" : ""} ${timePct < 50 ? "mid" : ""} ${timePct < 25 ? "low timer-low" : ""}`}
                  style={{ width: "100%", transformOrigin: "left center", transform: "scaleX(1)" }}
                />
              </div>
            )}
          </div>

          {/* Question card */}
          <div className={`pixel-box question-card ${shake ? "shake" : ""}`} style={{ position: "relative", overflow: "visible" }}>
            {sparkles.length > 0 && (
              <div className="sparkle-burst">
                {sparkles.map((s) => (
                  <span key={s.id} style={{ top: s.top, left: s.left, "--sx": s.sx, "--sy": s.sy, "--rot": s.rot }}>{s.icon}</span>
                ))}
              </div>
            )}

            <p className="question-text">{q.question}</p>

            {/* Hint display */}
            {hintText && (
              <div className="hint-box">
                💡 {hintText}
              </div>
            )}

            <div className={`options-list ${optionsVisible ? "options-visible" : "options-hidden"}`}>
              {q.options.map((opt, i) => {
                let cls = "pixel-btn option-btn";
                const isElim = eliminated.includes(opt);
                if (answered) {
                  if (opt === q.correctAnswer) cls += " correct";
                  else if (opt === selected) cls += " wrong";
                } else if (opt === selected) {
                  cls += " selected";
                } else if (isElim) {
                  cls += " eliminated";
                }
                return (
                  <button
                    key={i}
                    className={cls}
                    onClick={() => selectOption(opt)}
                    disabled={answered || isElim}
                    style={{ "--opt-delay": `${i * 0.06}s` }}
                  >
                    <span className="option-key">{i + 1}</span>
                    {opt === selected && !answered && <span className="menu-cursor">▶</span>}
                    {opt}
                  </button>
                );
              })}
            </div>

            {/* Power-ups */}
            {!answered && (
              <div className="powerup-row">
                <button className="powerup-btn" onClick={useFiftyFifty} disabled={powerups.fiftyFifty <= 0 || fiftyUsedFor.has(current)} title="Remove 2 wrong answers">
                  <span className="pu-icon">🔀</span>50/50
                  {powerups.fiftyFifty > 0 && <span className="pu-count">{powerups.fiftyFifty}</span>}
                </button>
                <button className="powerup-btn" onClick={useFreeze} disabled={powerups.freeze <= 0} title="Add time">
                  <span className="pu-icon">❄️</span>FREEZE
                  {powerups.freeze > 0 && <span className="pu-count">{powerups.freeze}</span>}
                </button>
                <button className="powerup-btn" onClick={useSkip} disabled={powerups.skip <= 0} title="Skip question">
                  <span className="pu-icon">⏭</span>SKIP
                  {powerups.skip > 0 && <span className="pu-count">{powerups.skip}</span>}
                </button>
                <button className="powerup-btn" onClick={useHint} disabled={powerups.hint <= 0 || !!hintText} title="Show hint (H)">
                  <span className="pu-icon">💡</span>HINT
                  {powerups.hint > 0 && <span className="pu-count">{powerups.hint}</span>}
                </button>
              </div>
            )}

            {answered && (
              <div className="explanation-box">
                {selected === null
                  ? "⏱ TIME'S UP! "
                  : selected === q.correctAnswer
                    ? "✔ CORRECT! "
                    : "✘ NOT QUITE. "}
                {q.explanation}
                {rival && rivalFlavor && (
                  <div className="rival-flavor" style={{ "--rival-color": rival.type.color }}>
                    {rival.type.icon} {rivalFlavor}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              {!answered ? (
                <button className="pixel-btn primary" style={{ width: "100%" }} onClick={confirmAnswer} disabled={!selected}>
                  CONFIRM <span style={{ fontSize: 8, opacity: 0.8 }}>(Enter)</span>
                </button>
              ) : (
                <button className="pixel-btn primary" style={{ width: "100%" }} onClick={nextQuestion}>
                  {current + 1 >= quiz.questions.length ? "SEE RESULTS ▶" : "NEXT ▶"} <span style={{ fontSize: 8, opacity: 0.8 }}>(Enter)</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── RESULT STAGE ─────────────────────────────────────────────────────────────
  if (stage === "result" && quiz) {
    const summary = getQuizSummary();
    const total = summary.total;
    const pct = Math.round((summary.correct / total) * 100);
    const rank = pct === 100 ? "PERFECT RUN!" : pct >= 80 ? "CHAMPION!" : pct >= 60 ? "GYM LEADER" : pct >= 40 ? "KEEP TRAINING" : "BACK TO BASICS";
    const avgTime = summary.avgTime;
    const isLevelEvent = levelUpInfo?.leveledUp || levelUpInfo?.newlyUnlocked?.length > 0;

    // Rank on leaderboard
    const myRank = leaderboard.findIndex((e) => e.pct === pct && e.xp === xp) + 1;

    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <LeaderboardPanel open={showLeaderboard} leaderboard={leaderboard} onClose={closeLeaderboard} />
        <div className={`pixel-box stage-enter ${isLevelEvent ? "level-up-flash" : ""}`} key={stageAnimKey} style={{ textAlign: "center" }}>
          {rival && (
            <div className={`battle-result-banner ${pct >= 60 ? "won" : "lost"}`} style={{ "--rival-color": rival.type.color }}>
              <span className="rival-avatar-small">{pct >= 60 ? "🏳️" : rival.type.icon}</span>
              <div>
                <div className="battle-result-title">
                  {pct >= 60 ? `${rival.name.toUpperCase()} DEFEATED!` : `${rival.name.toUpperCase()} HELD ON`}
                </div>
                <div className="battle-result-sub">{pct >= 60 ? victoryLine(rival) : defeatLine(rival)}</div>
              </div>
            </div>
          )}
          <div className="result-badge">{pct === 100 ? "👑" : pct >= 80 ? "🏆" : pct >= 60 ? "⭐" : "📘"}</div>
          <h2 style={{ fontSize: 14, marginBottom: 6 }}>{rank}</h2>
          <p style={{ fontSize: 10, marginBottom: 16, opacity: 0.8 }}>{quiz.title?.slice(0, 32)}</p>

          <div className="stat-row"><span>SCORE</span><span>{summary.correct} / {total} ({pct}%)</span></div>
          <div className="stat-row"><span>XP EARNED</span><span>+{xp} xp</span></div>
          <div className="stat-row"><span>SPEED BONUS</span><span>+{speedBonus} xp ⚡</span></div>
          <div className="stat-row"><span>BEST STREAK</span><span>{bestStreak}🔥</span></div>
          <div className="stat-row"><span>AVG TIME/Q</span><span>{avgTime}s</span></div>
          {(summary.skipped > 0 || summary.timedOut > 0) && (
            <div className="stat-row"><span>MISSED TYPE</span><span>{summary.skipped} skip · {summary.timedOut} timeout</span></div>
          )}
          {dailyStreak > 0 && <div className="stat-row"><span>DAILY STREAK</span><span>{dailyStreak} DAY{dailyStreak !== 1 ? "S" : ""} 🗓️</span></div>}
          {myRank > 0 && myRank <= 10 && <div className="stat-row gold-row"><span>LEADERBOARD</span><span>#{myRank} 🏅</span></div>}

          {summary.topics.length > 0 && (
            <div className="explanation-box topic-report">
              <strong>TOPIC CHECK</strong>
              {summary.topics.map((t) => (
                <div key={t.topic} className="topic-row">
                  <span>{t.topic}</span>
                  <span>{t.correct}/{t.total}</span>
                </div>
              ))}
            </div>
          )}

          {levelUpInfo?.leveledUp && (
            <div className="explanation-box" style={{ marginTop: 14 }}>
              🎉 LEVEL UP! You're now LV.{levelUpInfo.profile.level}!
            </div>
          )}
          {levelUpInfo?.newlyUnlocked?.length > 0 && (
            <div className="explanation-box" style={{ marginTop: 10 }}>
              🏅 NEW BADGE: {levelUpInfo.newlyUnlocked.join(", ")}
            </div>
          )}

          <button className="pixel-btn primary" style={{ width: "100%", marginTop: 18 }} onClick={() => { sfx.select(); setStage("review"); }}>
            REVIEW ANSWERS ▶
          </button>
          <button className="pixel-btn" style={{ width: "100%", marginTop: 10 }} onClick={() => { sfx.select(); setShowLeaderboard(true); }}>
            🏅 LEADERBOARD
          </button>
          <button className="pixel-btn" style={{ width: "100%", marginTop: 10 }} onClick={shareResult}>
            {shared ? "✔ SHARED!" : "📋 SHARE RESULT"}
          </button>
          <button className="pixel-btn" style={{ width: "100%", marginTop: 10 }} onClick={restart}>
            <span className="menu-cursor">▶</span> NEW ADVENTURE
          </button>
        </div>
      </div>
    );
  }

  // ─── REVIEW STAGE ─────────────────────────────────────────────────────────────
  if (stage === "savedReview" && selectedSavedReview) {
    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <div className="pixel-box stage-enter" key={stageAnimKey}>
          <h2 style={{ fontSize: 12, marginBottom: 4 }}>SAVED REVIEW</h2>
          <p style={{ fontSize: 8, marginBottom: 14, opacity: 0.7 }}>
            {selectedSavedReview.title?.slice(0, 28)} · {selectedSavedReview.score}/{selectedSavedReview.total} · Avg {selectedSavedReview.avgTime}s
          </p>
          {selectedSavedReview.answers.map((a, i) => {
            const q = selectedSavedReview.questions[i] || {};
            return (
              <div
                key={`${selectedSavedReview.id}-${i}`}
                className={`explanation-box review-item ${a.isCorrect ? "is-correct" : a.skipped ? "is-skipped" : "is-wrong"}`}
                style={{ marginBottom: 10 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <p style={{ margin: 0, flex: 1 }}>{i + 1}. {a.question}</p>
                  {a.timeUsed > 0 && <span className="badge-tag" style={{ marginLeft: 8, alignSelf: "flex-start" }}>⏱{a.timeUsed}s</span>}
                </div>
                <p style={{ fontSize: 8, margin: 0 }}>
                  {a.skipped ? "⏭ Skipped — " : a.isCorrect ? "✔ " : "✘ "}
                  Your answer: {a.skipped ? "(skipped)" : a.selected ?? "(timed out)"}<br />
                  {!a.isCorrect && !a.skipped && <>Correct: {a.correct}</>}
                </p>
                {(q.topic || q.sourceSnippet || q.pageRef) && (
                  <div className="source-box">
                    {q.topic && <span className="badge-tag">{q.topic}</span>}
                    {q.pageRef && <span className="badge-tag">{q.pageRef}</span>}
                    {q.sourceSnippet && <p>{q.sourceSnippet}</p>}
                  </div>
                )}
              </div>
            );
          })}
          <button className="pixel-btn primary" style={{ width: "100%", marginTop: 10 }} onClick={() => { sfx.select(); setStage("trainer"); }}>
            ◀ BACK TO TRAINER CARD
          </button>
        </div>
      </div>
    );
  }

  if (stage === "review" && quiz) {
    const avgTime = getQuizSummary().avgTime;

    return (
      <div className="gb-screen" data-theme={theme}>
        <SceneBackdrop theme={theme} stars={stars} clouds={clouds} fireflies={fireflies} />
        <TopBar stage={stage} dailyStreak={dailyStreak} theme={theme} muted={muted} onHome={requestHome} onTrainer={openTrainerCard} onToggleTheme={toggleTheme} onToggleMute={toggleMute} onToggleLeaderboard={toggleLeaderboard} />
        <ThemeWipeOverlay wipe={wipe} />
        <HomeConfirmModal open={homeConfirmOpen} stage={stage} onCancel={cancelGoHome} onConfirm={confirmGoHome} />
        <div className="pixel-box stage-enter" key={stageAnimKey}>
          <h2 style={{ fontSize: 12, marginBottom: 4 }}>ANSWER REVIEW</h2>
          <p style={{ fontSize: 8, marginBottom: 14, opacity: 0.7 }}>Avg {avgTime}s per question</p>
          {answers.map((a, i) => (
            <div
              key={i}
              className={`explanation-box review-item ${a.isCorrect ? "is-correct" : a.skipped ? "is-skipped" : "is-wrong"}`}
              style={{ marginBottom: 10 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <p style={{ margin: 0, flex: 1 }}>{i + 1}. {a.question}</p>
                {a.timeUsed > 0 && <span className="badge-tag" style={{ marginLeft: 8, alignSelf: "flex-start" }}>⏱{a.timeUsed}s</span>}
              </div>
              <p style={{ fontSize: 8, margin: 0 }}>
                {a.skipped ? "⏭ Skipped — " : a.isCorrect ? "✔ " : "✘ "}
                Your answer: {a.skipped ? "(skipped)" : a.selected ?? "(timed out)"}<br />
                {!a.isCorrect && !a.skipped && <>Correct: {a.correct}</>}
              </p>
              {(quiz.questions[i]?.topic || quiz.questions[i]?.sourceSnippet || quiz.questions[i]?.pageRef) && (
                <div className="source-box">
                  {quiz.questions[i]?.topic && <span className="badge-tag">{quiz.questions[i].topic}</span>}
                  {quiz.questions[i]?.pageRef && <span className="badge-tag">{quiz.questions[i].pageRef}</span>}
                  {quiz.questions[i]?.sourceSnippet && <p>{quiz.questions[i].sourceSnippet}</p>}
                </div>
              )}
            </div>
          ))}
          <button className="pixel-btn" style={{ width: "100%", marginTop: 8 }} onClick={() => { sfx.select(); setStage("result"); }}>
            ◀ BACK TO RESULTS
          </button>
          <button className="pixel-btn primary" style={{ width: "100%", marginTop: 10 }} onClick={restart}>
            <span className="menu-cursor">▶</span> NEW ADVENTURE
          </button>
        </div>
      </div>
    );
  }

  return null;
}
