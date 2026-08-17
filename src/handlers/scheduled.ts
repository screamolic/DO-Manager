/**
 * Scheduled (Cron) handlers for DO Manager.
 *
 * Routes by cron expression to the appropriate sync/check/cleanup tasks:
 *   every 5 min  → action sync + alert checks
 *   every 15 min → server list sync  (paginated)
 *   every 30 min → balance sync + credential exhaust probe
 *   midnight     → data retention + D1 backup placeholder
 */

import { decryptTokenWithFallback } from "../lib/crypto";
import { parseDOError } from "../lib/do-api";
import { sendTelegram } from "../lib/notifications";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface Env {
  DB: D1Database;
  BACKUP_BUCKET: R2Bucket;
  ENCRYPTION_KEY_V1?: string;
  ENCRYPTION_KEY_V2?: string;
  TEAM_DOMAIN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

interface ActionRow {
  id: number;
  server_id: number;
  do_action_id: string;
  type: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  /** joined from servers */
  provider_account_id?: number;
  external_id?: number;
}

interface CredentialRow {
  id: number;
  token_encrypted: string;
  token_iv: string;
  key_version: number;
  requests_remaining: number | null;
  window_reset_at: number | null;
}

interface ProviderAccountRow {
  id: number;
  provider_id: string;
  credential_id: number | null;
  team_name: string;
  account_balance_usd: number | null;
  month_to_date_usage_usd: number | null;
  balance_synced_at: string | null;
}

interface ServerDroplet {
  id: number;
  name: string;
  region?: { slug?: string };
  size_slug?: string;
  vcpus?: number;
  memory?: number;
  disk?: number;
  networks?: { v4?: Array<{ ip_address?: string; type?: string }> };
  tags?: string[];
  status?: string;
}

interface DOActionsResponse {
  action?: { status?: string; completed_at?: string | null };
}

interface DODropletsPage {
  droplets: ServerDroplet[];
  links?: { pages?: { next?: string | null; last?: string | null } };
}

interface DOBalanceResponse {
  account_balance?: string;
  month_to_date_usage?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const DO_API_BASE = "https://api.digitalocean.com/v2";

/** Action types that indicate a server being powered off. */
const POWER_OFF_TYPES = new Set(["power_off", "shutdown", "power_cycle"]);

/** Per-page limit for DO API paginated endpoints. */
const DO_PAGE_LIMIT = 200;

/* ------------------------------------------------------------------ */
/*  Dup check helper                                                  */
/* ------------------------------------------------------------------ */

/**
 * Returns true if a matching non-pending alert was already inserted
 * within the last 60 minutes.
 */
async function isDuplicateAlert(
  db: D1Database,
  ruleType: string,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM alerts_log
       WHERE rule_type = ?
         AND target_type = ?
         AND target_id = ?
         AND sent_at > datetime('now', '-60 minutes')
         AND status IN ('sent', 'pending')`,
    )
    .bind(ruleType, targetType, targetId)
    .first<{ id: number }>();
  return row !== null;
}

/* ------------------------------------------------------------------ */
/*  Credential resolver                                                */
/* ------------------------------------------------------------------ */

/**
 * Walk the join chain: action / server → provider_account → credential
 * → decrypt token.  Returns null if any link is missing.
 */
async function resolveCredentialForServer(
  db: D1Database,
  providerAccountId: number,
  env: Env,
): Promise<{ credentialId: number; token: string } | null> {
  const account = await db
    .prepare("SELECT credential_id FROM provider_accounts WHERE id = ?")
    .bind(providerAccountId)
    .first<{ credential_id: number | null }>();

  if (!account || !account.credential_id) return null;

  const credential = await db
    .prepare(
      "SELECT id, token_encrypted, token_iv, key_version FROM api_credentials WHERE id = ?",
    )
    .bind(account.credential_id)
    .first<CredentialRow>();

  if (!credential) return null;

  const token = await decryptTokenWithFallback(
    credential.token_encrypted,
    credential.token_iv,
    credential.key_version as 1 | 2,
    env,
  );

  return { credentialId: credential.id, token };
}

/* ================================================================== */
/*  (1) Action sync — every 5 minutes                                 */
/* ================================================================== */

async function handleActionsSync(env: Env): Promise<void> {
  const db = env.DB;

  /* ---- fetch all in-progress actions with server info ---- */
  const { results: actions } = await db
    .prepare(
      `SELECT da.*, s.provider_account_id, s.external_id
       FROM do_actions da
       JOIN servers s ON s.id = da.server_id
       WHERE da.status = 'in-progress'`,
    )
    .all<ActionRow>();

  for (const action of actions) {
    /* resolve credential */
    if (!action.provider_account_id) continue;

    const resolved = await resolveCredentialForServer(
      db,
      action.provider_account_id,
      env,
    );
    if (!resolved) continue;

    /* call DO API */
    let response: Response;
    try {
      response = await fetch(
        `${DO_API_BASE}/actions/${action.do_action_id}`,
        { headers: { Authorization: `Bearer ${resolved.token}` } },
      );
    } catch {
      console.error(`Network error checking action ${action.do_action_id}`);
      continue;
    }

    if (!response.ok) {
      const errMsg = await parseDOError(response);
      console.error(`DO API error for action ${action.do_action_id}: ${errMsg}`);

      /* on 404 the action may have been purged — mark errored */
      if (response.status === 404) {
        await db
          .prepare(
            "UPDATE do_actions SET status = 'errored', completed_at = datetime('now') WHERE id = ?",
          )
          .bind(action.id)
          .run();
      }
      continue;
    }

    const data = (await response.json()) as DOActionsResponse;
    const doStatus = data.action?.status;

    if (!doStatus || doStatus === action.status) continue;

    /* status changed — update DB */
    await db
      .prepare(
        "UPDATE do_actions SET status = ?, completed_at = datetime('now') WHERE id = ?",
      )
      .bind(doStatus, action.id)
      .run();

    /* detect power-off → server_down alert */
    if (
      doStatus === "completed" &&
      POWER_OFF_TYPES.has(action.type) &&
      action.external_id != null
    ) {
      const dup = await isDuplicateAlert(
        db,
        "server_down",
        "server",
        String(action.server_id),
      );
      if (!dup) {
        await db
          .prepare(
            `INSERT INTO alerts_log (rule_type, target_type, target_id, message, status, sent_at)
             VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
          )
          .bind(
            "server_down",
            "server",
            String(action.server_id),
            `Server #${action.external_id} powered off (action: ${action.type})`,
          )
          .run();
      }
    }
  }
}

/* ================================================================== */
/*  (2) Server list sync (paginated) — every 15 minutes               */
/* ================================================================== */

async function handleServerListSync(env: Env): Promise<void> {
  const db = env.DB;

  /* ---- get all provider accounts ---- */
  const { results: accounts } = await db
    .prepare(
      "SELECT pa.*, ac.token_encrypted, ac.token_iv, ac.key_version FROM provider_accounts pa JOIN api_credentials ac ON ac.id = pa.credential_id",
    )
    .all<ProviderAccountRow & { token_encrypted: string; token_iv: string; key_version: number }>();

  for (const account of accounts) {
    if (!account.credential_id) continue;

    /* decrypt token */
    let token: string;
    try {
      token = await decryptTokenWithFallback(
        account.token_encrypted,
        account.token_iv,
        account.key_version as 1 | 2,
        env,
      );
    } catch (err) {
      console.error(
        `Failed to decrypt token for account ${account.id}: ${(err as Error).message}`,
      );
      continue;
    }

    /* ---- paginated DO API call ---- */
    const seenExternalIds: number[] = [];
    let nextUrl: string | null = `${DO_API_BASE}/droplets?per_page=${DO_PAGE_LIMIT}&page=1`;

    while (nextUrl) {
      let response: Response;
      try {
        response = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        console.error(`Network error during server list sync for account ${account.id}`);
        break;
      }

      if (!response.ok) {
        const errMsg = await parseDOError(response);
        console.error(`DO API error during server list sync: ${errMsg}`);

        /* on 401 skip this account entirely */
        if (response.status === 401) break;
        /* on rate limit wait briefly and continue */
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }

      const page = (await response.json()) as DODropletsPage;

      for (const droplet of page.droplets) {
        seenExternalIds.push(droplet.id);

        const ipAddress =
          droplet.networks?.v4?.find((n) => n.type === "public")?.ip_address ??
          null;

        await db
          .prepare(
            `INSERT INTO servers
               (provider_account_id, external_id, name, region, size_slug,
                ip_address, status, tags_json, network_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(provider_account_id, external_id)
             DO UPDATE SET
               name             = excluded.name,
               region           = excluded.region,
               size_slug        = excluded.size_slug,
               ip_address       = excluded.ip_address,
               status           = excluded.status,
               tags_json        = excluded.tags_json,
               network_json     = excluded.network_json`,
          )
          .bind(
            account.id,
            droplet.id,
            droplet.name,
            droplet.region?.slug ?? null,
            droplet.size_slug ?? null,
            ipAddress,
            droplet.status ?? "unknown",
            droplet.tags ? JSON.stringify(droplet.tags) : "[]",
            droplet.networks ? JSON.stringify(droplet.networks) : null,
          )
          .run();
      }

      /* advance pagination */
      nextUrl = page.links?.pages?.next ?? null;
    }

    /* ---- archive servers not in DO response ---- */
    if (seenExternalIds.length > 0) {
      const placeholders = seenExternalIds.map(() => "?").join(",");
      await db
        .prepare(
          `UPDATE servers SET status = 'archived'
           WHERE provider_account_id = ?
             AND external_id NOT IN (${placeholders})
             AND status NOT IN ('archived')`,
        )
        .bind(account.id, ...seenExternalIds)
        .run();
    }
  }
}

/* ================================================================== */
/*  (3) Balance sync — every 30 minutes                                */
/* ================================================================== */

async function handleBalanceSync(env: Env): Promise<void> {
  const db = env.DB;

  const { results: accounts } = await db
    .prepare(
      `SELECT pa.*, ac.token_encrypted, ac.token_iv, ac.key_version
       FROM provider_accounts pa
       JOIN api_credentials ac ON ac.id = pa.credential_id
       WHERE pa.credential_id IS NOT NULL`,
    )
    .all<ProviderAccountRow & { token_encrypted: string; token_iv: string; key_version: number }>();

  for (const account of accounts) {
    /* decrypt token */
    let token: string;
    try {
      token = await decryptTokenWithFallback(
        account.token_encrypted,
        account.token_iv,
        account.key_version as 1 | 2,
        env,
      );
    } catch (err) {
      console.error(
        `Balance sync — decrypt failed for account ${account.id}: ${(err as Error).message}`,
      );
      continue;
    }

    /* call DO Balance API */
    let response: Response;
    try {
      response = await fetch(`${DO_API_BASE}/customers/my/balance`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      console.error(`Balance sync — network error for account ${account.id}`);
      continue;
    }

    if (!response.ok) {
      /* 401 → credential is bad; log and continue to next account */
      if (response.status === 401) {
        console.error(`Balance sync — 401 for account ${account.id}, skipping`);
        continue;
      }
      const errMsg = await parseDOError(response);
      console.error(
        `Balance sync — DO API error for account ${account.id}: ${errMsg}`,
      );
      continue;
    }

    const data = (await response.json()) as DOBalanceResponse;

    const accountBalance = data.account_balance
      ? parseFloat(data.account_balance)
      : null;
    const monthToDateUsage = data.month_to_date_usage
      ? parseFloat(data.month_to_date_usage)
      : null;

    await db
      .prepare(
        `UPDATE provider_accounts
         SET account_balance_usd = ?,
             month_to_date_usage_usd = ?,
             balance_synced_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(accountBalance, monthToDateUsage, account.id)
      .run();
  }
}

/* ================================================================== */
/*  (4) Data retention — every 24h @ midnight                         */
/* ================================================================== */

async function handleDataRetention(env: Env): Promise<void> {
  const db = env.DB;

  await db
    .prepare(
      "DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')",
    )
    .run();

  await db
    .prepare(
      "DELETE FROM rate_limit_events WHERE hit_at < datetime('now', '-30 days')",
    )
    .run();
}

/* ================================================================== */
/*  (5) Alert checks — every 5 minutes                                */
/* ================================================================== */

async function handleAlertChecks(env: Env): Promise<void> {
  const db = env.DB;

  /* ---- (a) server_down ---- */
  await checkServerDown(db, env);

  /* ---- (b) token_throttled ---- */
  await checkTokenThrottled(db, env);

  /* ---- (c) job_failed ---- */
  await checkJobFailed(db, env);

  /* ---- (d) balance_low ---- */
  await checkBalanceLow(db, env);

  /* ---- (e) dlq_stuck ---- */
  await checkDlqStuck(db, env);
}

/* ------------------------------------------------------------------ */
/*  (5a) server_down                                                  */
/* ------------------------------------------------------------------ */

async function checkServerDown(db: D1Database, env: Env): Promise<void> {
  const { results: completedActions } = await db
    .prepare(
      `SELECT da.*, s.provider_account_id, s.external_id
       FROM do_actions da
       JOIN servers s ON s.id = da.server_id
       WHERE da.status = 'completed'
         AND da.completed_at > datetime('now', '-5 minutes')`,
    )
    .all<ActionRow>();

  for (const action of completedActions) {
    if (!POWER_OFF_TYPES.has(action.type)) continue;
    if (action.external_id == null) continue;

    const dup = await isDuplicateAlert(
      db,
      "server_down",
      "server",
      String(action.server_id),
    );
    if (dup) continue;

    const { meta } = await db
      .prepare(
        `INSERT INTO alerts_log (rule_type, target_type, target_id, message, status, sent_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .bind(
        "server_down",
        "server",
        String(action.server_id),
        `Server #${action.external_id} is down (action: ${action.type})`,
      )
      .run();

    try {
      const telegramResult = await sendTelegram(
        `⚠ Server #${action.external_id} (${action.type}) is down`,
        env,
      );
      await db
        .prepare("UPDATE alerts_log SET status = ?, sent_at = datetime('now') WHERE id = ?")
        .bind(telegramResult.ok ? "sent" : "failed", meta.last_row_id)
        .run();
    } catch {
      await db
        .prepare("UPDATE alerts_log SET status = 'failed', sent_at = datetime('now') WHERE id = ?")
        .bind(meta.last_row_id)
        .run();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  (5b) token_throttled                                              */
/* ------------------------------------------------------------------ */

async function checkTokenThrottled(db: D1Database, env: Env): Promise<void> {
  const { results: throttled } = await db
    .prepare(
      `SELECT credential_id, COUNT(*) AS cnt
       FROM rate_limit_events
       WHERE hit_at > datetime('now', '-10 minutes')
       GROUP BY credential_id
       HAVING cnt >= 3`,
    )
    .all<{ credential_id: number; cnt: number }>();

  for (const row of throttled) {
    const dup = await isDuplicateAlert(
      db,
      "token_throttled",
      "credential",
      String(row.credential_id),
    );
    if (dup) continue;

    const { meta } = await db
      .prepare(
        `INSERT INTO alerts_log (rule_type, target_type, target_id, message, status, sent_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .bind(
        "token_throttled",
        "credential",
        String(row.credential_id),
        `Credential #${row.credential_id} hit ${row.cnt} rate limits in 10 minutes`,
      )
      .run();

    try {
      const telegramResult = await sendTelegram(
        `⚠ Token #${row.credential_id} hit ${row.cnt} rate limits in 10 minutes`,
        env,
      );
      await db
        .prepare("UPDATE alerts_log SET status = ?, sent_at = datetime('now') WHERE id = ?")
        .bind(telegramResult.ok ? "sent" : "failed", meta.last_row_id)
        .run();
    } catch {
      await db
        .prepare("UPDATE alerts_log SET status = 'failed', sent_at = datetime('now') WHERE id = ?")
        .bind(meta.last_row_id)
        .run();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  (5c) job_failed                                                   */
/* ------------------------------------------------------------------ */

async function checkJobFailed(db: D1Database, env: Env): Promise<void> {
  const { results: failedJobs } = await db
    .prepare(
      "SELECT * FROM job_queue WHERE status = 'failed' AND attempts >= 3",
    )
    .all<{ id: number; type: string; error_log: string | null; provider_account_id: number | null }>();

  for (const job of failedJobs) {
    const dup = await isDuplicateAlert(
      db,
      "job_failed",
      "job_queue",
      String(job.id),
    );
    if (dup) continue;

    const { meta } = await db
      .prepare(
        `INSERT INTO alerts_log (rule_type, target_type, target_id, message, status, sent_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .bind(
        "job_failed",
        "job_queue",
        String(job.id),
        `Job #${job.id} (${job.type}) failed: ${job.error_log ?? "unknown error"}`,
      )
      .run();

    try {
      const telegramResult = await sendTelegram(
        `❌ Job #${job.id} (${job.type}) failed: ${job.error_log ?? "unknown error"}`,
        env,
      );
      await db
        .prepare("UPDATE alerts_log SET status = ?, sent_at = datetime('now') WHERE id = ?")
        .bind(telegramResult.ok ? "sent" : "failed", meta.last_row_id)
        .run();
    } catch {
      await db
        .prepare("UPDATE alerts_log SET status = 'failed', sent_at = datetime('now') WHERE id = ?")
        .bind(meta.last_row_id)
        .run();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  (5d) balance_low                                                  */
/* ------------------------------------------------------------------ */

async function checkBalanceLow(db: D1Database, env: Env): Promise<void> {
  const { results: lowAccounts } = await db
    .prepare(
      `SELECT id, team_name, account_balance_usd
       FROM provider_accounts
       WHERE account_balance_usd < 15`,
    )
    .all<{ id: number; team_name: string; account_balance_usd: number | null }>();

  for (const account of lowAccounts) {
    const dup = await isDuplicateAlert(
      db,
      "balance_low",
      "provider_account",
      String(account.id),
    );
    if (dup) continue;

    const { meta } = await db
      .prepare(
        `INSERT INTO alerts_log (rule_type, target_type, target_id, message, status, sent_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .bind(
        "balance_low",
        "provider_account",
        String(account.id),
        `Account "${account.team_name}" balance is $${account.account_balance_usd?.toFixed(2) ?? "unknown"}`,
      )
      .run();

    try {
      const telegramResult = await sendTelegram(
        `💰 Account "${account.team_name}" balance is $${account.account_balance_usd?.toFixed(2) ?? "unknown"}`,
        env,
      );
      await db
        .prepare("UPDATE alerts_log SET status = ?, sent_at = datetime('now') WHERE id = ?")
        .bind(telegramResult.ok ? "sent" : "failed", meta.last_row_id)
        .run();
    } catch {
      await db
        .prepare("UPDATE alerts_log SET status = 'failed', sent_at = datetime('now') WHERE id = ?")
        .bind(meta.last_row_id)
        .run();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  (5e) dlq_stuck                                                    */
/* ------------------------------------------------------------------ */

async function checkDlqStuck(db: D1Database, env: Env): Promise<void> {
  const { results: pendingDlq } = await db
    .prepare(
      `SELECT * FROM alerts_log
       WHERE rule_type = 'dlq_stuck'
         AND status = 'pending'`,
    )
    .all<{ id: number; target_id: string; message: string }>();

  for (const alert of pendingDlq) {
    try {
      const telegramResult = await sendTelegram(
        `⚠ Job #${alert.target_id} stuck in DLQ permanently — check /jobs`,
        env,
      );
      await db
        .prepare("UPDATE alerts_log SET status = ?, sent_at = datetime('now') WHERE id = ?")
        .bind(telegramResult.ok ? "sent" : "failed", alert.id)
        .run();
    } catch {
      await db
        .prepare("UPDATE alerts_log SET status = 'failed', sent_at = datetime('now') WHERE id = ?")
        .bind(alert.id)
        .run();
    }
  }
}

/* ================================================================== */
/*  (5b) Credential exhaust probe — every 30 minutes                  */
/* ================================================================== */

async function handleCredentialExhaustProbe(env: Env): Promise<void> {
  const db = env.DB;

  const { results: exhaustedCreds } = await db
    .prepare(
      `SELECT * FROM api_credentials
       WHERE requests_remaining = 0
         AND (window_reset_at IS NULL
           OR window_reset_at < CAST(strftime('%s', 'now') AS INTEGER))
         AND status = 'active'`,
    )
    .all<CredentialRow>();

  for (const cred of exhaustedCreds) {
    /* decrypt token */
    let token: string;
    try {
      token = await decryptTokenWithFallback(
        cred.token_encrypted,
        cred.token_iv,
        cred.key_version as 1 | 2,
        env,
      );
    } catch (err) {
      console.error(
        `Exhaust probe — decrypt failed for credential ${cred.id}: ${(err as Error).message}`,
      );
      continue;
    }

    /* call DO Account API to refresh rate limit headers */
    let response: Response;
    try {
      response = await fetch(`${DO_API_BASE}/account`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      console.error(`Exhaust probe — network error for credential ${cred.id}`);
      continue;
    }

    if (response.status === 401) {
      /* token is invalid */
      await db
        .prepare(
          "UPDATE api_credentials SET status = 'error' WHERE id = ?",
        )
        .bind(cred.id)
        .run();
      continue;
    }

    if (!response.ok) {
      console.error(
        `Exhaust probe — DO API error for credential ${cred.id}: ${await parseDOError(response)}`,
      );
      continue;
    }

    /* parse rate limit headers (case-insensitive) */
    let remaining: number | null = null;
    let reset: number | null = null;
    response.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (lk === "ratelimit-remaining") remaining = parseInt(value, 10);
      if (lk === "ratelimit-reset") reset = parseInt(value, 10);
    });

    await db
      .prepare(
        "UPDATE api_credentials SET requests_remaining = ?, window_reset_at = ? WHERE id = ?",
      )
      .bind(remaining, reset, cred.id)
      .run();

    /* also update last_used_at since we made a successful call */
    await db
      .prepare("UPDATE api_credentials SET last_used_at = datetime('now') WHERE id = ?")
      .bind(cred.id)
      .run();
  }
}

/* ================================================================== */
/*  D1 backup to R2 — every 24h                                      */
/* ================================================================== */

/**
 * Dump all user tables to a SQL file and upload to R2.
 *
 * 1. Enumerate user tables via sqlite_master
 * 2. For each table, capture its CREATE TABLE statement
 * 3. For each table, SELECT * and emit INSERT statements
 * 4. Upload the resulting .sql file to `backup-YYYY-MM-DD.sql`
 * 5. Prune objects older than 90 days
 */
async function handleD1Backup(env: Env): Promise<void> {
  const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // 1. Get all user tables
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all<{ name: string }>();

  if (!tables.success || !tables.results.length) return;

  let sql = `-- DO Manager D1 Backup\n-- Generated: ${new Date().toISOString()}\n\nPRAGMA foreign_keys = ON;\n\n`;

  for (const { name } of tables.results) {
    // Get CREATE TABLE statement
    const schema = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`,
    ).bind(name).first<{ sql: string | null }>();

    if (schema?.sql) {
      sql += schema.sql + ";\n\n";
    }

    // Get all rows
    const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();

    if (rows.results && rows.results.length > 0) {
      const columns = Object.keys(rows.results[0]);
      const colList = columns.map((c) => `"${c}"`).join(", ");

      for (const row of rows.results) {
        const values = columns.map((col) => {
          const val = (row as Record<string, unknown>)[col];
          if (val === null || val === undefined) return "NULL";
          if (typeof val === "number") return String(val);
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        sql += `INSERT INTO "${name}" (${colList}) VALUES (${values.join(", ")});\n`;
      }
      sql += "\n";
    }
  }

  // 3. Upload to R2
  const key = `backup-${dateStr}.sql`;
  await env.BACKUP_BUCKET.put(key, sql, {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { generatedAt: new Date().toISOString() },
  });

  // 4. Cleanup backups older than 90 days
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const listed = await env.BACKUP_BUCKET.list();

  for (const obj of listed.objects) {
    if (obj.uploaded && obj.uploaded.getTime() < cutoff) {
      await env.BACKUP_BUCKET.delete(obj.key);
    }
  }
}

/* ================================================================== */
/*  Public API                                                        */
/* ================================================================== */

/**
 * Route a cron trigger to the appropriate handler(s).
 *
 * Usage in index.ts:
 * ```
 * export default { fetch: app.fetch, scheduled: (controller, env) =>
 *   handleScheduled(controller.cron, env) };
 * ```
 */
export async function handleScheduled(cron: string, env: Env): Promise<void> {
  switch (cron) {
    case "*/5 * * * *":
      await handleActionsSync(env);
      await handleAlertChecks(env);
      break;

    case "*/15 * * * *":
      await handleServerListSync(env);
      break;

    case "*/30 * * * *":
      await handleBalanceSync(env);
      await handleCredentialExhaustProbe(env);
      break;

    case "0 0 * * *":
      await handleDataRetention(env);
      await handleD1Backup(env);
      break;

    default:
      console.warn(`Unknown cron expression: ${cron}`);
  }
}
