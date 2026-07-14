/**
 * aiService.js — Unified AI quiz generator
 * Priority: Anthropic Claude (claude-sonnet-4-6) → Gemini Flash → throws
 */

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_THINKING_BUDGET = Number.parseInt(process.env.GEMINI_THINKING_BUDGET ?? "0", 10);

// ─── Shared system prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a quiz generation engine. Given source text, output ONLY valid JSON — no markdown, no code fences, no commentary.

Schema:
{
  "title": "short quiz title from content",
  "questions": [
    {
      "id": "q_1",
      "type": "mcq" | "true_false",
      "difficulty": "easy" | "medium" | "hard",
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": "must match one option exactly",
      "explanation": "2 short sentences: why the answer is correct and what source idea supports it",
      "topic": "short topic/category from the source, 1-4 words",
      "sourceSnippet": "short supporting quote or paraphrase from the source, under 140 characters",
      "pageRef": "page/section reference if visible in text, otherwise empty string"
    }
  ]
}

Rules:
- true_false options are always exactly ["True", "False"]
- mcq options are always exactly 4
- All questions strictly from the given text
- No duplicate facts
- Short, unambiguous questions
- Honest difficulty tagging
- Include a useful topic for every question
- Include sourceSnippet for every question when possible
- Include pageRef only if the source text clearly contains page/section markers`;

function difficultyClause(d) {
  if (d === "easy") return "ALL questions EASY (direct recall, simple facts).";
  if (d === "medium") return "ALL questions MEDIUM (understanding, not just recall).";
  if (d === "hard") return "ALL questions HARD (inference, comparisons, connecting facts).";
  return "Mix: ~40% easy, 40% medium, 20% hard.";
}

function questionTypeClause(t) {
  if (t === "mcq") return "ALL questions must be type \"mcq\" (4 options each). Do NOT produce any true_false questions.";
  if (t === "true_false") return "ALL questions must be type \"true_false\" (options exactly [\"True\", \"False\"]). Do NOT produce any mcq questions.";
  return "Mix ~70% mcq / 30% true_false.";
}

// ─── Shared response parser ───────────────────────────────────────────────────
function parseAndValidate(raw, count, questionType = "mixed") {
  let quiz;
  try {
    quiz = JSON.parse(raw);
  } catch {
    const cleaned = raw
      .replace(/```json|```/gi, "")
      .replace(/^[^{[]*/, "")  // strip leading non-JSON
      .replace(/[^}\]]*$/, "") // strip trailing non-JSON
      .trim();
    quiz = JSON.parse(cleaned);
  }

  if (!quiz?.questions?.length) throw new Error("AI returned no questions");

  quiz.questions = quiz.questions
    .map((q, i) => ({
      id: q.id || `q_${i + 1}`,
      type: q.type === "true_false" ? "true_false" : "mcq",
      difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
      question: String(q.question || "").trim(),
      options: q.type === "true_false"
        ? ["True", "False"]
        : Array.isArray(q.options)
          ? q.options.slice(0, 4).map(String)
          : [],
      correctAnswer: String(q.correctAnswer || "").trim(),
      explanation: String(q.explanation || "").trim(),
      topic: String(q.topic || "General").trim().slice(0, 40) || "General",
      sourceSnippet: String(q.sourceSnippet || q.source || "").trim().slice(0, 180),
      pageRef: String(q.pageRef || q.page || "").trim().slice(0, 40),
    }))
    // Belt-and-suspenders: even if the model ignores the prompt's type
    // instruction, only keep questions matching what the user asked for.
    .filter((q) => (questionType === "mixed" ? true : q.type === questionType))
    .slice(0, count)
    .filter((q) => q.question && q.options.length >= 2 && q.correctAnswer);

  if (!quiz.questions.length) throw new Error("No valid questions after filtering");
  return { title: String(quiz.title || "AI Generated Quiz"), source: "ai", questions: quiz.questions };
}

// ─── Anthropic ────────────────────────────────────────────────────────────────
function mergedSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener?.("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.("abort", abort);
    },
  };
}

async function generateWithAnthropic(text, count, difficulty, questionType, signal) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const userPrompt = `${difficultyClause(difficulty)}\n${questionTypeClause(questionType)}\nGenerate exactly ${count} questions from:\n\n"""\n${text.slice(0, 22000)}\n"""`;

  const abortable = mergedSignal(40000, signal);

  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: abortable.signal,
    });
  } finally {
    abortable.cleanup();
  }

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Anthropic API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const raw = data?.content?.[0]?.text;
  if (!raw) throw new Error("Anthropic returned empty response");

  return parseAndValidate(raw, count, questionType);
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function generateWithGemini(text, count, difficulty, questionType, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const userPrompt = `${SYSTEM_PROMPT}\n\n${difficultyClause(difficulty)}\n${questionTypeClause(questionType)}\n\nGenerate exactly ${count} questions from:\n\n"""\n${text.slice(0, 20000)}\n"""`;

  const abortable = mergedSignal(120000, signal);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          thinkingConfig: Number.isFinite(GEMINI_THINKING_BUDGET)
            ? { thinkingBudget: GEMINI_THINKING_BUDGET }
            : undefined,
        },
      }),
      signal: abortable.signal,
    });
  } finally {
    abortable.cleanup();
  }

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned empty response");

  return parseAndValidate(raw, count, questionType);
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function generateQuizWithAI(text, count = 10, difficulty = "mixed", questionType = "mixed", options = {}) {
  // Prefer Anthropic → Gemini → throw (caller handles fallback)
  if (process.env.ANTHROPIC_API_KEY) {
    return generateWithAnthropic(text, count, difficulty, questionType, options.signal);
  }
  if (process.env.GEMINI_API_KEY) {
    return generateWithGemini(text, count, difficulty, questionType, options.signal);
  }
  throw new Error("No AI API key configured (ANTHROPIC_API_KEY or GEMINI_API_KEY)");
}
