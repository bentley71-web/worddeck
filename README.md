# WordDeck

Upload an English vocabulary list in almost any form — typed text, CSV, a photo of a
textbook page, or a GoodNotes / PDF export (handwriting included) — and AI turns it into
a clean deck. Then study it as a multiple-choice quiz (英→中 / 中→英 / 混合) that schedules
itself with spaced repetition until you've memorized the words. Accounts + cloud sync via
Supabase, so your decks follow you across devices.

Same stack as `gister`: FastAPI + Google Gemini on the backend, single-page frontend.

## How it fits together

- **FastAPI (this repo, deploy on Render)** — the Gemini proxy. It holds no user data.
  It verifies the caller's Supabase JWT and enforces a per-user daily quota, then reads
  the uploaded file/text and returns structured `{english, chinese, ai_filled}` pairs.
- **Supabase** — auth + Postgres (decks, cards, review schedule, quiz history) with RLS.
  The browser talks to Supabase directly for all data; spaced-repetition updates go
  through the `record_review` RPC so two devices can't clobber each other.

## Setup

### 1. Supabase
1. Create a project.
2. Run `migrations/001_init.sql` in the SQL editor.
3. (Optional) enable Google auth: Authentication → Providers → Google, and add your
   site URL + `http://localhost:8000` to the redirect allow-list.
4. Grab **Project URL**, **anon key** (public), and the **JWT secret** (Settings → API).

### 2. Backend
```bash
cd worddeck
cp .env.example .env      # fill GEMINI_API_KEY, SUPABASE_JWT_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY
pip install -r requirements.txt
./start.sh                # http://localhost:8000
```
For local dev without auth wired up yet, set `DEV_ALLOW_NO_AUTH=1` in `.env` (never in prod).

### 3. Frontend config
Either hard-code the public values in `static/js/config.js`, or just open the app and
paste the Supabase URL + anon key in the setup screen (saved to `localStorage`).

## Deploy
Push to a repo, point Render at it (`render.yaml` included), and set the `sync:false`
env vars in the Render dashboard. Serve is a single web service.

## Notes
- Gemini reads images/PDF/handwriting natively — no OCR library.
- Scheduler is a simplified SM-2 (correct advances the interval, wrong resets it). Not a
  full Anki clone: no sibling burying or multi-step learning graduation.
- AI-supplied translations are flagged `ai_filled` and shown in amber in the preview so
  you can check them before saving.
