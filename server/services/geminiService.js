const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

const SYSTEM_INSTRUCTION = `You are a quiz generation engine. Given source text, generate a quiz.
Return ONLY valid JSON, no markdown fences, no commentary, matching this exact schema:

{
  "title": "string - short quiz title based on the content",
  "questions": [
    {
      "id": "string uuid-like id",
      "type": "mcq" | "true_false",
      "difficulty": "easy" | "medium" | "hard",
      "question": "string",
      "options": ["string", "string", "string", "string"],
      "correctAnswer": "string - must exactly match one of options",
      "explanation": "string - 1 sentence why this is correct"
    }
  ]
}

Rules:
- Mix of "mcq" and "true_false" types, roughly 70% mcq / 30% true_false.
- Questions must be answerable strictly from the given text.
- Do not repeat the same fact twice.
- Keep questions concise and unambiguous.
- Tag each question's difficulty honestly based on how much reasoning/recall it needs.`;

function difficultyClause(difficulty) {
  if (difficulty === "easy") return "All questions should be EASY (direct recall of simple facts).";
  if (difficulty === "medium") return "All questions should be MEDIUM difficulty (requires understanding, not just recall).";
  if (difficulty === "hard") return "All questions should be HARD (requires inference, comparison, or connecting multiple facts).";
  return "Mix difficulties: roughly 40% easy, 40% medium, 20% hard.";
}

export async function generateQuizWithGemini(text, count = 10, difficulty = "mixed") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const prompt = `${SYSTEM_INSTRUCTION}

${difficultyClause(difficulty)}

Generate exactly ${count} questions from the following source text:

"""
${text.slice(0, 20000)}
"""`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: "application/json",
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini returned empty response");

  let quiz;
  try {
    quiz = JSON.parse(raw);
  } catch {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    quiz = JSON.parse(cleaned);
  }

  if (!quiz?.questions?.length) throw new Error("Gemini returned no questions");

  quiz.questions = quiz.questions.map((q, i) => ({
    id: q.id || `q_${i}_${Date.now()}`,
    type: q.type === "true_false" ? "true_false" : "mcq",
    difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
    question: q.question,
    options:
      q.type === "true_false"
        ? ["True", "False"]
        : Array.isArray(q.options) && q.options.length === 4
        ? q.options
        : q.options?.slice(0, 4) || [],
    correctAnswer: q.correctAnswer,
    explanation: q.explanation || "",
  }));

  return { title: quiz.title || "AI Generated Quiz", source: "gemini", questions: quiz.questions };
}
