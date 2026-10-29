#!/usr/bin/env node
/**
 * Run OpenBench locally: Supabase in Docker, Python FastAPI engine, and Expo web app.
 * Works on Windows, macOS, and Linux.
 *
 *   node scripts/local-up.mjs
 *   node scripts/local-up.mjs --seed
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const isWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")} (exit code ${res.status})`);
  }
  return res;
}

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf-8", shell: isWin, ...opts });
  return res.stdout || "";
}

console.log(`Node ${process.version}`);

// Verify Docker is running
try {
  const d = spawnSync("docker", ["info"], { shell: isWin });
  if (d.status !== 0) throw new Error();
} catch {
  console.error("Docker isn't running. Open Docker Desktop, wait for it to start, then run this again.");
  process.exit(1);
}

// 1. Supabase
console.log("1/5 Starting Supabase (database, login, storage)…");
if (!existsSync(join(ROOT, "scripts", "node_modules"))) {
  run("npm", ["install", "--silent"], { cwd: join(ROOT, "scripts") });
}
const npx = isWin ? "npx.cmd" : "npx";
spawnSync(npx, ["supabase", "start", "--workdir", "."], { cwd: ROOT, stdio: "inherit", shell: isWin });

const statusOut = runCapture(npx, ["supabase", "status", "-o", "env", "--workdir", "."], { cwd: ROOT });
let API_URL = "http://127.0.0.1:54321";
let ANON_KEY = "";
let SERVICE_ROLE_KEY = "";
let STUDIO_URL = "http://127.0.0.1:54323";

for (const line of statusOut.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) {
    const [, k, v] = m;
    if (k === "API_URL") API_URL = v;
    if (k === "ANON_KEY" || k === "PUBLISHABLE_KEY") ANON_KEY = v;
    if (k === "SERVICE_ROLE_KEY" || k === "SECRET_KEY") SERVICE_ROLE_KEY = v;
    if (k === "STUDIO_URL") STUDIO_URL = v;
  }
}

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error("Couldn't read the local Supabase keys from 'supabase status'.");
  process.exit(1);
}

// 2. Local settings (.env)
console.log("2/5 Writing local settings…");
const mobileEnv = `EXPO_PUBLIC_SUPABASE_URL=${API_URL}\nEXPO_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}\nEXPO_PUBLIC_API_URL=http://localhost:8000\n`;
writeFileSync(join(ROOT, "apps", "mobile", ".env"), mobileEnv, "utf-8");

const cronSecret = randomBytes(16).toString("hex");
const apiEnv = `SUPABASE_URL=${API_URL}\nSUPABASE_ANON_KEY=${ANON_KEY}\nSUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}\nCRON_SECRET=${cronSecret}\nAPP_URL=http://localhost:8081\nALLOWED_ORIGINS=http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006\nGEMINI_API_KEY=\n`;
writeFileSync(join(ROOT, "services", "api", ".env"), apiEnv, "utf-8");

// 3. Demo data
console.log("3/5 Demo data…");
const seededFlag = join(ROOT, "supabase", ".temp", "openbench-seeded");
const forceSeed = process.argv.includes("--seed");

if (forceSeed || !existsSync(seededFlag)) {
  run("node", ["scripts/seed-demo.mjs"], {
    cwd: ROOT,
    env: { ...process.env, SUPABASE_URL: API_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY },
  });
  mkdirSync(join(ROOT, "supabase", ".temp"), { recursive: true });
  writeFileSync(seededFlag, new Date().toISOString(), "utf-8");
} else {
  console.log("   already there (use --seed to rebuild)");
}

// 4. Engine API
console.log("4/5 Starting the engine API on http://localhost:8000 …");
const venvDir = join(ROOT, "services", "api", ".venv");
const pythonBin = isWin ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
const pipBin = isWin ? join(venvDir, "Scripts", "pip.exe") : join(venvDir, "bin", "pip");

if (!existsSync(venvDir)) {
  const pyCmd = isWin ? "python" : "python3";
  run(pyCmd, ["-m", "venv", ".venv"], { cwd: join(ROOT, "services", "api") });
  run(pipBin, ["install", "-q", "-r", "requirements.txt"], { cwd: join(ROOT, "services", "api") });
}

// Stop existing uvicorn if any
if (isWin) {
  spawnSync("powershell", ["-Command", "Get-Process -Name python,python3 -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*uvicorn*' } | Stop-Process -Force"], { shell: true });
} else {
  spawnSync("pkill", ["-f", "uvicorn app.main:app"]);
}

const apiLog = openSync(join(ROOT, "services", "api", "api.log"), "a");
const apiProc = spawn(pythonBin, ["-m", "uvicorn", "app.main:app", "--port", "8000"], {
  cwd: join(ROOT, "services", "api"),
  detached: true,
  stdio: ["ignore", apiLog, apiLog],
  shell: isWin,
});
apiProc.unref();

// Poll API health
async function checkHealth() {
  for (let i = 0; i < 20; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get("http://localhost:8000/health", (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const apiHealthy = await checkHealth();
if (apiHealthy) {
  console.log("   API is up");
} else {
  console.log("   API didn't start; see services/api/api.log");
}

// 5. App
console.log("5/5 Starting the app…");
if (!existsSync(join(ROOT, "apps", "mobile", "node_modules"))) {
  run("npm", ["install"], { cwd: join(ROOT, "apps", "mobile") });
}

console.log("\n   Web: open http://localhost:8081");
console.log(`   Database admin (Supabase Studio): ${STUDIO_URL}`);
console.log("   Demo accounts: see the sign-in page. Password: OpenBench@2026\n");

// Keep Expo running in foreground
spawnSync(npx, ["expo", "start", "--web"], { cwd: join(ROOT, "apps", "mobile"), stdio: "inherit", shell: isWin });
