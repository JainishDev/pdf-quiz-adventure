# PDF Quiz Adventure 🎮

AI-powered PDF → Quiz generator with a Pokemon FireRed pixel UI.
**Astro + React** frontend, **Node/Express** backend, **Gemini API** primary
generator with a **zero-dependency rule-based fallback** (so it never fully breaks).

---

## 👨‍🎓 Student Information

- **Name:** Patel Jainish M.
- **Enrollment No:** 240163116022
- **Semester:** 7th Semester
- **College:** Government Engineering College, Modasa

---

## 📖 About This Repository

**PDF Quiz Adventure** is an AI-powered quiz generator that transforms PDF documents into interactive Pokemon-style battle quizzes. The application leverages Google's Gemini AI for intelligent question generation with a robust rule-based fallback ensuring it never fails.

### 🌐 Live Demo

**🔗 Live Application:** https://quizadventure.vercel.app/

**🎥 Video Tutorial:** https://youtube.be/ntT0iSZEUW4

---

### 🎯 Project Overview

This project was developed as part of the **Tools and Automation Process Internship** at **Unicode Technolab**. It demonstrates modern full-stack development practices with:

- **Frontend:** Astro + React with Pokemon FireRed pixel-art UI
- **Backend:** Express.js API with PDF parsing, OCR, and AI integration
- **AI Integration:** Google Gemini API (Flash-Latest for quiz generation)
- **PDF Processing:** pdf-parse for text extraction + pdfjs-dist + tesseract.js for OCR
- **Fallback System:** Zero-dependency rule-based quiz generator (pure JavaScript)
- **Game Mechanics:** XP/Level system, Combo multipliers, Battle timer, Badges
- **Persistence:** localStorage for Trainer Profile, Upstash Redis for leaderboard

### ✨ Key Features

1. **PDF Upload & Processing**
   - Drag-and-drop PDF upload (max 25MB)
   - Automatic text extraction with `pdf-parse`
   - **OCR for scanned/image PDFs** — auto-detected, rasterized with `pdfjs-dist` + `canvas`, OCR'd with `tesseract.js`

2. **AI-Powered Quiz Generation**
   - Gemini API with strict JSON schema prompting
   - MCQ + True/False question types
   - Difficulty selector: Easy / Medium / Hard / Mixed
   - **Rule-based fallback** — sentence extraction, keyword scoring, fill-in-the-blank MCQs, statement corruption for T/F

3. **Pokemon Battle-Style Gameplay**
   - Dialog box questions, HP-bar progress, menu-cursor option select
   - 20s battle timer per question (auto-submits on timeout)
   - Synthesized 8-bit sound effects (Web Audio API — no audio files)
   - XP scoring by difficulty + speed bonus
   - Combo system: 3+ streak = 1.5x, 5+ streak = 2x with "COMBO xN!" popup

4. **Trainer Profile (Persistent)**
   - Total XP, Level (grows with XP thresholds), Best streak, Accuracy
   - Badges: First Steps, Combo Master, Unstoppable, Rising Star, Sharpshooter, etc.
   - Last 10 quiz history — survives browser restarts (localStorage)

5. **Answer Review & Leaderboard**
   - Post-quiz review: every question with your answer vs correct answer
   - Global leaderboard with Upstash Redis

### 🛠️ Tech Stack

| Category | Technology |
|----------|------------|
| Frontend Framework | Astro 4.x + React 18 |
| Backend Framework | Express.js (Node.js) |
| Language | JavaScript (ESM) |
| AI/ML | Google Gemini API (`gemini-flash-latest`) |
| PDF Processing | pdf-parse, pdfjs-dist, tesseract.js |
| OCR | tesseract.js (WebAssembly) |
| Real-time/Leaderboard | Upstash Redis (REST) |
| Styling | CSS with CSS Variables (pixel-art theme) |
| Sound | Web Audio API (synthesized) |
| Persistence | localStorage (profile), Upstash Redis (leaderboard) |
| Deployment | Vercel (monorepo) |

### 📁 Project Structure

```
quiz-app/
├── api/                    # Vercel serverless entry point
│   ├── [...path].js        # Express app wrapper for Vercel
│   ├── leaderboard.js      # Leaderboard API
│   ├── leaderboard/
│   │   └── [...path].js
│   └── quiz/
│       └── [...path].js
├── client/                 # Astro + React Frontend
│   ├── astro.config.mjs    # Astro config (proxies /api to server)
│   ├── package.json
│   ├── public/
│   │   └── sfx/            # (empty - all SFX synthesized)
│   └── src/
│       ├── env.d.ts
│       ├── components/
│       │   ├── QuizApp.jsx      # Main quiz battle component
│       │   ├── confetti.js      # Celebration animation
│       │   ├── rivalBattle.js   # Rival battle logic
│       │   ├── sfx.js           # Web Audio synth SFX
│       │   └── trainerProfile.js # XP/Level/Badge system
│       ├── pages/
│       │   └── index.astro      # Main page
│       └── styles/
│           └── pokemon.css      # Pixel-art CSS (variables at top)
├── server/                 # Express Backend
│   ├── eng.traineddata     # Tesseract English language data
│   ├── env.js              # Environment validation
│   ├── index.js            # Express app entry
│   ├── package.json
│   ├── routes/
│   │   ├── leaderboard.js  # Leaderboard endpoints
│   │   └── quiz.js         # Quiz generation + PDF upload
│   ├── services/
│   │   ├── aiService.js        # Orchestrates Gemini + Fallback
│   │   ├── fallbackService.js  # Rule-based quiz generator
│   │   ├── geminiService.js    # Gemini API integration
│   │   ├── ocrService.js       # PDF OCR (pdfjs-dist + tesseract)
│   │   └── pdfService.js       # PDF text extraction (pdf-parse)
│   └── uploads/            # Multer temp upload directory
├── uploads/                # Root uploads (if used)
├── vercel.json             # Vercel deployment config
├── package.json            # Root package.json
└── README.md
```

### 🚀 Getting Started

#### Prerequisites
- Node.js 18+ (tested on 20+)
- Google Gemini API key

#### Installation

```bash
# Clone the repository
git clone <repository-url>
cd quiz-app

# Backend setup
cd server
npm install
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
npm run dev       # http://localhost:5000

# Frontend setup (in a new terminal)
cd ../client
npm install
npm run dev       # http://localhost:4321 (proxies /api to :5000)
```

#### Environment Variables

**Server (`server/.env`):**
```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-flash-latest
GEMINI_THINKING_BUDGET=0
UPSTASH_REDIS_REST_URL=your_upstash_rest_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_rest_token
OCR_MAX_PAGES=15
OCR_WORKERS=2
OCR_RENDER_SCALE=2.6
OCR_MIN_CHARS_PER_PAGE=80
```

Get your Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
Get Upstash Redis credentials from [Upstash Console](https://console.upstash.com/)

### 📦 Available Scripts

| Command | Description |
|---------|-------------|
| `cd server && npm run dev` | Start backend dev server (port 5000) |
| `cd client && npm run dev` | Start frontend dev server (port 4321) |
| `cd client && npm run build` | Build frontend for production |
| `cd server && npm start` | Start production backend |

### 🌐 Deployment to Vercel

This project is configured for monorepo deployment on Vercel:

1. Push to GitHub/GitLab/Bitbucket
2. Import project in Vercel (select repo root)
3. Add environment variables in Vercel dashboard:
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` (default: `gemini-flash-latest`)
   - `GEMINI_THINKING_BUDGET` (default: `0`)
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `OCR_MAX_PAGES` (default: `20`)
   - `OCR_WORKERS` (default: `2`)
   - `OCR_RENDER_SCALE` (default: `2.6`)
   - `OCR_MIN_CHARS_PER_PAGE` (default: `80`)
4. Deploy!

The `vercel.json` builds `client/` and routes `/api/*` to the Express serverless function in `api/[...path].js`.

**Note:** Do not set `PUBLIC_API_BASE` when frontend and API are deployed together on Vercel; the client uses same-origin `/api/*` by default.

### 🔧 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/quiz` | Upload PDF, generate quiz (returns questions + engine used) |
| GET | `/api/leaderboard` | Get global leaderboard |
| POST | `/api/leaderboard` | Submit score to leaderboard |

### 🤖 AI Models Used

- **Quiz Generation:** `gemini-flash-latest` (Gemini 1.5 Flash)
- **Fallback:** Pure JavaScript rule-based generator (no AI)

### ⚙️ Configuration & Tuning

| File | What to Tune |
|------|--------------|
| `server/services/geminiService.js` | Gemini model, prompt engineering, JSON schema |
| `server/services/fallbackService.js` | `STOPWORDS`, sentence length filters, MCQ/TF ratio (70/30) |
| `server/services/ocrService.js` | `maxPages` (default 15), `charsPerPage` threshold for scan detection |
| `client/src/styles/pokemon.css` | CSS variables for colors, pixel sizes, animations |
| `client/src/components/sfx.js` | Synth frequencies, durations, waveforms |
| `client/src/components/trainerProfile.js` | `xpForLevel` curve, badge unlock conditions |
| `client/src/components/QuizApp.jsx` | `TIME_PER_QUESTION` (20s), `XP_BY_DIFFICULTY` |

### 📝 License

This project is developed for educational purposes as part of the Tools and Automation Process Internship at Unicode Technolab.

---

**Developed with ❤️ by Patel Jainish M.**  
Government Engineering College Modasa | Semester 7 | 2024-2025
