#!/usr/bin/env bash
# Run OpenBench on this computer: local Supabase (in Docker), the engine API and the app.
#
#   ./scripts/local-up.sh          start everything (first run also creates the demo data)
#   ./scripts/local-up.sh --seed   start and rebuild the demo data
#   ./scripts/local-down.sh        stop it all and free memory
#
# Needs: Docker Desktop running, Node 20.19+ (nvm), Python 3.10+.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Node from nvm if present (Expo SDK 58 needs Node 20.19 or newer)
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 24 >/dev/null 2>&1 || nvm use --lts >/dev/null; fi
echo "Node $(node -v)"

docker info >/dev/null 2>&1 || { echo "Docker isn't running. Open Docker Desktop, wait for it to start, then run this again."; exit 1; }

echo "1/5 Starting Supabase (database, login, storage)…"
(cd scripts && npm install --silent)
SB="npx --prefix scripts supabase"
$SB start --workdir . >/dev/null
eval "$($SB status -o env --workdir . 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY|SECRET_KEY|STUDIO_URL)=')"
ANON="${ANON_KEY:-${PUBLISHABLE_KEY:-}}"
SERVICE="${SERVICE_ROLE_KEY:-${SECRET_KEY:-}}"
[ -n "$ANON" ] && [ -n "$SERVICE" ] || { echo "Couldn't read the local Supabase keys from 'supabase status'."; exit 1; }

echo "2/5 Writing local settings…"
cat > apps/mobile/.env <<ENV
EXPO_PUBLIC_SUPABASE_URL=$API_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY=$ANON
EXPO_PUBLIC_API_URL=http://localhost:8000
ENV
CRON_SECRET_VALUE="$(openssl rand -hex 16)"
cat > services/api/.env <<ENV
SUPABASE_URL=$API_URL
SUPABASE_ANON_KEY=$ANON
SUPABASE_SERVICE_ROLE_KEY=$SERVICE
CRON_SECRET=$CRON_SECRET_VALUE
APP_URL=http://localhost:8081
ALLOWED_ORIGINS=http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006
GEMINI_API_KEY=${GEMINI_API_KEY:-}
ENV

echo "3/5 Demo data…"
SEEDED_FLAG="$ROOT/supabase/.temp/openbench-seeded"
if [ "${1:-}" = "--seed" ] || [ ! -f "$SEEDED_FLAG" ]; then
  (cd scripts && SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE" node seed-demo.mjs)
  mkdir -p "$(dirname "$SEEDED_FLAG")" && touch "$SEEDED_FLAG"
else
  echo "   already there (use --seed to rebuild)"
fi

echo "4/5 Starting the engine API on http://localhost:8000 …"
cd services/api
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
pkill -f "uvicorn app.main:app" 2>/dev/null || true
nohup .venv/bin/uvicorn app.main:app --port 8000 > "$ROOT/services/api/api.log" 2>&1 &
cd "$ROOT"
for i in $(seq 1 20); do curl -fs http://localhost:8000/health >/dev/null 2>&1 && break; sleep 1; done
curl -fs http://localhost:8000/health >/dev/null && echo "   API is up" || echo "   API didn't start; see services/api/api.log"

echo "5/5 Starting the app…"
cd apps/mobile
[ -d node_modules ] || npm install
echo
echo "   Web: press w (or open http://localhost:8081)"
echo "   Phone: install Expo Go and scan the QR code (same Wi-Fi). Note: on a phone, 'localhost' is the phone,"
echo "   so for phones set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_API_URL in apps/mobile/.env to this Mac's Wi-Fi IP."
echo "   Database admin (Supabase Studio): ${STUDIO_URL:-http://127.0.0.1:54323}"
echo "   Demo accounts: see the sign-in page. Password: OpenBench@2026"
echo
npx expo start --web
