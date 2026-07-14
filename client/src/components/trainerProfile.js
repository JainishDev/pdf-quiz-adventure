// Persistent "Trainer Profile" — XP, level, streaks, quiz history.
// Pure localStorage, no backend needed for this part.

const STORAGE_KEY = "pdfQuizAdventure.trainerProfile.v1";

const DEFAULT_PROFILE = {
  totalXP: 0,
  level: 1,
  quizzesCompleted: 0,
  bestStreak: 0,
  totalCorrect: 0,
  totalQuestions: 0,
  badges: [],
  history: [], // last N quiz results
};

export function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PROFILE, ...parsed };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function saveProfile(profile) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // storage unavailable (private mode etc.) — fail silently
  }
}

export function spendXP(amount) {
  const profile = loadProfile();
  if (profile.totalXP < amount) return { ok: false, profile };
  profile.totalXP -= amount;
  const { level } = levelFromXP(profile.totalXP);
  profile.level = level;
  saveProfile(profile);
  return { ok: true, profile };
}

// XP required to go from level N to N+1 grows gradually
export function xpForLevel(level) {
  return 100 + (level - 1) * 40;
}

export function levelFromXP(totalXP) {
  let level = 1;
  let remaining = totalXP;
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: xpForLevel(level) };
}

const BADGE_RULES = [
  { id: "first_win", label: "First Steps", test: (p) => p.quizzesCompleted >= 1 },
  { id: "five_quizzes", label: "Dedicated Trainer", test: (p) => p.quizzesCompleted >= 5 },
  { id: "streak_5", label: "Combo Master", test: (p) => p.bestStreak >= 5 },
  { id: "streak_10", label: "Unstoppable", test: (p) => p.bestStreak >= 10 },
  { id: "level_5", label: "Rising Star", test: (p) => p.level >= 5 },
  { id: "sharpshooter", label: "Sharpshooter", test: (p) => p.totalQuestions >= 20 && p.totalCorrect / p.totalQuestions >= 0.9 },
];

export function allBadges() {
  return BADGE_RULES.map(({ id, label }) => ({ id, label }));
}

/**
 * Record a completed quiz result and update the trainer profile.
 * @param {{xpEarned:number, correct:number, total:number, bestStreakThisQuiz:number, title:string}} result
 */
export function recordQuizResult(result) {
  const profile = loadProfile();

  profile.totalXP += result.xpEarned;
  profile.quizzesCompleted += 1;
  profile.totalCorrect += result.correct;
  profile.totalQuestions += result.total;
  profile.bestStreak = Math.max(profile.bestStreak, result.bestStreakThisQuiz);

  const { level } = levelFromXP(profile.totalXP);
  const leveledUp = level > profile.level;
  profile.level = level;

  profile.history = [
    { title: result.title, score: result.correct, total: result.total, xp: result.xpEarned, date: Date.now() },
    ...profile.history,
  ].slice(0, 10);

  const newlyUnlocked = [];
  for (const rule of BADGE_RULES) {
    if (!profile.badges.includes(rule.id) && rule.test(profile)) {
      profile.badges.push(rule.id);
      newlyUnlocked.push(rule.label);
    }
  }

  saveProfile(profile);
  return { profile, leveledUp, newlyUnlocked };
}

export function badgeLabel(id) {
  return BADGE_RULES.find((b) => b.id === id)?.label || id;
}
