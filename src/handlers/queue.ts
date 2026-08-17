/**
 * Queue consumer handler for DO job processing.
 *
 * - Atomic credential selection (pickCredential) with scope-aware filtering
 * - Idempotent DO API calls using job_queue.idempotency_key
 * - Exponential backoff on rate limit (30s → 2m → 10m)
 * - Case-insensitive rate limit header parsing
 */

import { decryptTokenWithFallback, encryptToken } from "../lib/crypto";
import { parseDOError } from "../lib/do-api";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface JobMessage {
  job_id: number;
  type: "create_droplet" | "resize" | "snapshot" | "destroy";
}

interface JobRow {
  id: number;
  type: string;
  status: string;
  credential_id: number | null;
  idempotency_key: string | null;
  payload_json: string | null;
  attempts: number;
  error_log: string | null;
  next_retry_at: string | null;
}

interface CredentialRow {
  id: number;
  token_encrypted: string;
  token_iv: string;
  key_version: number;
  requests_remaining: number;
  window_reset_at: number | null;
  last_probed_at: string | null;
}

interface Env {
  DB: D1Database;
  ENCRYPTION_KEY_V1?: string;
  ENCRYPTION_KEY_V2?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

export const JOB_SCOPE_MAP: Record<string, string> = {
  create_droplet: "write",
  resize: "write",
  snapshot: "read",
  destroy: "write",
};

const DO_API_BASE = "https://api.digitalocean.com/v2";

const RETRY_DELAYS = [30, 120, 600]; // seconds: 30s → 2m → 10m

const MAX_RETRIES = 3;

/* ------------------------------------------------------------------ */
/*  DO API URL builder                                                */
/* ------------------------------------------------------------------ */

export function buildDORequest(
  jobType: string,
  payload: Record<string, unknown>,
): { method: string; url: string; body?: unknown } {
  switch (jobType) {
    case "create_droplet":
      // Forward entire payload (name, region, size, image, etc.) as body
      return { method: "POST", url: `${DO_API_BASE}/droplets`, body: payload };
    case "resize":
      return {
        method: "POST",
        url: `${DO_API_BASE}/droplets/${payload.droplet_id}/actions`,
        body: { ...payload, type: "resize" },
      };
    case "snapshot":
      return {
        method: "POST",
        url: `${DO_API_BASE}/droplets/${payload.droplet_id}/actions`,
        body: { ...payload, type: "snapshot" },
      };
    case "destroy":
      return {
        method: "DELETE",
        url: `${DO_API_BASE}/droplets/${payload.droplet_id}`,
      };
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Atomic credential selection                                        */
/* ------------------------------------------------------------------ */

const PICK_CREDENTIAL_SQL = `
  UPDATE api_credentials
  SET requests_remaining =
      CASE
        WHEN requests_remaining > 0 THEN requests_remaining - 1
        WHEN window_reset_at IS NOT NULL
         AND window_reset_at < CAST(strftime('%s', 'now') AS INTEGER) THEN 1
        ELSE 0
      END,
      last_probed_at = CASE WHEN requests_remaining <= 0 THEN datetime('now') ELSE last_probed_at END
  WHERE id = (
    SELECT id FROM api_credentials
    WHERE provider_id = ?
      AND status = 'active'
      AND (requests_remaining > 0
        OR (window_reset_at IS NOT NULL
            AND window_reset_at < CAST(strftime('%s', 'now') AS INTEGER)))
      AND (scopes LIKE '%' || ? || '%' OR scopes IS NULL)
    ORDER BY requests_remaining DESC
    LIMIT 1
  )
  RETURNING *
`;

export async function pickCredential(
  providerId: string,
  requiredScope: string,
  env: Env,
): Promise<{ credential_id: number; token: string } | null> {
  const row = await env.DB
    .prepare(PICK_CREDENTIAL_SQL)
    .bind(providerId, requiredScope)
    .first<CredentialRow>();

  if (!row) return null;

  const token = await decryptTokenWithFallback(
    row.token_encrypted,
    row.token_iv,
    row.key_version as 1 | 2,
    env,
  );

  return { credential_id: row.id, token };
}

/* ------------------------------------------------------------------ */
/*  Rate limit header parsing (case-insensitive)                       */
/* ------------------------------------------------------------------ */

export function parseRateLimitHeaders(
  headers: Headers,
): { remaining: number | null; reset: number | null } {
  let remaining: number | null = null;
  let reset: number | null = null;

  headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === "ratelimit-remaining") {
      remaining = parseInt(value, 10);
    }
    if (lk === "ratelimit-reset") {
      reset = parseInt(value, 10);
    }
  });

  return { remaining, reset };
}

/* ------------------------------------------------------------------ */
/*  Job type handlers                                                 */
/* ------------------------------------------------------------------ */

async function handleCreateDroplet(
  response: Response,
  payload: Record<string, unknown>,
  env: Env,
): Promise<void> {
  const data = (await response.json()) as {
    droplet?: {
      id?: number;
      name?: string;
      region?: { slug?: string };
      size?: { slug?: string };
      networks?: { v4?: Array<{ ip_address?: string; type?: string }> };
      tags?: string[];
      password?: string;
    };
  };
  const droplet = data.droplet;
  if (!droplet) return;

  // Extract public IPv4
  let ipAddress: string | null = null;
  if (droplet.networks?.v4) {
    const pub = droplet.networks.v4.find((n) => n.type === "public");
    if (pub?.ip_address) ipAddress = pub.ip_address;
  }

  // Encrypt root password if present (show-once)
  let rootPwdEncrypted: string | null = null;
  let rootPwdIv: string | null = null;
  if (droplet.password) {
    const enc = await encryptToken(droplet.password, 1, env);
    rootPwdEncrypted = enc.ciphertext;
    rootPwdIv = enc.iv;
  }

  await env.DB
    .prepare(
      `INSERT INTO servers
        (external_id, name, region, size_slug, ip_address, tags_json,
         root_password_encrypted, root_password_iv, network_json,
          provider_account_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))`,
    )
    .bind(
      String(droplet.id ?? droplet.name ?? ''),
      droplet.name ?? null,
      droplet.region?.slug ?? null,
      droplet.size?.slug ?? null,
      ipAddress,
      droplet.tags ? JSON.stringify(droplet.tags) : null,
      rootPwdEncrypted,
      rootPwdIv,
      droplet.networks ? JSON.stringify(droplet.networks) : null,
      (payload.account_id as number) ?? 0,
    )
    .run();
}

async function handleActionResponse(
  response: Response,
  type: string,
  payload: Record<string, unknown>,
  env: Env,
): Promise<void> {
  const data = (await response.json()) as {
    action?: { id?: number };
  };
  const action = data.action;
  if (action?.id) {
    await env.DB
      .prepare(
        `INSERT INTO do_actions (do_action_id, server_id, type, status, created_at)
         VALUES (?, ?, ?, 'in-progress', datetime('now'))`,
      )
      .bind(action.id, payload.droplet_id, type)
      .run();
  }
}

async function handleDestroy(
  payload: Record<string, unknown>,
  env: Env,
): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE servers SET status = 'archive' WHERE external_id = ?`,
    )
    .bind(payload.droplet_id as number)
    .run();
}

/* ------------------------------------------------------------------ */
/*  Main queue consumer handler                                        */
/* ------------------------------------------------------------------ */

export async function handleQueue(
  batch: MessageBatch<JobMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const { job_id, type } = message.body;
    const requiredScope = JOB_SCOPE_MAP[type];
    if (!requiredScope) {
      console.error(`Unknown job type: ${type} for job ${job_id}`);
      message.ack();
      continue;
    }

    /* ---- Read job_queue row ---- */
    const job = await env.DB
      .prepare("SELECT * FROM job_queue WHERE id = ?")
      .bind(job_id)
      .first<JobRow>();

    if (!job) {
      console.error(`Job ${job_id} not found in job_queue`);
      message.ack();
      continue;
    }

    /* ---- Resolve credential ---- */
    let credentialId: number;
    let token: string;

    if (job.credential_id === null) {
      // First attempt — pick best credential atomically
      const cred = await pickCredential("digitalocean", requiredScope, env);
      if (!cred) {
        const errorMsg = `No available credentials with required scope '${requiredScope}'`;
        await env.DB
          .prepare(
            `UPDATE job_queue SET status = 'failed', error_log = ?,
             attempts = COALESCE(attempts, 0) + 1 WHERE id = ?`,
          )
          .bind(errorMsg, job_id)
          .run();
        message.ack();
        continue;
      }
      credentialId = cred.credential_id;
      token = cred.token;

      // Persist credential_id immediately for idempotent retry
      await env.DB
        .prepare("UPDATE job_queue SET credential_id = ? WHERE id = ?")
        .bind(credentialId, job_id)
        .run();
    } else {
      // Retry — use SAME credential (DO idempotency key is per-token)
      credentialId = job.credential_id;
      const credRow = await env.DB
        .prepare(
          `SELECT token_encrypted, token_iv, key_version
           FROM api_credentials WHERE id = ?`,
        )
        .bind(credentialId)
        .first<{ token_encrypted: string; token_iv: string; key_version: number }>();

      if (!credRow) {
        const errorMsg = `Credential ${credentialId} not found`;
        await env.DB
          .prepare(
            `UPDATE job_queue SET status = 'failed', error_log = ?,
             attempts = COALESCE(attempts, 0) + 1 WHERE id = ?`,
          )
          .bind(errorMsg, job_id)
          .run();
        message.ack();
        continue;
      }

      token = await decryptTokenWithFallback(
        credRow.token_encrypted,
        credRow.token_iv,
        credRow.key_version as 1 | 2,
        env,
      );
    }

    /* ---- Parse payload ---- */
    let payload: Record<string, unknown> = {};
    if (job.payload_json) {
      try {
        payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }

    /* ---- Build & send DO API request ---- */
    const { method, url, body } = buildDORequest(type, payload);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (job.idempotency_key) {
      headers["Idempotency-Key"] = job.idempotency_key;
    }

    const init: RequestInit = { method, headers };
    if (body && method !== "DELETE") {
      init.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, init);

      /* ---- Handle 429 rate limit ---- */
      if (response.status === 429) {
        const rl = parseRateLimitHeaders(response.headers);

        await env.DB
          .prepare(
            `INSERT INTO rate_limit_events (credential_id, endpoint, hit_at, retry_after_seconds)
             VALUES (?, ?, datetime('now'), ?)`,
          )
          .bind(credentialId, url, response.headers.get("Retry-After") ?? null)
          .run();

        await env.DB
          .prepare(
            `UPDATE api_credentials SET requests_remaining = 0,
             window_reset_at = ? WHERE id = ?`,
          )
          .bind(rl.reset, credentialId)
          .run();

        // Exponential backoff
        const attemptIdx = Math.min(
          job.attempts || 0,
          RETRY_DELAYS.length - 1,
        );
        const delay = RETRY_DELAYS[attemptIdx];

        await env.DB
          .prepare(
            `UPDATE job_queue SET next_retry_at = ?,
             attempts = COALESCE(attempts, 0) + 1 WHERE id = ?`,
          )
          .bind(
            new Date(Date.now() + delay * 1000).toISOString(),
            job_id,
          )
          .run();

        message.retry({ delaySeconds: delay });
        continue;
      }

      /* ---- Handle success ---- */
      if (response.ok) {
        const rl = parseRateLimitHeaders(response.headers);
        if (rl.remaining !== null) {
          await env.DB
            .prepare(
              `UPDATE api_credentials SET requests_remaining = ?,
               window_reset_at = ? WHERE id = ?`,
            )
            .bind(rl.remaining, rl.reset, credentialId)
            .run();
        }

        // Route to type-specific handler
        if (type === "create_droplet") {
          await handleCreateDroplet(response, payload, env);
        } else if (type === "resize" || type === "snapshot") {
          await handleActionResponse(response, type, payload, env);
        } else if (type === "destroy") {
          await handleDestroy(payload, env);
        }

        await env.DB
          .prepare(
            `UPDATE job_queue SET status = 'done',
             attempts = COALESCE(attempts, 0) + 1, error_log = NULL WHERE id = ?`,
          )
          .bind(job_id)
          .run();

        message.ack();
        continue;
      }

      /* ---- Handle other errors (400, 401, 404, 500, …) ---- */
      const errorMsg = await parseDOError(response);
      const newAttempts = (job.attempts || 0) + 1;

      if (newAttempts >= MAX_RETRIES) {
        await env.DB
          .prepare(
            `UPDATE job_queue SET status = 'failed', attempts = ?,
             error_log = ? WHERE id = ?`,
          )
          .bind(newAttempts, errorMsg, job_id)
          .run();
        message.ack();
      } else {
        await env.DB
          .prepare(
            `UPDATE job_queue SET attempts = ?, error_log = ? WHERE id = ?`,
          )
          .bind(newAttempts, errorMsg, job_id)
          .run();
        message.retry();
      }
    } catch (err) {
      /* ---- Network / runtime error ---- */
      const errorMsg = (err as Error).message;
      const newAttempts = (job.attempts || 0) + 1;

      if (newAttempts >= MAX_RETRIES) {
        await env.DB
          .prepare(
            `UPDATE job_queue SET status = 'failed', attempts = ?,
             error_log = ? WHERE id = ?`,
          )
          .bind(newAttempts, errorMsg, job_id)
          .run();
        message.ack();
      } else {
        await env.DB
          .prepare(
            `UPDATE job_queue SET attempts = ?, error_log = ? WHERE id = ?`,
          )
          .bind(newAttempts, errorMsg, job_id)
          .run();
        message.retry();
      }
    }
  }
}
