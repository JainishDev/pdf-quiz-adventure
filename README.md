# PDF Quiz Adventure 🎮

AI-powered PDF → Quiz generator with a Pokemon FireRed pixel UI.
**Astro + React** frontend, **Node/Express** backend, **Gemini API** primary
generator with a **zero-dependency rule-based fallback** (so it never fully breaks).

```
quiz-app/
├── server/     # Express API: PDF parsing + OCR + Gemini + rule-based fallback
└── client/     # Astro + React frontend, Pokemon-style pixel UI, synth SFX, XP/level system
```

## What's new in this version

- **OCR for scanned/image PDFs** — if a PDF has little/no extractable text layer
  (`services/ocrService.js` auto-detects this), pages are rasterized with
  `pdfjs-dist` + `canvas` and OCR'd with `tesseract.js`. Fully automatic, no user action needed.
- **Difficulty selector** — Easy / Medium / Hard / Mixed, sent to Gemini's prompt
  and used by the rule-based fallback's own difficulty heuristic.
- **Battle timer** — 20s per question, HP-bar-style countdown, auto-submits as
  wrong (time out) if you don't answer in time.
- **XP + Combo system** — correct answers give XP based on difficulty + speed
  bonus; streaks of 3+ give a 1.5x multiplier, 5+ gives 2x, with a "COMBO xN!" popup.
- **Trainer Profile (persistent, localStorage)** — total XP, level (grows with
  XP thresholds), best streak, accuracy, badges (First Steps, Combo Master,
  Unstoppable, Rising Star, Sharpshooter, etc.), and last-10 quiz history —
  survives across sessions/browser restarts.
- **Answer Review screen** — after results, see every question with your
  answer vs. the correct one before starting a new quiz.
- **Mute toggle** — top-right speaker icon, mutes all synth SFX instantly.
- **Engine + OCR badges** shown live during the quiz (Gemini AI / Rule-Based, 📷 OCR).

## 1. Backend setup

```bash
cd server
npm install
cp .env.example .env
# open .env and paste your Gemini API key
npm run dev       # http://localhost:5000
```

Get a free Gemini API key: https://aistudio.google.com/apikey

If `GEMINI_API_KEY` is missing, invalid, rate-limited, or Gemini errors out
for any reason, the server **automatically falls back** to the rule-based
generator (`services/fallbackService.js`) — no crash, quiz still generates.

## 2. Frontend setup

```bash
cd client
npm install
npm run dev        # http://localhost:4321
```

The dev server proxies `/api/*` to `http://localhost:5000` (see `astro.config.mjs`),
so run backend + frontend together in two terminals.

## 3. How it works

1. User uploads a PDF (drag-drop or tap, Pokeball dropzone UI).
2. Backend extracts text with `pdf-parse`.
3. Backend calls **Gemini** with a strict JSON schema prompt → MCQ + True/False questions.
4. If Gemini fails (no key / rate limit / network / bad JSON) → **rule-based fallback**
   kicks in: sentence extraction, keyword/term scoring, fill-in-the-blank MCQs,
   and true/false via statement corruption — all pure JS, no AI needed.
5. Frontend renders a Pokemon-battle-style quiz: dialog box questions, HP-bar
   progress, menu-cursor option select, synthesized 8-bit sound effects
   (Web Audio oscillators — no mp3 files, instant load).
6. Result screen shows score, accuracy %, and which engine answered (Gemini vs rule-based).

## 4. Notes / things to tune

- `server/services/geminiService.js` → change `GEMINI_MODEL` in `.env` if you want a different Gemini model.
  Default: `gemini-flash-latest`.
- `server/services/fallbackService.js` → tune `STOPWORDS`, sentence length filters, or MCQ/TF ratio (currently 70/30).
- `server/services/ocrService.js` → `maxPages` caps how many pages get OCR'd (default 15, since OCR is slow); raise `looksLikeScannedPdf`'s `charsPerPage` threshold if OCR triggers too eagerly/rarely.
- `client/src/styles/pokemon.css` → colors/pixel sizes are all CSS variables at the top — easy to reskin.
- `client/src/components/sfx.js` → all sound effects are synthesized; tweak frequencies/durations for different SFX feel.
- `client/src/components/trainerProfile.js` → tune XP-per-level curve (`xpForLevel`) or add more badge rules.
- `client/src/components/QuizApp.jsx` → `TIME_PER_QUESTION` (seconds) and `XP_BY_DIFFICULTY` control the battle timer and scoring.
- Max PDF size: 25MB (multer limit in `routes/quiz.js`). Scanned PDFs now work via OCR, but OCR is CPU/time heavy — expect 5-15s per page.

## 5. Production build

```bash
cd client && npm run build   # outputs to client/dist
cd server && npm start       # run behind a reverse proxy, serve client/dist as static
```

## 6. Vercel deployment

Deploy the repo root. `vercel.json` builds `client/` and routes `/api/*` to the
Express serverless function in `api/[...path].js`.

Set these Vercel environment variables:

```bash
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-flash-latest
GEMINI_THINKING_BUDGET=0
UPSTASH_REDIS_REST_URL=your_upstash_rest_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token
OCR_MAX_PAGES=20
OCR_WORKERS=2
OCR_RENDER_SCALE=2.6
OCR_MIN_CHARS_PER_PAGE=80
```

Do not set `PUBLIC_API_BASE` when frontend and API are deployed together on
Vercel; the client uses same-origin `/api/*` by default.
