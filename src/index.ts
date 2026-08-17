/**
 * DO Manager — Hono REST API
 *
 * Multi-account DigitalOcean dashboard backend running on Cloudflare Workers.
 * Exposes 21 endpoints for managing servers, accounts, credentials, jobs, and notifications.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { validateAccessJWT } from "./lib/auth";
import { encryptToken, decryptTokenWithFallback } from "./lib/crypto";
import { parseDOError } from "./lib/do-api";
import { handleScheduled } from "./handlers/scheduled";
import { handleQueue, type JobMessage } from "./handlers/queue";
import { handleDLQ } from "./handlers/dlq-consumer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = {
  DB: D1Database;
  DO_JOBS_QUEUE: Queue;
  BACKUP_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  TEAM_DOMAIN?: string;
  ENCRYPTION_KEY_V1?: string;
  ENCRYPTION_KEY_V2?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
};

type Variables = {
  user: { email: string; sub: string };
};

type App = { Bindings: Env; Variables: Variables };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert an audit log row. */
async function insertAuditLog(
  db: D1Database,
  actor: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_log (actor, action, target_type, target_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    )
    .bind(actor, action, targetType, targetId, payload ? JSON.stringify(payload) : null)
    .run();
}

/** DO API helper — raw GET request with bearer token. */
async function doApiGet(path: string, token: string): Promise<Response> {
  return fetch(`https://api.digitalocean.com/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// JWT Middleware
// ---------------------------------------------------------------------------

/** Verifies CF-Access-Jwt-Assertion on all /api/* routes EXCEPT /api/health. */
async function jwtMiddleware(
  c: Context<App>,
  next: Next,
): Promise<Response | void> {
  if (c.req.path === "/api/health") {
    return next();
  }

  try {
    const user = await validateAccessJWT(c.req.raw, c.env as Env);
    c.set("user", user);
    await next();
  } catch (err) {
    const status: StatusCode =
      err && typeof err === "object" && "status" in err
        ? ((err as { status: number }).status as StatusCode)
        : 403;
    c.status(status);
    return c.json({ error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Hono App
// ---------------------------------------------------------------------------

const app = new Hono<App>();

// Apply JWT middleware to all API routes
app.use("/api/*", jwtMiddleware);

// ======================== HEALTH ========================

app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").run();
    return c.json({ status: "ok", d1: "connected", version: "1.0.0" });
  } catch (err) {
    return c.json({ status: "error", d1: "disconnected", version: "1.0.0" }, 500);
  }
});

// ======================== SERVERS ========================

app.get("/api/servers", async (c) => {
  try {
    const db = c.env.DB;
    const account = c.req.query("account");
    const region = c.req.query("region");
    const status = c.req.query("status");
    const search = c.req.query("search");

    let sql =
      "SELECT s.*, pa.team_name FROM servers s LEFT JOIN provider_accounts pa ON s.provider_account_id = pa.id WHERE 1=1";
    const binds: unknown[] = [];

    if (account) {
      sql += " AND s.provider_account_id = ?";
      binds.push(Number(account));
    }
    if (region) {
      sql += " AND s.region = ?";
      binds.push(region);
    }
    if (status) {
      sql += " AND s.status = ?";
      binds.push(status);
    }
    if (search) {
      sql += " AND s.name LIKE ?";
      binds.push(`%${search}%`);
    }

    sql += " ORDER BY s.created_at DESC";

    const { results } = await db.prepare(sql).bind(...binds).all();
    return c.json(results);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/servers/:id", async (c) => {
  try {
    const db = c.env.DB;
    const id = Number(c.req.param("id"));

    // Fetch server with team name
    const server = await db
      .prepare(
        "SELECT s.*, pa.team_name FROM servers s LEFT JOIN provider_accounts pa ON s.provider_account_id = pa.id WHERE s.id = ?",
      )
      .bind(id)
      .first();

    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    // Fetch last 10 actions
    const { results: actions } = await db
      .prepare("SELECT * FROM do_actions WHERE server_id = ? ORDER BY started_at DESC LIMIT 10")
      .bind(id)
      .all();

    // Check if password exists
    const passwordRow = await db
      .prepare("SELECT root_password_encrypted IS NOT NULL AS has_password FROM servers WHERE id = ?")
      .bind(id)
      .first<{ has_password: number }>();

    // Parse network_json
    const record = server as Record<string, unknown>;
    const result: Record<string, unknown> = { ...record };
    if (typeof record.network_json === "string") {
      try {
        result.network_json = JSON.parse(record.network_json);
      } catch {
        // keep raw string if parse fails
      }
    }
    result.do_actions = actions;
    result.has_password = passwordRow ? passwordRow.has_password === 1 : false;
    // Clean up root password fields from the output
    delete result.root_password_encrypted;
    delete result.root_password_iv;

    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/servers", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const body = await c.req.json<{
      account_id: number;
      name: string;
      region: string;
      size: string;
      image?: string;
      tags?: string[];
    }>();

    // Inline validation
    if (typeof body.account_id !== "number") return c.json({ error: "account_id is required and must be a number" }, 400);
    if (typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "name is required" }, 400);
    if (typeof body.region !== "string" || !body.region.trim()) return c.json({ error: "region is required" }, 400);
    if (typeof body.size !== "string" || !body.size.trim()) return c.json({ error: "size is required" }, 400);

    const payloadJson = JSON.stringify(body);
    const idempotencyKey = crypto.randomUUID();

    const insertResult = await db
      .prepare(
        "INSERT INTO job_queue (provider_account_id, type, payload_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
      )
      .bind(body.account_id, "create_droplet", payloadJson, idempotencyKey)
      .run();

    const jobId = insertResult.meta.last_row_id;

    await c.env.DO_JOBS_QUEUE.send({ job_id: jobId, type: "create_droplet" });

    await insertAuditLog(db, user?.email ?? "system", "create_server", "server", String(jobId), {
      account_id: body.account_id,
      name: body.name,
    });

    return c.json({ job_id: jobId, status: "queued" }, 202);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/servers/bulk", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const body = await c.req.json<
      Array<{ account_id: number; name: string; region: string; size: string }>
    >();

    if (!Array.isArray(body) || body.length === 0) {
      return c.json({ error: "Body must be a non-empty array" }, 400);
    }

    const jobs: { job_id: number | string; name: string }[] = [];

    for (const item of body) {
      if (typeof item.account_id !== "number") continue;
      if (typeof item.name !== "string" || !item.name.trim()) continue;
      if (typeof item.region !== "string" || !item.region.trim()) continue;
      if (typeof item.size !== "string" || !item.size.trim()) continue;

      const payloadJson = JSON.stringify(item);
      const idempotencyKey = crypto.randomUUID();

      const result = await db
        .prepare(
          "INSERT INTO job_queue (provider_account_id, type, payload_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(item.account_id, "create_droplet", payloadJson, idempotencyKey)
        .run();

      const jobId = result.meta.last_row_id;
      await c.env.DO_JOBS_QUEUE.send({ job_id: jobId, type: "create_droplet" });

      jobs.push({ job_id: jobId, name: item.name });
    }

    await insertAuditLog(db, user?.email ?? "system", "bulk_create_servers", "server", null, {
      count: jobs.length,
    });

    return c.json({ jobs_count: jobs.length, jobs }, 202);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/servers/:id/resize", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ size: string }>();

    if (typeof body.size !== "string" || !body.size.trim()) {
      return c.json({ error: "size is required" }, 400);
    }

    // Look up server account
    const server = await db
      .prepare("SELECT provider_account_id FROM servers WHERE id = ?")
      .bind(id)
      .first<{ provider_account_id: number }>();

    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const payloadJson = JSON.stringify({ server_id: id, size: body.size });
    const idempotencyKey = crypto.randomUUID();

    const result = await db
      .prepare(
        "INSERT INTO job_queue (provider_account_id, type, payload_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
      )
      .bind(server.provider_account_id, "resize", payloadJson, idempotencyKey)
      .run();

    const jobId = result.meta.last_row_id;
    await c.env.DO_JOBS_QUEUE.send({ job_id: jobId, type: "resize" });

    await insertAuditLog(db, user?.email ?? "system", "resize_server", "server", String(id), {
      size: body.size,
    });

    return c.json({ job_id: jobId, status: "queued" }, 202);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/servers/:id/snapshot", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const body = await c.req
      .json<{ name?: string }>()
      .catch(() => ({ name: undefined }));

    const server = await db
      .prepare("SELECT provider_account_id FROM servers WHERE id = ?")
      .bind(id)
      .first<{ provider_account_id: number }>();

    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const payloadJson = JSON.stringify({ server_id: id, name: body.name ?? null });
    const idempotencyKey = crypto.randomUUID();

    const result = await db
      .prepare(
        "INSERT INTO job_queue (provider_account_id, type, payload_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
      )
      .bind(server.provider_account_id, "snapshot", payloadJson, idempotencyKey)
      .run();

    const jobId = result.meta.last_row_id;
    await c.env.DO_JOBS_QUEUE.send({ job_id: jobId, type: "snapshot" });

    await insertAuditLog(db, user?.email ?? "system", "snapshot_server", "server", String(id), {
      snapshot_name: body.name ?? null,
    });

    return c.json({ job_id: jobId, status: "queued" }, 202);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.delete("/api/servers/:id", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));

    const server = await db
      .prepare("SELECT provider_account_id, name FROM servers WHERE id = ?")
      .bind(id)
      .first<{ provider_account_id: number; name: string }>();

    if (!server) {
      return c.json({ error: "Server not found" }, 404);
    }

    const payloadJson = JSON.stringify({ server_id: id });
    const idempotencyKey = crypto.randomUUID();

    const result = await db
      .prepare(
        "INSERT INTO job_queue (provider_account_id, type, payload_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
      )
      .bind(server.provider_account_id, "destroy", payloadJson, idempotencyKey)
      .run();

    const jobId = result.meta.last_row_id;
    await c.env.DO_JOBS_QUEUE.send({ job_id: jobId, type: "destroy" });

    await insertAuditLog(db, user?.email ?? "system", "destroy_server", "server", String(id), {
      name: server.name,
    });

    return c.json({ job_id: jobId, status: "queued" }, 202);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ======================== ACCOUNTS ========================

app.get("/api/accounts", async (c) => {
  try {
    const db = c.env.DB;

    const { results } = await db
      .prepare(
        `SELECT pa.*,
          (SELECT COUNT(*) FROM servers s WHERE s.provider_account_id = pa.id) AS server_count,
          (SELECT COUNT(*) FROM api_credentials ac WHERE ac.provider_id = pa.provider_id) AS token_count
         FROM provider_accounts pa
         ORDER BY pa.created_at DESC`,
      )
      .all();

    return c.json(results);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/accounts", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const body = await c.req.json<{
      team_name: string;
      email?: string;
      notes?: string;
    }>();

    if (typeof body.team_name !== "string" || !body.team_name.trim()) {
      return c.json({ error: "team_name is required" }, 400);
    }

    const result = await db
      .prepare(
        "INSERT INTO provider_accounts (provider_id, team_name, email, notes, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .bind("digitalocean", body.team_name.trim(), body.email ?? null, body.notes ?? null)
      .run();

    const accountId = result.meta.last_row_id;

    await insertAuditLog(db, user?.email ?? "system", "create_account", "account", String(accountId), {
      team_name: body.team_name,
    });

    return c.json({ id: accountId, team_name: body.team_name }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/accounts/:id/sync-balance", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));

    // Fetch account with its credential
    const account = await db
      .prepare("SELECT * FROM provider_accounts WHERE id = ?")
      .bind(id)
      .first();

    if (!account) {
      return c.json({ error: "Account not found" }, 404);
    }

    const acc = account as { credential_id: number | null };

    if (!acc.credential_id) {
      return c.json({ error: "No credential associated with this account" }, 400);
    }

    const credential = await db
      .prepare("SELECT * FROM api_credentials WHERE id = ?")
      .bind(acc.credential_id)
      .first<{
        token_encrypted: string;
        token_iv: string;
        key_version: number;
      }>();

    if (!credential) {
      return c.json({ error: "Credential not found" }, 404);
    }

    const token = await decryptTokenWithFallback(
      credential.token_encrypted,
      credential.token_iv,
      (credential.key_version as 1 | 2) || 1,
      c.env as Env,
    );

    const balanceResponse = await doApiGet("/customers/my/balance", token);

    if (!balanceResponse.ok) {
      const errorMsg = await parseDOError(balanceResponse);
      return c.json({ error: `DO API error: ${errorMsg}` }, 502);
    }

    const balanceData = (await balanceResponse.json()) as {
      account_balance?: string;
      month_to_date_usage?: string;
    };

    const accountBalance = balanceData.account_balance
      ? parseFloat(balanceData.account_balance)
      : null;
    const monthToDateUsage = balanceData.month_to_date_usage
      ? parseFloat(balanceData.month_to_date_usage)
      : null;

    await db
      .prepare(
        "UPDATE provider_accounts SET account_balance_usd = ?, month_to_date_usage_usd = ?, balance_synced_at = datetime('now') WHERE id = ?",
      )
      .bind(accountBalance, monthToDateUsage, id)
      .run();

    await insertAuditLog(db, user?.email ?? "system", "sync_balance", "account", String(id));

    return c.json({
      account_balance_usd: accountBalance,
      month_to_date_usage_usd: monthToDateUsage,
      balance_synced_at: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.patch("/api/accounts/:id", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      team_name?: string;
      email?: string;
      notes?: string;
      billing_status?: string;
    }>();

    // Build dynamic UPDATE
    const updates: string[] = [];
    const binds: unknown[] = [];

    if (body.team_name !== undefined) {
      updates.push("team_name = ?");
      binds.push(body.team_name);
    }
    if (body.email !== undefined) {
      updates.push("email = ?");
      binds.push(body.email);
    }
    if (body.notes !== undefined) {
      updates.push("notes = ?");
      binds.push(body.notes);
    }
    if (body.billing_status !== undefined) {
      updates.push("billing_status = ?");
      binds.push(body.billing_status);
    }

    if (updates.length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    binds.push(id);

    await db
      .prepare(`UPDATE provider_accounts SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();

    await insertAuditLog(db, user?.email ?? "system", "update_account", "account", String(id), body);

    return c.json({ id, ...body });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ======================== CREDENTIALS ========================

app.get("/api/credentials", async (c) => {
  try {
    const db = c.env.DB;

    // NEVER return token_encrypted or token_iv
    const { results } = await db
      .prepare(
        `SELECT id, provider_id, label, scopes, status, key_version,
                rate_limit_hourly, rate_limit_burst_min, requests_remaining,
                window_reset_at, last_probed_at, last_used_at, created_at
         FROM api_credentials
         ORDER BY created_at DESC`,
      )
      .all();

    return c.json(results);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/credentials", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const body = await c.req.json<{
      provider_id: string;
      label: string;
      token: string;
      scopes?: string;
    }>();

    if (typeof body.provider_id !== "string" || !body.provider_id.trim()) {
      return c.json({ error: "provider_id is required" }, 400);
    }
    if (typeof body.label !== "string" || !body.label.trim()) {
      return c.json({ error: "label is required" }, 400);
    }
    if (typeof body.token !== "string" || !body.token.trim()) {
      return c.json({ error: "token is required" }, 400);
    }

    // Verify token with DO API before encrypting
    const verifyResponse = await fetch("https://api.digitalocean.com/v2/account", {
      headers: { Authorization: `Bearer ${body.token}` },
    });

    if (verifyResponse.status === 401) {
      return c.json({ error: "Invalid DO token" }, 400);
    }

    if (!verifyResponse.ok) {
      const errorMsg = await parseDOError(verifyResponse);
      return c.json({ error: `DO API verification failed: ${errorMsg}` }, 400);
    }

    // Extract scopes from DO response
    const verifyData = (await verifyResponse.json()) as {
      account?: { scopes?: string[] };
    };
    const scopes = body.scopes ?? verifyData?.account?.scopes?.join(",") ?? "";

    // Encrypt token
    const encrypted = await encryptToken(body.token, 1, c.env as Env);
    const idempotencyKey = crypto.randomUUID();

    const result = await db
      .prepare(
        `INSERT INTO api_credentials (provider_id, label, token_encrypted, token_iv, scopes, status, key_version, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', 1, ?, datetime('now'))`,
      )
      .bind(body.provider_id, body.label, encrypted.ciphertext, encrypted.iv, scopes, idempotencyKey)
      .run();

    const credentialId = result.meta.last_row_id;

    await insertAuditLog(db, user?.email ?? "system", "create_credential", "credential", String(credentialId), {
      label: body.label,
      provider_id: body.provider_id,
    });

    return c.json(
      { id: credentialId, label: body.label, scopes, status: "active" },
      201,
    );
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.patch("/api/credentials/:id", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ label?: string; status?: string }>();

    const updates: string[] = [];
    const binds: unknown[] = [];

    if (body.label !== undefined) {
      updates.push("label = ?");
      binds.push(body.label);
    }
    if (body.status !== undefined) {
      updates.push("status = ?");
      binds.push(body.status);
    }

    if (updates.length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    binds.push(id);

    await db.prepare(`UPDATE api_credentials SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();

    await insertAuditLog(db, user?.email ?? "system", "update_credential", "credential", String(id), body);

    return c.json({ id, ...body });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/credentials/:id/sync-quota", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));

    const credential = await db
      .prepare("SELECT * FROM api_credentials WHERE id = ?")
      .bind(id)
      .first<{
        token_encrypted: string;
        token_iv: string;
        key_version: number;
        rate_limit_hourly: number;
      }>();

    if (!credential) {
      return c.json({ error: "Credential not found" }, 404);
    }

    const token = await decryptTokenWithFallback(
      credential.token_encrypted,
      credential.token_iv,
      (credential.key_version as 1 | 2) || 1,
      c.env as Env,
    );

    const response = await doApiGet("/account", token);

    if (!response.ok) {
      const errorMsg = await parseDOError(response);
      return c.json({ error: `DO API error: ${errorMsg}`, status: response.status }, 502);
    }

    // Parse rate limit headers
    let ratelimitRemaining: string | null = null;
    let ratelimitReset: string | null = null;

    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "ratelimit-remaining") ratelimitRemaining = value;
      if (key.toLowerCase() === "ratelimit-reset") ratelimitReset = value;
    });

    const remaining = ratelimitRemaining ? Number(ratelimitRemaining) : null;
    const windowReset = ratelimitReset ? Number(ratelimitReset) : null;

    // Update credential quota
    await db
      .prepare("UPDATE api_credentials SET requests_remaining = ?, window_reset_at = ? WHERE id = ?")
      .bind(remaining, windowReset, id)
      .run();

    // Insert rate_limit_events if remaining is low (below 10% of hourly limit)
    if (remaining !== null && credential.rate_limit_hourly > 0) {
      const threshold = Math.max(10, Math.floor(credential.rate_limit_hourly * 0.1));
      if (remaining < threshold) {
        await db
          .prepare("INSERT INTO rate_limit_events (credential_id, endpoint, hit_at, retry_after_seconds) VALUES (?, ?, datetime('now'), ?)")
          .bind(id, "/v2/account", null)
          .run();
      }
    }

    await insertAuditLog(db, user?.email ?? "system", "sync_quota", "credential", String(id));

    return c.json({ requests_remaining: remaining, window_reset_at: windowReset });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ======================== JOBS ========================

app.get("/api/jobs", async (c) => {
  try {
    const db = c.env.DB;
    const status = c.req.query("status");
    const accountId = c.req.query("account_id");
    const type = c.req.query("type");
    const offset = Math.max(0, Number(c.req.query("offset") ?? "0"));
    const limit = 50;

    let sql =
      "SELECT jq.*, pa.team_name FROM job_queue jq LEFT JOIN provider_accounts pa ON jq.provider_account_id = pa.id WHERE 1=1";
    const binds: unknown[] = [];

    if (status) {
      sql += " AND jq.status = ?";
      binds.push(status);
    }
    if (accountId) {
      sql += " AND jq.provider_account_id = ?";
      binds.push(Number(accountId));
    }
    if (type) {
      sql += " AND jq.type = ?";
      binds.push(type);
    }

    sql += " ORDER BY jq.created_at DESC LIMIT ? OFFSET ?";
    binds.push(limit, offset);

    const { results } = await db.prepare(sql).bind(...binds).all();
    return c.json({ results, offset, limit });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/jobs/:id/retry", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));

    const result = await db
      .prepare(
        "UPDATE job_queue SET status = 'pending', attempts = 0, next_retry_at = datetime('now'), error_log = NULL WHERE id = ? AND status = 'failed'",
      )
      .bind(id)
      .run();

    if (result.meta.changes === 0) {
      return c.json({ error: "Job not found or not in failed status" }, 404);
    }

    await insertAuditLog(db, user?.email ?? "system", "retry_job", "job", String(id));

    return c.json({ id, status: "pending" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ======================== BULK CANCEL ========================

app.post("/api/jobs/bulk-cancel", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const body = await c.req.json<{ job_ids: number[] }>();

    if (!Array.isArray(body.job_ids) || body.job_ids.length === 0) {
      return c.json({ error: "job_ids must be a non-empty array" }, 400);
    }

    const placeholders = body.job_ids.map(() => "?").join(",");
    const result = await db
      .prepare(
        `UPDATE job_queue SET status = 'cancelled' WHERE id IN (${placeholders}) AND status = 'pending'`,
      )
      .bind(...body.job_ids)
      .run();

    await insertAuditLog(db, user?.email ?? "system", "bulk_cancel_jobs", "job", null, {
      job_ids: body.job_ids,
      cancelled_count: result.meta.changes,
    });

    return c.json({ cancelled: result.meta.changes });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ======================== SHOW PASSWORD (show-once) ========================

app.post("/api/servers/:id/show-password", async (c) => {
  try {
    const db = c.env.DB;
    const user = c.get("user");
    const id = Number(c.req.param("id"));

    const row = await db
      .prepare(
        "SELECT root_password_encrypted, root_password_iv FROM servers WHERE id = ? AND root_password_encrypted IS NOT NULL",
      )
      .bind(id)
      .first<{ root_password_encrypted: string; root_password_iv: string }>();

    if (!row) {
      return c.json({ error: "No password available" }, 404);
    }

    // Decrypt (try key version fallback since servers don't store key_version)
    const password = await decryptTokenWithFallback(
      row.root_password_encrypted,
      row.root_password_iv,
      1,
      c.env as Env,
    );

    // DELETE password from DB — show-once semantics
    await db
      .prepare("UPDATE servers SET root_password_encrypted = NULL, root_password_iv = NULL WHERE id = ?")
      .bind(id)
      .run();

    await insertAuditLog(db, user?.email ?? "system", "show_password", "server", String(id));

    return c.json({ password });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ======================== NOTIFICATIONS ========================

app.get("/api/notifications", async (c) => {
  try {
    const db = c.env.DB;

    const { results } = await db
      .prepare(
        `SELECT 'audit' AS source, actor, action, target_type, target_id, payload_json, created_at
         FROM audit_log
         UNION ALL
         SELECT 'alert' AS source, '' AS actor, rule_type AS action, target_type, target_id, message AS payload_json, sent_at AS created_at
         FROM alerts_log
         WHERE status = 'sent'
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all();

    return c.json(results);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ======================== SPA FALLBACK ========================
// Non-API routes not handled above are served by the static-assets
// binding (dist/client). Unknown /api/* paths return JSON 404 instead
// of the SPA index.html.

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404 && c.req.path !== "/") {
    return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url)));
  }
  return res;
});

// ---------------------------------------------------------------------------
// Worker entry-point exports
// ---------------------------------------------------------------------------
//
// Hono app exposes handled routes via app.fetch(). We attach it to the
// default export object together with the queue/scheduled handlers —
// Cloudflare detects queue consumers by looking for the named handler on
// the DEFAULT export (named top-level exports are not reliably detected
// when static assets are also configured).

export default {
  fetch: app.fetch.bind(app),
  scheduled: async (controller: ScheduledController, env: Env, _ctx: ExecutionContext) => {
    await handleScheduled(controller.cron, env);
  },
  queue: async (
    batch: MessageBatch<JobMessage>,
    env: Env,
    ctx: ExecutionContext,
  ) => {
    // Cloudflare invokes this single `queue` handler for ALL configured
    // consumers. Route by the originating queue name:
    //   - "do-jobs"     → normal job processing
    //   - "do-jobs-dlq" → dead-letter handling (alert + audit)
    if (batch.queue === "do-jobs-dlq") {
      await handleDLQ(batch, env, ctx);
    } else {
      await handleQueue(batch, env, ctx);
    }
  },
};
