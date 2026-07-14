// Advanced rule-based quiz generator — zero external API calls.
// v2: multi-pattern fact extraction (definitions, numeric facts, enumerations,
// cause/effect, generic cloze), frequency-weighted term importance, category-aware
// distractors, difficulty-aware sentence selection, dedup, and better titling.
//
// Used automatically when the AI providers are unavailable, rate-limited, or error out.

const STOPWORDS = new Set(
  "the a an is are was were be been being of in on at to for with and or but if then than so that this these those it its as by from into over under again further not no nor s t can will just don should now which who whom whose your you our their his her they them he she we i also more most such only own same too very can's could would should shall may might must here there when where why how what all each both few many some any each other".split(
    " "
  )
);

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "vs", "etc", "e.g", "i.e",
  "fig", "eq", "no", "vol", "pp", "st", "approx", "inc", "ltd", "co", "u.s", "u.k",
]);

const ANTONYM_PAIRS = [
  ["increase", "decrease"], ["increases", "decreases"], ["increased", "decreased"],
  ["rise", "fall"], ["rises", "falls"], ["rose", "fell"],
  ["more", "fewer"], ["more", "less"], ["higher", "lower"], ["highest", "lowest"],
  ["greater", "smaller"], ["largest", "smallest"], ["larger", "smaller"],
  ["before", "after"], ["always", "never"], ["never", "always"],
  ["positive", "negative"], ["enable", "prevent"], ["enables", "prevents"],
  ["increase", "reduce"], ["expand", "contract"], ["gain", "lose"], ["gains", "losses"],
  ["majority", "minority"], ["faster", "slower"], ["early", "late"],
  ["improve", "worsen"], ["improves", "worsens"], ["true", "false"],
  ["can", "cannot"], ["allow", "prevent"], ["allows", "prevents"],
  ["above", "below"], ["maximum", "minimum"], ["strengthen", "weaken"],
];
const ANTONYM_MAP = new Map();
for (const [a, b] of ANTONYM_PAIRS) {
  ANTONYM_MAP.set(a, b);
  ANTONYM_MAP.set(b, a);
}

const ENUM_TRIGGER_RE = /\b(?:such as|including|include[s]?|comprise[s]?|consist[s]?\s+of|namely|for example)\b/i;
const CAUSE_TRIGGER_RE = /\b(because|due to|as a result of|owing to|since|therefore|as a result|consequently|this (?:leads|led|results?) (?:to|in)|which (?:leads|led|results?) (?:to|in))\b/i;
const DEFINITION_RE = /^([A-Z][A-Za-z0-9'()\-\/]*(?:\s+[A-Za-z0-9'()\-\/]+){0,5})\s+(?:is|are|refers to|means|can be defined as|is defined as|was|were)\s+(.{15,180})$/;
const NUMBER_RE = /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?%?\b/g;

// ─────────────────────────────────────────────────────────────────────────────
// Sentence + tokenization utilities
// ─────────────────────────────────────────────────────────────────────────────

function splitSentences(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const raw = [];
  let start = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const before = cleaned.slice(Math.max(0, i - 6), i).toLowerCase().replace(/[^a-z.]/g, "");
      const isAbbrev = [...ABBREVIATIONS].some((ab) => before.endsWith(ab));
      const isDecimal = ch === "." && /\d/.test(cleaned[i - 1] || "") && /\d/.test(cleaned[i + 1] || "");
      const next = cleaned[i + 1];
      const nextNonSpace = cleaned.slice(i + 1).match(/\S/)?.[0];
      if (!isAbbrev && !isDecimal && (next === undefined || next === " ") && /[A-Z0-9"']/.test(nextNonSpace || "Z")) {
        raw.push(cleaned.slice(start, i + 1).trim());
        start = i + 1;
      }
    }
  }
  if (start < cleaned.length) raw.push(cleaned.slice(start).trim());

  return raw
    .map((s) => s.replace(/^[-•*\d.)\s]+(?=[A-Z])/, "").trim())
    .filter((s) => {
      const words = s.split(/\s+/).filter(Boolean).length;
      if (words < 6 || words > 40) return false;
      if (!/[a-zA-Z]/.test(s)) return false;
      if (/^(figure|fig\.|table|chart|page|source:|note:|copyright|©)/i.test(s)) return false;
      // Avoid sentences that are themselves questions
      if (/\?\s*$/.test(s)) return false;
      return true;
    });
}

function words(str) {
  return str.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || [];
}

/** Build a document-wide term frequency map (lowercased), ignoring stopwords/short tokens. */
function buildFrequencyMap(sentences) {
  const freq = new Map();
  for (const s of sentences) {
    for (const w of words(s)) {
      const lw = w.toLowerCase();
      if (STOPWORDS.has(lw) || w.length < 3) continue;
      freq.set(lw, (freq.get(lw) || 0) + 1);
    }
  }
  return freq;
}

/** Extract multi-word capitalized entities ("Proper noun phrases") from a sentence. */
function extractEntities(sentence) {
  const re = /\b[A-Z][A-Za-z0-9'’]*(?:\s+(?:of|the|and)?\s?[A-Z][A-Za-z0-9'’]*)*\b/g;
  const matches = sentence.match(re) || [];
  return matches
    .map((m) => m.trim())
    .filter((m) => {
      const idx = sentence.indexOf(m);
      const isSentenceStart = idx === 0;
      const wc = m.split(/\s+/).length;
      if (wc === 1 && isSentenceStart) return false; // likely just capitalization from sentence start
      if (m.length < 3) return false;
      return true;
    });
}

function extractNumbers(sentence) {
  return [...new Set((sentence.match(NUMBER_RE) || []).map((n) => n.trim()))];
}

/** Score & rank candidate answer terms within a sentence using doc-wide frequency + shape signals. */
function keyTerms(sentence, freqMap = new Map()) {
  const entities = extractEntities(sentence);
  const plain = words(sentence)
    .filter((w) => {
      const lw = w.toLowerCase();
      return !STOPWORDS.has(lw) && w.length >= 4;
    });

  const scored = new Map();

  for (const e of entities) {
    const wc = e.split(/\s+/).length;
    let score = e.length + wc * 6;
    const f = freqMap.get(e.toLowerCase().split(/\s+/)[0]) || 0;
    score += Math.min(f, 5) * 2;
    scored.set(e, Math.max(scored.get(e) || 0, score));
  }

  for (const w of plain) {
    const lw = w.toLowerCase();
    let score = w.length;
    if (/^[A-Z]/.test(w)) score += 3;
    if (/\d/.test(w)) score += 4;
    score += Math.min(freqMap.get(lw) || 0, 5) * 2;
    scored.set(w, Math.max(scored.get(w) || 0, score));
  }

  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

// ─────────────────────────────────────────────────────────────────────────────
// Random helpers
// ─────────────────────────────────────────────────────────────────────────────

// Seeded PRNG (mulberry32) so quiz generation can be tied to the PDF's hash
// (passed in from routes/quiz.js) instead of raw Math.random(). This module
// keeps a "current" rng that generateQuizFallback() sets up per-call, so all
// the helper functions below (pickRandom/shuffle/makeTrueFalse) stay simple
// and don't need the rng threaded through every signature.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn a hex hash (or any string) + a nonce into a 32-bit integer seed. */
function seedFromHash(hash, nonce = Date.now()) {
  const str = String(hash || "seed");
  let h = 2166136261; // FNV-1a base
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Mix in the nonce so repeated "regenerate" calls on the same PDF (same
  // hash) still produce a different quiz, while the hash still contributes
  // real entropy rather than being ignored.
  return (h ^ nonce) >>> 0;
}

let rng = Math.random; // default; generateQuizFallback() replaces this per-call

function pickRandom(arr, n, exclude = []) {
  const excludeLower = new Set(exclude.map((x) => String(x).toLowerCase()));
  const pool = arr.filter((x) => !excludeLower.has(String(x).toLowerCase()));
  const out = [];
  const used = new Set();
  while (out.length < n && out.length < pool.length) {
    const idx = Math.floor(rng() * pool.length);
    if (!used.has(idx)) {
      used.add(idx);
      out.push(pool[idx]);
    }
  }
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeReplace(sentence, target, replacement) {
  const re = new RegExp(`\\b${escapeRe(target)}\\b`);
  if (!re.test(sentence)) return null;
  return sentence.replace(re, replacement);
}

// ─────────────────────────────────────────────────────────────────────────────
// Distractor generation — category-aware
// ─────────────────────────────────────────────────────────────────────────────

function numericDistractors(original) {
  const numMatch = original.match(/^(\d{1,3}(?:,\d{3})*(?:\.\d+)?)(\s?%)?$/);
  const suffix = numMatch?.[2] || "";
  const numeric = parseFloat((numMatch?.[1] || original).replace(/,/g, ""));
  if (Number.isNaN(numeric)) return [];

  const deltas = [0.5, 1.5, 2, 0.75].map((m) => Math.round(numeric * m));
  const shifted = [numeric + 10, numeric - 10, numeric + numeric * 0.2 + 1];
  const candidates = [...deltas, ...shifted]
    .map((n) => Math.max(0, Math.round(n)))
    .filter((n) => n !== numeric)
    .map((n) => `${n.toLocaleString()}${suffix}`);

  return [...new Set(candidates)];
}

function distractorsFor(answer, globalTermPool, sentence) {
  const isNumeric = /^\d/.test(answer.replace(/,/g, ""));
  const isMultiWord = answer.trim().includes(" ");
  const isCapitalized = /^[A-Z]/.test(answer);

  let pool;
  if (isNumeric) {
    pool = numericDistractors(answer);
  } else {
    pool = globalTermPool.filter((t) => {
      if (t.toLowerCase() === answer.toLowerCase()) return false;
      if (sentence.includes(t)) return false; // don't leak another correct-looking term from same sentence
      const tMultiWord = t.trim().includes(" ");
      const tCapitalized = /^[A-Z]/.test(t);
      const lenOk = Math.abs(t.length - answer.length) <= 8;
      return tMultiWord === isMultiWord && tCapitalized === isCapitalized && lenOk;
    });
    if (pool.length < 3) {
      pool = globalTermPool.filter(
        (t) => t.toLowerCase() !== answer.toLowerCase() && !sentence.includes(t)
      );
    }
  }

  const picked = pickRandom(pool, 3, [answer]);
  return picked;
}

// ─────────────────────────────────────────────────────────────────────────────
// Question builders — one per fact pattern
// ─────────────────────────────────────────────────────────────────────────────

function difficultyFromAnswer(answer, sentence) {
  const len = answer.replace(/\s/g, "").length;
  const wc = sentence.split(/\s+/).length;
  if (len > 10 || wc > 26) return "hard";
  if (len > 6 || wc > 16) return "medium";
  return "easy";
}

function topicFromSentence(sentence, ctx) {
  const entity = extractEntities(sentence)[0];
  if (entity) return entity.split(/\s+/).slice(0, 4).join(" ");
  const term = keyTerms(sentence, ctx.freqMap)[0];
  return term ? term.split(/\s+/).slice(0, 4).join(" ") : "General";
}

function enrichQuestion(q, sentence, ctx) {
  if (!q) return q;
  return {
    ...q,
    topic: topicFromSentence(sentence, ctx),
    sourceSnippet: sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence,
    pageRef: "",
  };
}

function buildOptionsBlock(answer, distractors) {
  if (distractors.length < 3) return null;
  return shuffle([answer, ...distractors.slice(0, 3)]);
}

/** Definition-style: "X is/are/refers to Y." -> "What is X?" */
function makeDefinitionMCQ(sentence, ctx, idx) {
  const m = sentence.match(DEFINITION_RE);
  if (!m) return null;
  const subject = m[1].trim();
  const definition = m[2].replace(/[.,;]+$/, "").trim();
  if (subject.split(/\s+/).length > 6 || definition.length < 10) return null;

  const otherDefs = ctx.definitions
    .filter((d) => d.subject.toLowerCase() !== subject.toLowerCase())
    .map((d) => d.definition);
  let distractors = pickRandom(otherDefs, 3, [definition]);
  if (distractors.length < 3) {
    // Pad with generic term-based distractors reframed as short phrases
    const pad = pickRandom(ctx.allTerms, 3 - distractors.length, [subject, ...distractors]);
    distractors = [...distractors, ...pad.map((t) => `Related to ${t}`)];
  }
  const options = buildOptionsBlock(definition, distractors);
  if (!options) return null;

  return enrichQuestion({
    id: `q_fb_def_${idx}_${Date.now()}`,
    type: "mcq",
    difficulty: difficultyFromAnswer(subject, sentence),
    question: `According to the text, what best describes "${subject}"?`,
    options,
    correctAnswer: definition,
    explanation: `The text states: "${sentence}"`,
  }, sentence, ctx);
}

/** Numeric fact: blank out a number/percentage/date-like figure. */
function makeNumericMCQ(sentence, ctx, idx) {
  const numbers = extractNumbers(sentence);
  if (!numbers.length) return null;
  const answer = numbers[0];
  const blanked = safeReplace(sentence, answer, "_____");
  if (!blanked) return null;

  const distractors = distractorsFor(answer, ctx.allNumbers.filter((n) => n !== answer), sentence);
  const options = buildOptionsBlock(answer, distractors.length >= 3 ? distractors : numericDistractors(answer));
  if (!options) return null;

  return enrichQuestion({
    id: `q_fb_num_${idx}_${Date.now()}`,
    type: "mcq",
    difficulty: "hard",
    question: `Fill in the missing figure: "${blanked}"`,
    options,
    correctAnswer: answer,
    explanation: `The original text states: "${sentence}"`,
  }, sentence, ctx);
}

/** Enumeration: "X include A, B, and C" -> "Which of these was NOT mentioned as part of X?" */
function makeEnumerationMCQ(sentence, ctx, idx) {
  if (!ENUM_TRIGGER_RE.test(sentence)) return null;
  const after = sentence.split(ENUM_TRIGGER_RE)[1];
  if (!after) return null;

  const items = after
    .split(/,|\band\b|\bor\b/)
    .map((s) => s.replace(/[.;]+$/, "").trim())
    .filter((s) => s.length >= 3 && s.split(/\s+/).length <= 5);

  if (items.length < 2) return null;

  const subjectMatch = sentence.match(/^([A-Z][A-Za-z0-9'’\-\s]{2,40}?)\s+(?:include|includes|comprise|comprises|consist of|consists of)/i);
  const subject = subjectMatch ? subjectMatch[1].trim() : "the text";

  const notMentioned = pickRandom(
    ctx.allTerms.filter((t) => !items.some((it) => it.toLowerCase().includes(t.toLowerCase()))),
    1,
    items
  )[0];
  if (!notMentioned) return null;

  const shownItems = shuffle(items).slice(0, 3);
  if (shownItems.length < 3) return null;

  const options = shuffle([notMentioned, ...shownItems]);

  return enrichQuestion({
    id: `q_fb_enum_${idx}_${Date.now()}`,
    type: "mcq",
    difficulty: "medium",
    question: `Which of the following was NOT mentioned as part of ${subject}?`,
    options,
    correctAnswer: notMentioned,
    explanation: `The text lists: "${sentence}" — "${notMentioned}" does not appear in that list.`,
  }, sentence, ctx);
}

/** Cause/effect: "...because X" / "X, therefore Y" -> "Why does ... happen?" */
function makeCauseEffectMCQ(sentence, ctx, idx) {
  const m = sentence.match(CAUSE_TRIGGER_RE);
  if (!m) return null;
  const splitIdx = sentence.indexOf(m[0]);
  const left = sentence.slice(0, splitIdx).trim().replace(/[,.;]+$/, "");
  const right = sentence.slice(splitIdx + m[0].length).trim().replace(/[.;]+$/, "");
  if (left.length < 10 || right.length < 10) return null;

  const isRightCause = /^(because|due to|as a result of|owing to|since)$/i.test(m[0].trim());
  const effect = isRightCause ? left : right;
  const cause = isRightCause ? right : left;
  if (cause.length < 8) return null;

  const distractors = pickRandom(ctx.causeClauses.filter((c) => c.toLowerCase() !== cause.toLowerCase()), 3, [cause]);
  if (distractors.length < 3) return null;
  const options = buildOptionsBlock(cause, distractors);
  if (!options) return null;

  return enrichQuestion({
    id: `q_fb_cause_${idx}_${Date.now()}`,
    type: "mcq",
    difficulty: "hard",
    question: `Based on the text, why does the following happen: "${effect}"?`,
    options,
    correctAnswer: cause,
    explanation: `The text states: "${sentence}"`,
  }, sentence, ctx);
}

/** Generic cloze fallback: blank out the highest-scoring term in the sentence. */
function makeGenericMCQ(sentence, ctx, idx) {
  const terms = keyTerms(sentence, ctx.freqMap);
  for (const answer of terms.slice(0, 4)) {
    const blanked = safeReplace(sentence, answer, "_____");
    if (!blanked) continue;
    const distractors = distractorsFor(answer, ctx.allTerms, sentence);
    const options = buildOptionsBlock(answer, distractors);
    if (!options) continue;
    return enrichQuestion({
      id: `q_fb_${idx}_${Date.now()}`,
      type: "mcq",
      difficulty: difficultyFromAnswer(answer, sentence),
      question: `Fill in the blank: "${blanked}"`,
      options,
      correctAnswer: answer,
      explanation: `The original text states: "${sentence}"`,
    }, sentence, ctx);
  }
  return null;
}

/** True/False with several corruption strategies: swap term, swap number, negate/antonym. */
function makeTrueFalse(sentence, ctx, idx) {
  const makeFalse = rng() > 0.42;

  const asTrue = () => enrichQuestion({
    id: `q_fb_tf_${idx}_${Date.now()}`,
    type: "true_false",
    difficulty: "easy",
    question: sentence,
    options: ["True", "False"],
    correctAnswer: "True",
    explanation: "This statement appears as-is in the source text.",
  }, sentence, ctx);

  if (!makeFalse) return asTrue();

  // Strategy 1: antonym/negation swap on a signal word
  const wordList = words(sentence);
  for (const w of wordList) {
    const lw = w.toLowerCase();
    if (ANTONYM_MAP.has(lw)) {
      const replacement = ANTONYM_MAP.get(lw);
      const cased = /^[A-Z]/.test(w) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
      const corrupted = safeReplace(sentence, w, cased);
      if (corrupted && corrupted !== sentence) {
        return enrichQuestion({
          id: `q_fb_tf_${idx}_${Date.now()}`,
          type: "true_false",
          difficulty: "medium",
          question: corrupted,
          options: ["True", "False"],
          correctAnswer: "False",
          explanation: `The original text actually says: "${sentence}"`,
        }, sentence, ctx);
      }
    }
  }

  // Strategy 2: swap a number for a different plausible one
  const numbers = extractNumbers(sentence);
  if (numbers.length) {
    const target = numbers[0];
    const alt = numericDistractors(target)[0];
    if (alt) {
      const corrupted = safeReplace(sentence, target, alt);
      if (corrupted && corrupted !== sentence) {
        return enrichQuestion({
          id: `q_fb_tf_${idx}_${Date.now()}`,
          type: "true_false",
          difficulty: "hard",
          question: corrupted,
          options: ["True", "False"],
          correctAnswer: "False",
          explanation: `The original text actually says: "${sentence}"`,
        }, sentence, ctx);
      }
    }
  }

  // Strategy 3: swap a key term for an unrelated one from the doc
  const terms = keyTerms(sentence, ctx.freqMap);
  if (terms.length) {
    const target = terms[0];
    const replacement = pickRandom(
      ctx.allTerms.filter((t) => t.toLowerCase() !== target.toLowerCase()),
      1,
      [target]
    )[0];
    const corrupted = replacement ? safeReplace(sentence, target, replacement) : null;
    if (corrupted && corrupted !== sentence) {
      return enrichQuestion({
        id: `q_fb_tf_${idx}_${Date.now()}`,
        type: "true_false",
        difficulty: "medium",
        question: corrupted,
        options: ["True", "False"],
        correctAnswer: "False",
        explanation: `The original text actually says: "${sentence}"`,
      }, sentence, ctx);
    }
  }

  return asTrue();
}

// ─────────────────────────────────────────────────────────────────────────────
// Context builder — pre-scans the whole doc once so individual question
// builders have rich pools of terms/numbers/definitions/causes to draw from.
// ─────────────────────────────────────────────────────────────────────────────

function buildContext(sentences) {
  const freqMap = buildFrequencyMap(sentences);
  const allTerms = [...new Set(sentences.flatMap((s) => keyTerms(s, freqMap)))];
  const allNumbers = [...new Set(sentences.flatMap((s) => extractNumbers(s)))];

  const definitions = [];
  const causeClauses = [];
  for (const s of sentences) {
    const dm = s.match(DEFINITION_RE);
    if (dm) {
      const subject = dm[1].trim();
      const definition = dm[2].replace(/[.,;]+$/, "").trim();
      if (subject.split(/\s+/).length <= 6 && definition.length >= 10) {
        definitions.push({ subject, definition });
      }
    }
    const cm = s.match(CAUSE_TRIGGER_RE);
    if (cm) {
      const splitIdx = s.indexOf(cm[0]);
      const left = s.slice(0, splitIdx).trim().replace(/[,.;]+$/, "");
      const right = s.slice(splitIdx + cm[0].length).trim().replace(/[.;]+$/, "");
      const isRightCause = /^(because|due to|as a result of|owing to|since)$/i.test(cm[0].trim());
      const cause = isRightCause ? right : left;
      if (cause && cause.length >= 8) causeClauses.push(cause);
    }
  }

  return { freqMap, allTerms, allNumbers, definitions, causeClauses };
}

/** Score a sentence's overall "richness" as quiz material, and tag a rough difficulty. */
function scoreSentence(sentence) {
  const wc = sentence.split(/\s+/).length;
  const hasEntity = extractEntities(sentence).length > 0;
  const hasNumber = extractNumbers(sentence).length > 0;
  const hasDefinition = DEFINITION_RE.test(sentence);
  const hasEnum = ENUM_TRIGGER_RE.test(sentence);
  const hasCause = CAUSE_TRIGGER_RE.test(sentence);

  let richness = 0;
  if (hasEntity) richness += 2;
  if (hasNumber) richness += 2;
  if (hasDefinition) richness += 3;
  if (hasEnum) richness += 3;
  if (hasCause) richness += 3;

  let difficulty = "easy";
  if (wc > 24 || hasCause || hasNumber) difficulty = "hard";
  else if (wc > 14 || hasEntity || hasEnum || hasDefinition) difficulty = "medium";

  return { richness, difficulty, hasDefinition, hasEnum, hasCause, hasNumber };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main question dispatcher — tries the most informative pattern for a sentence
// first, then falls back down the chain, so every sentence has a good chance
// of producing a usable question.
// ─────────────────────────────────────────────────────────────────────────────

function buildQuestionForSentence(sentence, ctx, idx, wantMCQ, strictType = false) {
  if (!wantMCQ) {
    return makeTrueFalse(sentence, ctx, idx);
  }

  const meta = scoreSentence(sentence);
  const attempts = [];
  if (meta.hasDefinition) attempts.push(makeDefinitionMCQ);
  if (meta.hasEnum) attempts.push(makeEnumerationMCQ);
  if (meta.hasCause) attempts.push(makeCauseEffectMCQ);
  if (meta.hasNumber) attempts.push(makeNumericMCQ);
  attempts.push(makeGenericMCQ);

  for (const fn of attempts) {
    const q = fn(sentence, ctx, idx);
    if (q) return q;
  }
  // Normally we'd fall back to a true/false question as a last resort, but
  // when the user explicitly asked for MCQ-only, that would violate their
  // choice — so return null and let the caller just skip this sentence.
  return strictType ? null : makeTrueFalse(sentence, ctx, idx);
}

function guessTitle(text, ctx) {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 4 && l.length <= 80 && !/[.!?]$/.test(l));
  if (firstLine) return firstLine;
  const topTerm = ctx.allTerms.find((t) => t.split(/\s+/).length >= 2) || ctx.allTerms[0];
  return topTerm ? `Quiz: ${topTerm}` : "Quiz (Rule-Based)";
}

/**
 * Generate a quiz purely with rules/heuristics — zero external API calls.
 * @param {string} text
 * @param {number} count
 * @param {"easy"|"medium"|"hard"|"mixed"} difficulty
 * @param {string} [hash] - sha256 (or any) hash of the source PDF, passed in
 *   from routes/quiz.js. Used to seed randomization so behavior is
 *   consistent with the rest of the generate pipeline (which is keyed off
 *   this same hash for caching).
 * @param {"mixed"|"mcq"|"true_false"} [questionType] - which question type(s)
 *   to generate. "mixed" keeps the ~70/30 mcq/true_false split.
 */
export function generateQuizFallback(text, count = 10, difficulty = "mixed", hash = null, questionType = "mixed") {
  rng = mulberry32(seedFromHash(hash));

  const wantsMCQOnly = questionType === "mcq";
  const wantsTFOnly = questionType === "true_false";

  const allSentences = splitSentences(text);
  if (allSentences.length === 0) {
    throw new Error("Not enough readable text in this PDF to build a quiz.");
  }

  const ctx = buildContext(allSentences);

  // Rank sentences by richness, then filter/prioritize toward requested difficulty
  const ranked = allSentences
    .map((s) => ({ sentence: s, meta: scoreSentence(s) }))
    .sort((a, b) => b.meta.richness - a.meta.richness);

  let ordered;
  if (difficulty === "easy" || difficulty === "medium" || difficulty === "hard") {
    const matching = ranked.filter((r) => r.meta.difficulty === difficulty);
    const rest = ranked.filter((r) => r.meta.difficulty !== difficulty);
    ordered = [...shuffle(matching), ...shuffle(rest)];
  } else {
    // Mixed: interleave a healthy spread rather than always leading with the "richest" sentences
    ordered = shuffle(ranked);
  }

  const questions = [];
  const usedAnswers = new Set();
  const usedSentences = new Set();
  let i = 0;

  for (const { sentence } of ordered) {
    if (questions.length >= count) break;
    if (usedSentences.has(sentence)) continue;

    const wantMCQ = wantsMCQOnly ? true : wantsTFOnly ? false : rng() < 0.7; // ~70% mcq / 30% true-false when mixed
    const q = buildQuestionForSentence(sentence, ctx, i, wantMCQ, wantsMCQOnly || wantsTFOnly);

    if (q && !usedAnswers.has(q.correctAnswer.toLowerCase())) {
      questions.push(q);
      usedAnswers.add(q.correctAnswer.toLowerCase());
      usedSentences.add(sentence);
    }
    i++;
  }

  // If we still fall short (very short/sparse source text), do a relaxed second pass
  if (questions.length < Math.min(count, 3)) {
    for (const { sentence } of ranked) {
      if (questions.length >= count) break;
      if (usedSentences.has(sentence)) continue;
      const wantMCQ = wantsTFOnly ? false : true; // prefer mcq (more forgiving), unless TF-only was requested
      const q = buildQuestionForSentence(sentence, ctx, i++, wantMCQ, wantsMCQOnly || wantsTFOnly);
      if (q) {
        questions.push(q);
        usedSentences.add(sentence);
      }
    }
  }

  if (questions.length === 0) {
    throw new Error("Could not extract enough structured content to build a quiz.");
  }

  return { title: guessTitle(text, ctx), source: "rule-based", questions };
}
