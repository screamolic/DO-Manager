-- =====================================================================
-- schema.sql — D1 (SQLite) schema for multi-account DigitalOcean /
-- multi-provider API management.
--
-- Deploy with:
--   wrangler d1 create do-manager-db
--   wrangler d1 execute do-manager-db --file=./schema.sql
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- providers: abstraction layer so this isn't locked to DigitalOcean only
-- ---------------------------------------------------------------------
CREATE TABLE providers (
  id            TEXT PRIMARY KEY,          -- e.g. 'digitalocean'
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  auth_type     TEXT NOT NULL DEFAULT 'bearer',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO providers (id, name, base_url) VALUES
  ('digitalocean', 'DigitalOcean', 'https://api.digitalocean.com/v2');

-- ---------------------------------------------------------------------
-- api_credentials: one row per API token. This is the unit of rate
-- limiting — DO enforces limits per OAuth token (5000/hr, 250/min burst).
-- ---------------------------------------------------------------------
CREATE TABLE api_credentials (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id            TEXT NOT NULL REFERENCES providers(id),
  label                  TEXT NOT NULL,          -- e.g. "acc-utara-token1"
  token_encrypted        TEXT NOT NULL,           -- AES-GCM ciphertext, base64
  token_iv               TEXT NOT NULL,           -- IV used for encryption
  scopes                 TEXT,                    -- comma-separated scopes
  status                 TEXT NOT NULL DEFAULT 'active', -- active|disabled|revoked
  rate_limit_hourly      INTEGER NOT NULL DEFAULT 5000,
  rate_limit_burst_min   INTEGER NOT NULL DEFAULT 250,
  requests_remaining     INTEGER,                 -- synced from ratelimit-remaining header
  window_reset_at        INTEGER,                 -- unix epoch, from ratelimit-reset header
  last_used_at           TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_credentials_provider_status
  ON api_credentials (provider_id, status);

-- ---------------------------------------------------------------------
-- provider_accounts: one row per DO Team/account. A team can own
-- multiple tokens with different scopes.
-- ---------------------------------------------------------------------
CREATE TABLE provider_accounts (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id               TEXT NOT NULL REFERENCES providers(id),
  credential_id             INTEGER REFERENCES api_credentials(id),
  team_name                 TEXT NOT NULL,
  email                     TEXT,
  billing_status            TEXT DEFAULT 'active',
  account_balance_usd       REAL,          -- synced from DO Balance API
  month_to_date_usage_usd   REAL,          -- synced from DO Balance API
  balance_synced_at         TEXT,
  notes                     TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- servers: local mirror of droplets/instances across all accounts
-- ---------------------------------------------------------------------
CREATE TABLE servers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_account_id   INTEGER NOT NULL REFERENCES provider_accounts(id),
  external_id           TEXT NOT NULL,           -- droplet_id from DO
  name                  TEXT NOT NULL,
  region                TEXT,
  size_slug             TEXT,
  ip_address            TEXT,
  status                TEXT DEFAULT 'unknown',  -- active|off|new|archive
  tags_json             TEXT DEFAULT '[]',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  last_health_check_at  TEXT,
  UNIQUE (provider_account_id, external_id)
);

CREATE INDEX idx_servers_account ON servers (provider_account_id);
CREATE INDEX idx_servers_status ON servers (status);

-- ---------------------------------------------------------------------
-- do_actions: mirrors DO's Actions API. DO operations (resize, snapshot,
-- reboot) are async — this table tracks completion separately from the
-- job that requested it.
-- ---------------------------------------------------------------------
CREATE TABLE do_actions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id       INTEGER NOT NULL REFERENCES servers(id),
  do_action_id    TEXT NOT NULL,
  type            TEXT NOT NULL,        -- create|resize|snapshot|power_cycle...
  status          TEXT NOT NULL DEFAULT 'in-progress', -- in-progress|completed|errored
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE INDEX idx_actions_server ON do_actions (server_id);
CREATE INDEX idx_actions_status ON do_actions (status);

-- ---------------------------------------------------------------------
-- job_queue: consumer-side record for jobs pushed through Cloudflare
-- Queues. One row per unit of work (e.g. "create droplet", "bulk tag").
-- ---------------------------------------------------------------------
CREATE TABLE job_queue (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_account_id   INTEGER REFERENCES provider_accounts(id),
  type                  TEXT NOT NULL,        -- create_droplet|resize|delete|bulk_tag...
  payload_json          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  priority              INTEGER NOT NULL DEFAULT 5,
  attempts              INTEGER NOT NULL DEFAULT 0,
  next_retry_at         TEXT,
  error_log             TEXT,
  idempotency_key       TEXT UNIQUE,           -- generated once at job creation, sent on every DO API attempt to prevent duplicate resources
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_status ON job_queue (status, next_retry_at);

-- ---------------------------------------------------------------------
-- rate_limit_events: audit trail of 429s, so it's obvious which
-- credential is running hot and needs rotation/cooldown.
-- ---------------------------------------------------------------------
CREATE TABLE rate_limit_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id         INTEGER NOT NULL REFERENCES api_credentials(id),
  endpoint              TEXT NOT NULL,
  hit_at                TEXT NOT NULL DEFAULT (datetime('now')),
  retry_after_seconds   INTEGER
);

CREATE INDEX idx_ratelimit_credential ON rate_limit_events (credential_id, hit_at);

-- ---------------------------------------------------------------------
-- audit_log: generic append-only log for anything worth tracing
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor         TEXT NOT NULL DEFAULT 'system',
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  payload_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_target ON audit_log (target_type, target_id);

-- ---------------------------------------------------------------------
-- webhooks_inbox: raw inbound events (DO doesn't have native webhooks
-- for droplets yet, but this future-proofs for monitoring alerts, or
-- other providers that do push webhooks)
-- ---------------------------------------------------------------------
CREATE TABLE webhooks_inbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  event_type    TEXT,
  payload_json  TEXT NOT NULL,
  processed     INTEGER NOT NULL DEFAULT 0,   -- 0/1 boolean
  received_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_webhooks_processed ON webhooks_inbox (processed);

-- ---------------------------------------------------------------------
-- alert_rules: configurable thresholds for Telegram notifications
-- (server down, token throttled, job failed, low balance)
-- ---------------------------------------------------------------------
CREATE TABLE alert_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type              TEXT NOT NULL,        -- server_down|token_throttled|job_failed|balance_low
  enabled           INTEGER NOT NULL DEFAULT 1,
  threshold_json    TEXT,                 -- e.g. {"min_balance": 15} or {"count": 3, "window_minutes": 10}
  telegram_chat_id  TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- alerts_log: sent-notification history, used for dedup so a server
-- that's been down for an hour doesn't spam a message every 5 minutes.
-- ---------------------------------------------------------------------
CREATE TABLE alerts_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type     TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'sent',  -- sent|failed
  sent_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_alerts_target ON alerts_log (target_type, target_id, sent_at);
