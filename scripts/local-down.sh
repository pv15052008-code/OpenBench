#!/usr/bin/env bash
# Stop OpenBench's local services and free the memory Docker was using. Your data is kept.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 24 >/dev/null 2>&1 || true; fi
pkill -f "uvicorn app.main:app" 2>/dev/null && echo "API stopped" || true
npx --prefix scripts supabase stop --workdir . && echo "Supabase stopped (data kept; 'supabase stop --no-backup' would wipe it)"
