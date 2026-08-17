#!/usr/bin/env node
/**
 * deploy.mjs — full-automated DO-Manager deploy via wrangler.
 *
 * Pipeline:
 *   1. auth check          → wrangler whoami (fail-fast jika belum login)
 *   2. typecheck           → tsc --noEmit
 *   3. build frontend      → frontend/dist -> root/dist/client
 *   4. tests               → vitest run (bisa di-skip)
 *   5. ensure D1           → create jika belum ada + update database_id di wrangler.jsonc
 *   6. ensure R2 bucket    → create jika belum ada
 *   7. ensure Queues       → do-jobs, do-jobs-dlq (create jika belum ada)
 *   8. apply migrations    → wrangler d1 migrations apply --remote
 *   9. push secrets        → baca .dev.vars (atau --secrets-file), wrangler secret put
 *  10. deploy              → wrangler deploy
 *  11. smoke test          → GET https://<worker>.<account-id>.workers.dev/api/health
 *
 * Usage (dari root project):
 *   node scripts/deploy.mjs                 # full pipeline
 *   node scripts/deploy.mjs --skip-tests    # lewati vitest
 *   node scripts/deploy.mjs --skip-secrets  # lewati secret put
 *   node scripts/deploy.mjs --secrets-file .secrets.prod
 *   node scripts/deploy.mjs --dry-run       # print commands saja, tanpa eksekusi
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// Awali lewat `node <wrangler.js>` — spawn langsung .cmd gagal (EINVAL) di Windows.
const NODE = process.execPath;
const WRANGLER_JS = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const D1_NAME = "do-manager-db";
const R2_NAME = "do-manager-backups";
const QUEUE_NAMES = ["do-jobs", "do-jobs-dlq"];
const SECRET_KEYS = [
  "ENCRYPTION_KEY_V1",
  "ENCRYPTION_KEY_V2",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TEAM_DOMAIN",
];

/* ------------------------------------------------------------------ */
/*  Arg parsing                                                       */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flags = {
  skipTests: argv.includes("--skip-tests"),
  skipSecrets: argv.includes("--skip-secrets"),
  skipBuild: argv.includes("--skip-build"),
  skipMigrations: argv.includes("--skip-migrations"),
  dryRun: argv.includes("--dry-run"),
  help: argv.includes("--help") || argv.includes("-h"),
};
const secretsIdx = argv.indexOf("--secrets-file");
const secretsFile =
  secretsIdx >= 0
    ? path.resolve(ROOT, argv[secretsIdx + 1])
    : path.join(ROOT, ".dev.vars");

if (flags.help) {
  console.log(`
DO-Manager full-auto deploy

Usage: node scripts/deploy.mjs [options]

Options:
  --skip-tests        Jangan jalankan vitest
  --skip-secrets      Jangan push secrets ke Cloudflare
  --skip-build        Jangan build frontend (pakai dist/client yang ada)
  --skip-migrations   Jangan apply D1 migrations
  --secrets-file PATH Baca secrets dari file (default: .dev.vars)
  --dry-run           Tampilkan command tanpa mengeksekusi
  --help              Tampilkan bantuan ini
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function log(step, msg) {
  console.log(`${CYAN}${BOLD}▶ ${step}${RESET}  ${msg}`);
}
function info(msg) {
  console.log(`  ${msg}`);
}
function ok(msg) {
  console.log(`  ${GREEN}✓ ${msg}${RESET}`);
}
function warn(msg) {
  console.log(`  ${YELLOW}⚠ ${msg}${RESET}`);
}
function fail(msg) {
  console.error(`  ${RED}✘ ${msg}${RESET}`);
}

/** Jalankan command. return {status, stdout, stderr}. */
function run(cmd, args, opts = {}) {
  const display = `$ ${path.basename(cmd)} ${args.join(" ")}`;
  if (flags.dryRun) {
    info(`${YELLOW}[dry-run] ${display}${RESET}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    input: opts.input,
    encoding: "utf8",
    // .cmd/.bat di Windows perlu shell — Node tidak bisa spawn langsung.
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd),
    stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0 && !opts.ignoreError) {
    throw new Error(`Command failed (${res.status}): ${display}`);
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function wrangler(args, opts = {}) {
  return run(NODE, [WRANGLER_JS, ...args], opts);
}

/** Parse JSON output wrangler, toleran terhadap format {success,result} / raw. */
function wranglerJson(args) {
  const res = wrangler(args, { ignoreError: true, input: "" });
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return parsed.result;
    }
    return parsed;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Step 1 — Auth                                                      */
/* ------------------------------------------------------------------ */

function checkAuth() {
  if (flags.dryRun) {
    warn("dry-run: cek auth dilewati (return accountId null)");
    return null;
  }
  const res = wrangler(["whoami"], { ignoreError: true, input: "" });
  if (res.status !== 0 || !/Logged in/i.test(res.stdout)) {
    fail(
      "Wrangler belum terautentikasi. Jalankan dulu di terminal interaktif:",
    );
    fail("  npx wrangler login");
    fail("Atau set environment variable CLOUDFLARE_API_TOKEN.");
    process.exit(1);
  }
  // Ambil account id (32 hex chars) dari output whoami untuk smoke test.
  const m = res.stdout.match(/[0-9a-f]{32}/i);
  const accountId = m ? m[0] : null;
  ok("Wrangler terautentikasi" + (accountId ? ` (account ${accountId.slice(0, 8)}…)` : ""));
  return accountId;
}

/* ------------------------------------------------------------------ */
/*  Step 5 — D1 database                                               */
/* ------------------------------------------------------------------ */

function ensureD1() {
  log("check", "D1 database");
  const list = wranglerJson(["d1", "list", "--json"]);
  const exists = Array.isArray(list)
    ? list.find((d) => d?.name === D1_NAME)
    : undefined;

  if (exists) {
    ok(`D1 "${D1_NAME}" sudah ada (${exists.uuid ?? exists.id})`);
    return;
  }

  warn(`D1 "${D1_NAME}" belum ada — membuat baru…`);
  const created = wranglerJson(["d1", "create", D1_NAME, "--json"]);
  const uuid = created?.uuid ?? created?.id;
  if (!uuid) {
    if (flags.dryRun) {
      warn("dry-run: UUID tidak tersedia — langkah update config dilewati");
      return;
    }
    fail("Gagal mendapatkan UUID D1 dari output wrangler.");
    process.exit(1);
  }

  // Update database_id di wrangler.jsonc agar deploy memakai DB baru ini.
  const configPath = path.join(ROOT, "wrangler.jsonc");
  const config = readFileSync(configPath, "utf8");
  if (!config.includes(D1_NAME)) {
    fail(`wrangler.jsonc tidak berisi binding "${D1_NAME}" — cek manual.`);
    process.exit(1);
  }
  const updated = config.replace(
    /("database_id"\s*:\s*")[^"]*(")/,
    `$1${uuid}$2`,
  );
  if (updated !== config) {
    writeFileSync(configPath, updated);
    ok(`database_id di wrangler.jsonc diperbarui → ${uuid}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Step 6 — R2 bucket                                                 */
/* ------------------------------------------------------------------ */
// Catatan: `wrangler r2 bucket list` TIDAK mendukung `--json` — parse teks.

function ensureR2() {
  log("check", "R2 bucket");
  const res = wrangler(["r2", "bucket", "list"], { ignoreError: true, input: "" });
  const names = [...res.stdout.matchAll(/name:\s*(\S+)/g)].map((m) => m[1]);
  if (names.includes(R2_NAME)) {
    ok(`R2 "${R2_NAME}" sudah ada`);
    return;
  }
  warn(`R2 "${R2_NAME}" belum ada — membuat baru…`);
  const created = wrangler(["r2", "bucket", "create", R2_NAME], {
    ignoreError: true,
    input: "",
  });
  if (created.status === 0) {
    ok(`R2 "${R2_NAME}" dibuat`);
  } else {
    warn(`Gagal membuat R2 (${created.status}) — mungkin sudah ada di region lain`);
  }
}

/* ------------------------------------------------------------------ */
/*  Step 7 — Queues                                                    */
/* ------------------------------------------------------------------ */
// Catatan: `wrangler queues list` TIDAK mendukung `--json` — parse tabel teks.

function ensureQueues() {
  log("check", "Queues");
  const res = wrangler(["queues", "list"], { ignoreError: true, input: "" });
  // Baris tabel: │ <32hex-id> │ <name> │ ...
  const existing = new Set(
    [...res.stdout.matchAll(/│\s+[0-9a-f]{32}\s+│\s+([^\s│]+)/g)].map((m) => m[1]),
  );

  for (const name of QUEUE_NAMES) {
    if (existing.has(name)) {
      ok(`Queue "${name}" sudah ada`);
      continue;
    }
    warn(`Queue "${name}" belum ada — membuat baru…`);
    const created = wrangler(["queues", "create", name], {
      ignoreError: true,
      input: "",
    });
    if (created.status === 0) {
      ok(`Queue "${name}" dibuat`);
    } else {
      warn(
        `Gagal membuat queue "${name}" (${created.status}) — mungkin sudah terdaftar.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Step 8 — Migrations                                                */
/* ------------------------------------------------------------------ */

function applyMigrations() {
  log("migrate", `D1 migrations (${D1_NAME})`);
  wrangler(["d1", "migrations", "apply", D1_NAME, "--remote"]);
  ok("Migrations applied");
}

/* ------------------------------------------------------------------ */
/*  Step 9 — Secrets                                                   */
/* ------------------------------------------------------------------ */

function pushSecrets() {
  log("secret", `membaca ${path.basename(secretsFile)}`);
  if (!existsSync(secretsFile)) {
    warn(`File "${secretsFile}" tidak ada — pakai --secrets-file atau buat .dev.vars`);
    return;
  }

  const raw = readFileSync(secretsFile, "utf8");
  const vars = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) vars.set(key, value);
  }

  let pushed = 0;
  for (const key of SECRET_KEYS) {
    const value = vars.get(key);
    if (!value || /CHANGE_ME/i.test(value)) {
      warn(`Skips "${key}" (kosong atau placeholder)`);
      continue;
    }
    if (flags.dryRun) {
      info(`${YELLOW}[dry-run] wrangler secret put ${key}${RESET}`);
      pushed++;
      continue;
    }
    const res = wrangler(["secret", "put", key], {
      ignoreError: true,
      input: `${value}\n`,
    });
    if (res.status === 0) {
      ok(`Secret "${key}" tersimpan`);
      pushed++;
    } else {
      warn(`Gagal set secret "${key}" (${res.status})`);
    }
  }
  if (pushed === 0) {
    warn(
      "Tidak ada secret yang di-set. Deploy akan berjalan, tapi /api/* butuh TEAM_DOMAIN untuk auth.",
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Steps 2–4 — local checks                                           */
/* ------------------------------------------------------------------ */

function runLocalChecks() {
  log("typecheck", "tsc --noEmit");
  run(NPM, ["run", "typecheck"]);

  if (!flags.skipBuild) {
    log("build", "frontend → dist/client");
    run(NPM, ["run", "build"], { cwd: path.join(ROOT, "frontend") });
  } else {
    warn("--skip-build: memakai dist/client yang sudah ada");
  }

  if (!flags.skipTests) {
    log("test", "vitest run");
    run(NPM, ["run", "test"]);
  } else {
    warn("--skip-tests: vitest dilewati");
  }
}

/* ------------------------------------------------------------------ */
/*  Step 11 — Smoke test                                               */
/* ------------------------------------------------------------------ */

async function smokeTest(deployUrl) {
  log("smoke", "GET /api/health di workers.dev");
  if (!deployUrl) {
    warn("Deploy URL tidak ditemukan — smoke test dilewati");
    return deployUrl;
  }
  const url = `${deployUrl}/api/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    if (res.ok && body?.status === "ok") {
      ok(`Health OK — d1:${body.d1} (${url})`);
    } else {
      warn(`Health ${res.status}: ${JSON.stringify(body)}`);
    }
  } catch (err) {
    warn(`Smoke test gagal: ${err.message}`);
  }
  return deployUrl;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`${BOLD}━━ DO-Manager full-auto deploy ━━${RESET}\n`);
  if (flags.dryRun) console.log(`${YELLOW}• dry-run mode — tidak ada yang dieksekusi${RESET}\n`);

  const started = Date.now();

  const accountId = checkAuth();
  runLocalChecks();

  ensureD1();
  ensureR2();
  ensureQueues();

  if (!flags.skipMigrations) {
    applyMigrations();
  } else {
    warn("--skip-migrations: migrations dilewati");
  }

  if (!flags.skipSecrets) {
    pushSecrets();
  } else {
    warn("--skip-secrets: secrets dilewati");
  }

  log("deploy", "wrangler deploy");
  const deployRes = wrangler(["deploy"], { ignoreError: false, input: "" });
  // Tampilkan output deploy yang tertangkap (karena stdio di-pipe).
  if (deployRes.stdout?.trim()) process.stdout.write(deployRes.stdout + "\n");
  if (deployRes.stderr?.trim()) process.stderr.write(deployRes.stderr + "\n");
  // Ambil URL workers.dev dari output deploy (subdomain akun, bukan account-id).
  const combined = `${deployRes.stdout ?? ""}${deployRes.stderr ?? ""}`;
  const urlMatch = combined.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/);
  const deployUrl = urlMatch ? urlMatch[0] : null;
  if (deployUrl) ok(`Deployed at ${deployUrl}`);

  await smokeTest(deployUrl);

  console.log(`\n${GREEN}${BOLD}✔ Deploy selesai dalam ${((Date.now() - started) / 1000).toFixed(1)}s${RESET}`);
  console.log("  URL: " + (deployUrl ?? "https://do-manager.<subdomain>.workers.dev"));
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});