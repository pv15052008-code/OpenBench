# OpenBench

Share a campus's lab equipment and rooms with a record of every hand they pass through.

Students find a 3D printer, oscilloscope, camera or seminar hall, see exactly what they need to book it, and request a slot. Owners review each request with a reason. Check-in and return each record a checklist and photos. Damage and disputes go to a department manager. Every step lands in a register that neither side can edit.

One codebase runs as a **web app, an Android app and an iOS app**.

| | |
| --- | --- |
| Web app | `https://<your-vercel-url>` |
| Android | APK from the latest EAS build |
| iOS | Expo Go QR, or TestFlight |
| Judge guide | [docs/TESTING.md](docs/TESTING.md) |
| Project document | [docs/PROJECT_DOCUMENT.md](docs/PROJECT_DOCUMENT.md) |
| Deploying | [docs/DEPLOY.md](docs/DEPLOY.md) |

## How it's built

```
apps/mobile        Expo (React Native) app: web, Android, iOS from one TypeScript codebase
services/api       FastAPI engine: AI briefs, certificate pre-screen, incident summaries, smart search,
                   scheduled sweep (no-shows, overdue), email, demo reset
supabase/          Postgres schema, business rules, row-level security, storage policies, demo seed
                   (courses and training tags are registered per department; only that department verifies its training)
  migrations/      0001 schema · 0002 lifecycle logic · 0003 RLS + grants · 0004 storage · 0005 demo seed · 0006 save_resource
  tests/           Database test suite (runs against a local Postgres with a Supabase shim) + local test gateway
scripts/           seed-demo.mjs: creates demo accounts and data in a Supabase project
.github/workflows  CI (database, API and app checks) and the 10-minute cron
```

The rules live in the database, not the app. Students and owners can only change a booking through checked functions (`request_booking`, `decide_booking`, `check_in`, `return_booking`, `confirm_return`, `report_incident`, `resolve_incident`…). A trigger enforces the allowed status moves and writes the audit log on every change. An exclusion constraint makes double-booking impossible even if two approvals race.

## Run the checks locally

```bash
# Database: 49 tests covering the full lifecycle, fairness, and attacks a student or owner might try
python -m pytest supabase/tests -q          # needs a local Postgres 16 (see supabase/tests/reset_local.sh)

# API: 16 tests with Supabase mocked
cd services/api && pip install -r requirements.txt pytest && python -m pytest tests -q

# App: typecheck and build the web version
cd apps/mobile && npm ci && npx tsc --noEmit && npx expo export --platform web
```

## Run everything on your computer

Needs Docker Desktop (running), Node 20.19+ and Python 3.10+.

```bash
./scripts/local-up.sh        # starts local Supabase in Docker, the API on :8000 and the app on :8081
./scripts/local-down.sh      # stops it all and frees the memory; your data is kept
./scripts/local-up.sh --seed # start and rebuild the demo data
```

Open http://localhost:8081 in Safari or Chrome. Supabase Studio (a database browser) is at http://127.0.0.1:54323.
The first start downloads about 3 GB of Docker images; later starts take under a minute.

## Run the app against your Supabase project

```bash
cd apps/mobile
cp .env.example .env      # fill in your Supabase URL, anon key and API URL
npm ci
npx expo start            # press w for web; scan the QR with Expo Go for a phone
```

## Disclosures

Libraries: Expo, React Native, Expo Router, TanStack Query, supabase-js, FastAPI, httpx, pydantic, IBM Plex fonts (SIL Open Font License), Feather icons. Services: Supabase, Vercel, Render, Expo EAS, Google Gemini API (optional), Resend (optional). AI-assisted development: Claude (Anthropic) generated much of the code, tests and documentation. No pre-existing project code or templates beyond `create-expo-app`'s blank TypeScript starter. All demo people, rooms and records are fictional.
