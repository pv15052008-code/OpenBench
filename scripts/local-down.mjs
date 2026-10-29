#!/usr/bin/env node
/**
 * Stop OpenBench services: the engine API and local Supabase.
 *
 *   node scripts/local-down.mjs
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const isWin = process.platform === "win32";

console.log("Stopping the engine API…");
if (isWin) {
  spawnSync("powershell", ["-Command", "Get-Process -Name python,python3 -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*uvicorn*' } | Stop-Process -Force"], { shell: true });
} else {
  spawnSync("pkill", ["-f", "uvicorn app.main:app"]);
}

console.log("Stopping Supabase…");
const npx = isWin ? "npx.cmd" : "npx";
spawnSync(npx, ["supabase", "stop", "--workdir", "."], { cwd: ROOT, stdio: "inherit", shell: isWin });

console.log("\nDone. (Press Ctrl+C in any terminal running Expo to stop the web app.)");
