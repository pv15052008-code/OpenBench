/**
 * Creates the fictional demo accounts and campus in a Supabase project.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed
 *
 * 1. Creates each demo account through the admin API (email pre-confirmed, shared demo password).
 * 2. Marks the project as a demo (app_settings.demo_mode) and calls seed_demo(), which rebuilds
 *    departments, courses, training tags, resources, bookings and history. Never run this on real data.
 * 3. Uploads a small placeholder image for every photo path the seed refers to,
 *    so condition records and certificates show a picture instead of "missing".
 * Safe to run again: existing accounts are reused, data is rebuilt.
 */
import { createClient } from "@supabase/supabase-js";
import { deflateSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let url = process.env.SUPABASE_URL;
let key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  const envPath = resolve(__dirname, "../services/api/.env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const k = match[1].trim();
        const v = match[2].trim();
        if (k === "SUPABASE_URL" && !url) url = v;
        if (k === "SUPABASE_SERVICE_ROLE_KEY" && !key) key = v;
      }
    }
  }
}

const password = process.env.DEMO_PASSWORD ?? "OpenBench@2026";
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role, from Project Settings > API).");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const ACCOUNTS = [
  ["admin@demo.openbench.in", "Dr. Neha Iyer"],
  ["hod.sharma@demo.openbench.in", "Prof. R. Sharma"],
  ["prof.mehta@demo.openbench.in", "Prof. Vikram Mehta"],
  ["dr.rao@demo.openbench.in", "Dr. Anjali Rao"],
  ["ms.kapoor@demo.openbench.in", "Ms. Tara Kapoor"],
  ["aarav@demo.openbench.in", "Aarav Singh"],
  ["isha@demo.openbench.in", "Isha Verma"],
  ["kabir@demo.openbench.in", "Kabir Nair"],
  ["newstudent@demo.openbench.in", "Riya Das"],
];

// A plain PNG with a coloured band, so placeholder photos look intentional rather than broken
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const band = y > h * 0.7 ? 0.55 : 1;
      row[1 + x * 3] = r * band; row[2 + x * 3] = g * band; row[3 + x * 3] = b * band;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  // 1. Accounts
  const { data: list, error: listErr } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  for (const [email, full_name] of ACCOUNTS) {
    const found = list.users.find((u) => u.email?.toLowerCase() === email);
    if (found) {
      await db.auth.admin.updateUserById(found.id, { password, email_confirm: true });
      console.log(`  kept    ${email}`);
    } else {
      const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name } });
      if (error) throw new Error(`${email}: ${error.message}`);
      console.log(`  created ${email}`);
    }
  }

  // 2. Campus data. seed_demo() wipes and rebuilds, so it only runs once the project is marked as a demo.
  // storage_base: listing photos are only accepted from this project's own storage
  const { error: modeErr } = await db.from("app_settings").update({ demo_mode: true, storage_base: url.replace(/\/$/, "") }).eq("id", true);
  if (modeErr) throw modeErr;
  const { data: seeded, error: seedErr } = await db.rpc("seed_demo");
  if (seedErr) throw seedErr;
  console.log("seeded:", seeded);

  // 3. Placeholder photos for every seeded path
  const uploads = [];
  const { data: recs } = await db.from("condition_records").select("photo_paths");
  for (const r of recs ?? []) for (const p of r.photo_paths) uploads.push(["condition-photos", p, [70, 130, 150]]);
  const { data: incs } = await db.from("incidents").select("photo_paths");
  for (const r of incs ?? []) for (const p of r.photo_paths) uploads.push(["incident-photos", p, [190, 90, 70]]);
  const { data: quals } = await db.from("user_qualifications").select("evidence_path");
  for (const q of quals ?? []) if (q.evidence_path) uploads.push(["eligibility-docs", q.evidence_path, [225, 215, 175]]);
  for (const [bucket, path, color] of uploads) {
    const { error } = await db.storage.from(bucket).upload(path, png(480, 360, color), { contentType: "image/png", upsert: true });
    if (error) console.warn(`  photo ${bucket}/${path}: ${error.message}`);
  }
  console.log(`uploaded ${uploads.length} placeholder photos`);
  console.log(`\nDone. Every demo account uses the password: ${password}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
