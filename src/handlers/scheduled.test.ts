/**
 * Vitest tests for scheduled (cron) handlers.
 *
 * Covers all 7 cron branches: action sync, server list sync (paginated),
 * balance sync, data retention, alert checks (5 types), credential
 * exhaust probe, and the D1 backup placeholder.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleScheduled } from "./scheduled";

/* ------------------------------------------------------------------ */
/*  Module-level mocks                                                */
/* ------------------------------------------------------------------ */

const { cryptoMock, doApiMock } = vi.hoisted(() => ({
  cryptoMock: {
    decryptTokenWithFallback: vi
      .fn()
      .mockResolvedValue("do-mock-token-abc"),
  },
  doApiMock: {
    parseDOError: vi.fn().mockResolvedValue("mock DO error"),
  },
}));

vi.mock("../lib/crypto", () => cryptoMock);
vi.mock("../lib/do-api", () => doApiMock);
vi.mock("../lib/notifications", () => ({
  sendTelegram: vi.fn().mockResolvedValue({ ok: true }),
}));

/* ------------------------------------------------------------------ */
/*  Mock D1 builder — indexed per-call control                        */
/* ------------------------------------------------------------------ */

interface DBMocks {
  db: D1Database;
  /** SQL strings for every prepare() call (in order). */
  sqlLog: string[];
  /** SQL strings for every run() call (in order). */
  runLog: string[];
  /** Configure what each all() call returns — indexed by call order. */
  setAllResults: (results: unknown[][]) => void;
  /** Configure what each first() call returns — indexed by call order. */
  setFirstResults: (results: unknown[]) => void;
}

/** Creates a tracked mock D1 with per-call-index result control. */
function createDB(): DBMocks {
  const sqlLog: string[] = [];
  const runLog: string[] = [];
  const allResults: unknown[][] = [];
  const firstResults: unknown[] = [];
  let allIdx = 0;
  let firstIdx = 0;
  let lastSql = "";
  let lastBinds: unknown[] = [];

  const allFn = vi.fn().mockImplementation(() => {
    const idx = allIdx++;
    return Promise.resolve({
      success: true,
      results: idx < allResults.length ? allResults[idx] : [],
    });
  });

  const firstFn = vi.fn().mockImplementation(() => {
    const idx = firstIdx++;
    return Promise.resolve(
      idx < firstResults.length ? firstResults[idx] : null,
    );
  });

  const runFn = vi.fn().mockImplementation(() => {
    // Store SQL + binds as a pipe-joined string so assertions can check both
    const bindsStr = lastBinds.length ? " | BINDS: " + JSON.stringify(lastBinds) : "";
    runLog.push(lastSql + bindsStr);
    return Promise.resolve({ success: true, meta: { changes: 1, last_row_id: 1 } });
  });

  const stmt = () => ({
    first: firstFn,
    run: runFn,
    all: allFn,
    bind: (...b: unknown[]) => {
      lastBinds = b;
      return stmt();
    },
  });

  const prepareFn = vi.fn((sql: string) => {
    sqlLog.push(sql);
    lastSql = sql;
    return stmt();
  });

  return {
    db: { prepare: prepareFn } as unknown as D1Database,
    sqlLog,
    runLog,
    setAllResults(r: unknown[][]) {
      allResults.length = 0;
      allResults.push(...r);
      allIdx = 0;
    },
    setFirstResults(r: unknown[]) {
      firstResults.length = 0;
      firstResults.push(...r);
      firstIdx = 0;
    },
  };
}

function testEnv(db: D1Database, bucket?: R2Bucket) {
  return {
    DB: db,
    BACKUP_BUCKET:
      bucket ??
      ({
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
        list: vi.fn().mockResolvedValue({ objects: [] }),
        delete: vi.fn().mockResolvedValue(undefined),
      } as unknown as R2Bucket),
    ENCRYPTION_KEY_V1: "test-v1-base64-key",
    ENCRYPTION_KEY_V2: "test-v2-base64-key",
    TEAM_DOMAIN: "test-team.cloudflareaccess.com",
  };
}

const MOCK_TOKEN = "do-mock-token-abc";

beforeEach(() => {
  cryptoMock.decryptTokenWithFallback.mockReset();
  cryptoMock.decryptTokenWithFallback.mockResolvedValue(MOCK_TOKEN);
  doApiMock.parseDOError.mockReset();
  doApiMock.parseDOError.mockResolvedValue("mock DO error");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  Cron routing                                                      */
/* ------------------------------------------------------------------ */

describe("handleScheduled", () => {
  it("*/5 * * * * runs action sync + alert checks", async () => {
    const { db, sqlLog } = createDB();
    await handleScheduled("*/5 * * * *", testEnv(db));
    // Expect action sync query + 5 alert check queries
    expect(sqlLog.length).toBeGreaterThanOrEqual(5);
  });

  it("*/15 * * * * runs server list sync", async () => {
    const { db, sqlLog } = createDB();
    await handleScheduled("*/15 * * * *", testEnv(db));
    expect(sqlLog.some((s) => s.includes("provider_accounts"))).toBe(true);
  });

  it("*/30 * * * * runs balance sync + exhaust probe", async () => {
    const { db, sqlLog } = createDB();
    await handleScheduled("*/30 * * * *", testEnv(db));
    expect(sqlLog.length).toBeGreaterThanOrEqual(2);
  });

  it("0 0 * * * runs data retention deletes", async () => {
    const { db, runLog } = createDB();
    await handleScheduled("0 0 * * *", testEnv(db));

    expect(runLog.length).toBe(2);
    expect(runLog.some((s) => s.includes("DELETE FROM audit_log"))).toBe(true);
    expect(runLog.some((s) => s.includes("DELETE FROM rate_limit_events"))).toBe(true);
  });

  it("unknown cron does not crash", async () => {
    const { db } = createDB();
    await expect(
      handleScheduled("*/1 * * * *", testEnv(db)),
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Action sync                                                       */
/* ------------------------------------------------------------------ */

describe("action sync", () => {
  it("updates DO actions and inserts server_down alert for power_off", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([
      [
        {
          id: 10,
          server_id: 1,
          do_action_id: "1234567",
          type: "power_off",
          status: "in-progress",
          completed_at: null,
          provider_account_id: 5,
          external_id: 98765,
        },
      ],
    ]);

    setFirstResults([
      { id: 5, credential_id: 42 },
      {
        id: 42,
        token_encrypted: "enc",
        token_iv: "iv",
        key_version: 1,
      },
      null,
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ action: { status: "completed" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await handleScheduled("*/5 * * * *", testEnv(db));

    // Verify do_actions UPDATE
    expect(
      runLog.some((s) => s.includes("UPDATE do_actions") && s.includes("completed_at")),
    ).toBe(true);

    // Verify server_down alert INSERT
    expect(
      runLog.some((s) => s.includes("INSERT INTO alerts_log") && s.includes("server_down")),
    ).toBe(true);
  });

  it("does not insert alert for non-power action (rename)", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([
      [
        {
          id: 11,
          server_id: 2,
          do_action_id: "7654321",
          type: "rename",
          status: "in-progress",
          completed_at: null,
          provider_account_id: 5,
          external_id: 12345,
        },
      ],
    ]);

    setFirstResults([
      { id: 5, credential_id: 42 },
      { id: 42, token_encrypted: "enc", token_iv: "iv", key_version: 1 },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ action: { status: "completed" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await handleScheduled("*/5 * * * *", testEnv(db));

    // Must have do_actions UPDATE
    expect(runLog.some((s) => s.includes("UPDATE do_actions"))).toBe(true);

    // Must NOT have server_down alert
    expect(runLog.some((s) => s.includes("server_down"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Server list sync (paginated)                                       */
/* ------------------------------------------------------------------ */

describe("server list sync pagination", () => {
  it("processes 2 pages and upserts all droplets", async () => {
    const { db, runLog, setAllResults } = createDB();

    setAllResults([
      [
        {
          id: 10,
          provider_id: "digitalocean",
          credential_id: 7,
          team_name: "Paginated Team",
          token_encrypted: "enc-p",
          token_iv: "iv",
          key_version: 1,
        },
      ],
    ]);

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                droplets: [
                  { id: 1001, name: "server-a", status: "active", region: { slug: "nyc3" }, networks: { v4: [] }, tags: [] },
                  { id: 1002, name: "server-b", status: "active", region: { slug: "sfo3" }, networks: { v4: [] }, tags: [] },
                ],
                links: { pages: { next: "https://api.digitalocean.com/v2/droplets?page=2&per_page=200" } },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              droplets: [
                { id: 1003, name: "server-c", status: "off", region: { slug: "ams3" }, networks: { v4: [] }, tags: [] },
              ],
              links: { pages: { next: null } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    );

    await handleScheduled("*/15 * * * *", testEnv(db));

    // 3 upsert INSERT ... ON CONFLICT calls
    const upserts = runLog.filter(
      (s) => s.includes("INSERT INTO servers") && s.includes("ON CONFLICT"),
    );
    expect(upserts.length).toBe(3);

    // Archive step with NOT IN
    expect(
      runLog.some((s) => s.includes("UPDATE servers") && s.includes("archived") && s.includes("NOT IN")),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Balance sync                                                      */
/* ------------------------------------------------------------------ */

describe("balance sync", () => {
  it("updates account balance from DO Balance API", async () => {
    const { db, runLog, setAllResults } = createDB();

    setAllResults([
      [
        {
          id: 1,
          provider_id: "digitalocean",
          credential_id: 42,
          team_name: "Test Team",
          account_balance_usd: null,
          month_to_date_usage_usd: null,
          balance_synced_at: null,
          token_encrypted: "enc",
          token_iv: "iv",
          key_version: 1,
        },
      ],
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ account_balance: "25.50", month_to_date_usage: "10.75" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await handleScheduled("*/30 * * * *", testEnv(db));

    expect(
      runLog.some(
        (s) =>
          s.includes("UPDATE provider_accounts") &&
          s.includes("account_balance_usd"),
      ),
    ).toBe(true);
  });

  it("handles 401 gracefully without crashing", async () => {
    const { db, setAllResults } = createDB();

    setAllResults([
      [
        {
          id: 2,
          provider_id: "digitalocean",
          credential_id: 99,
          team_name: "Bad Token",
          account_balance_usd: null,
          month_to_date_usage_usd: null,
          balance_synced_at: null,
          token_encrypted: "enc-bad",
          token_iv: "iv",
          key_version: 1,
        },
      ],
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    await expect(
      handleScheduled("*/30 * * * *", testEnv(db)),
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Alert checks — 5 types                                            */
/* ------------------------------------------------------------------ */

describe("alert check — server_down", () => {
  it("inserts alert for completed power-off action", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([
      [],
      [
        {
          id: 20,
          server_id: 1,
          do_action_id: "555",
          type: "power_off",
          status: "completed",
          completed_at: "2026-07-07T00:05:00Z",
          provider_account_id: 5,
          external_id: 98765,
        },
      ],
    ]);

    setFirstResults([null]);

    await handleScheduled("*/5 * * * *", testEnv(db));

    expect(
      runLog.some((s) => s.includes("INSERT INTO alerts_log") && s.includes("server_down")),
    ).toBe(true);
  });
});

describe("alert check — token_throttled", () => {
  it("inserts alert when credential has 3+ rate limits in 10 min", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([[], [], [{ credential_id: 42, cnt: 3 }]]);
    setFirstResults([null]);

    await handleScheduled("*/5 * * * *", testEnv(db));

    expect(
      runLog.some((s) => s.includes("INSERT INTO alerts_log") && s.includes("token_throttled")),
    ).toBe(true);
  });
});

describe("alert check — job_failed", () => {
  it("inserts alert for jobs with >=3 failed attempts", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([[], [], [], [
      { id: 99, type: "resize", status: "failed", attempts: 3, error_log: "Droplet not found", provider_account_id: 1 },
    ]]);
    setFirstResults([null]);

    await handleScheduled("*/5 * * * *", testEnv(db));

    expect(
      runLog.some((s) => s.includes("INSERT INTO alerts_log") && s.includes("job_failed")),
    ).toBe(true);
  });
});

describe("alert check — balance_low", () => {
  it("inserts alerts for accounts with balance < 15 USD", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([[], [], [], [], [
      { id: 1, team_name: "Low Team", account_balance_usd: 5.5 },
      { id: 2, team_name: "Empty", account_balance_usd: 0 },
    ]]);
    setFirstResults([null]);

    await handleScheduled("*/5 * * * *", testEnv(db));

    const inserts = runLog.filter(
      (s) => s.includes("INSERT INTO alerts_log") && s.includes("balance_low"),
    );
    expect(inserts.length).toBe(2);
  });
});

describe("alert check — dlq_stuck", () => {
  it("sends telegram and updates pending dlq_stuck alerts", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([[], [], [], [], [], [
      { id: 1, rule_type: "dlq_stuck", target_id: "42", message: "Job #42 permanently failed" },
    ]]);
    setFirstResults([null]);

    await handleScheduled("*/5 * * * *", testEnv(db));

    // UPDATE alerts_log SET status = ?, sent_at = datetime('now') WHERE id = ? with bind ['sent', 1]
    expect(
      runLog.some((s) => s.includes("UPDATE alerts_log") && s.includes('"sent"')),
    ).toBe(true);

    // No extra INSERT (the existing row is updated in place)
    expect(
      runLog.some(
        (s) =>
          s.includes("INSERT INTO alerts_log") &&
          s.includes("dlq_stuck"),
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Dedup                                                             */
/* ------------------------------------------------------------------ */

describe("alert dedup", () => {
  it("skips insertion when duplicate alert exists within 60min", async () => {
    const { db, runLog, setAllResults, setFirstResults } = createDB();

    setAllResults([[], [
      {
        id: 30,
        server_id: 5,
        do_action_id: "666",
        type: "shutdown",
        status: "completed",
        completed_at: "2026-07-07T00:05:00Z",
        provider_account_id: 5,
        external_id: 55555,
      },
    ]]);
    setFirstResults([{ id: 999 }]);

    await handleScheduled("*/5 * * * *", testEnv(db));

    // No server_down INSERT
    expect(runLog.some((s) => s.includes("server_down"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Credential exhaust probe                                          */
/* ------------------------------------------------------------------ */

describe("credential exhaust probe", () => {
  it("probes exhausted credentials and refreshes rate limit headers", async () => {
    const { db, runLog, setAllResults } = createDB();

    setAllResults([[], [
      {
        id: 42,
        token_encrypted: "enc-ex",
        token_iv: "iv",
        key_version: 1,
        requests_remaining: 0,
        window_reset_at: null,
      },
    ]]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ account: { droplet_limit: 10 } }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "ratelimit-remaining": "4999",
              "ratelimit-reset": "1712345678",
            },
          },
        ),
      ),
    );

    await handleScheduled("*/30 * * * *", testEnv(db));

    expect(
      runLog.some(
        (s) =>
          s.includes("UPDATE api_credentials") &&
          s.includes("requests_remaining"),
      ),
    ).toBe(true);
  });

  it("sets credential status to error on 401", async () => {
    const { db, runLog, setAllResults } = createDB();

    setAllResults([[], [
      {
        id: 77,
        token_encrypted: "enc-err",
        token_iv: "iv",
        key_version: 1,
        requests_remaining: 0,
        window_reset_at: null,
      },
    ]]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    await handleScheduled("*/30 * * * *", testEnv(db));

    expect(
      runLog.some(
        (s) =>
          s.includes("UPDATE api_credentials") &&
          s.includes("status = 'error'"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  D1 backup to R2                                                   */
/* ------------------------------------------------------------------ */

describe("D1 backup to R2", () => {
  it("generates SQL dump, uploads to R2, and prunes old backups", async () => {
    const { db, sqlLog, setAllResults, setFirstResults } = createDB();

    // sqlite_master returns 2 user tables
    setAllResults([
      [{ name: "api_credentials" }, { name: "servers" }],
      [{ id: 1, token_encrypted: "enc1" }],
      [{ id: 10, name: "web-01" }, { id: 20, name: "web-02" }],
    ]);

    setFirstResults([
      { sql: "CREATE TABLE api_credentials (id INTEGER PRIMARY KEY, token_encrypted TEXT)" },
      { sql: "CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT)" },
    ]);

    // Mock R2 with one old object to prune
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // >90 days ago
    const mockBucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue({
        objects: [
          { key: "backup-2025-01-01.sql", uploaded: oldDate },
        ],
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await handleScheduled("0 0 * * *", testEnv(db, mockBucket as unknown as R2Bucket));

    // sqlite_master query was issued
    expect(
      sqlLog.some((s) => s.includes("sqlite_master") && s.includes("type='table'")),
    ).toBe(true);

    // R2 put was called
    expect(mockBucket.put).toHaveBeenCalledTimes(1);
    const putCall = mockBucket.put.mock.calls[0];
    expect(putCall[0]).toMatch(/^backup-\d{4}-\d{2}-\d{2}\.sql$/);
    expect(typeof putCall[1]).toBe("string");

    // SQL content includes CREATE TABLE + INSERT statements
    const sqlContent: string = putCall[1];
    expect(sqlContent).toContain("CREATE TABLE api_credentials");
    expect(sqlContent).toContain("INSERT INTO \"servers\"");
    expect(sqlContent).toContain("PRAGMA foreign_keys = ON");

    // R2 list + delete were called for pruning
    expect(mockBucket.list).toHaveBeenCalledTimes(1);
    expect(mockBucket.delete).toHaveBeenCalledWith("backup-2025-01-01.sql");
  });

  it("does nothing when D1 has no user tables", async () => {
    const { db, sqlLog, setAllResults } = createDB();

    setAllResults([[]]); // empty table list

    const mockBucket = {
      put: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    };

    await handleScheduled("0 0 * * *", testEnv(db, mockBucket as unknown as R2Bucket));

    // sqlite_master was queried
    expect(
      sqlLog.some((s) => s.includes("sqlite_master")),
    ).toBe(true);

    // No R2 operations were performed
    expect(mockBucket.put).not.toHaveBeenCalled();
    expect(mockBucket.list).not.toHaveBeenCalled();
    expect(mockBucket.delete).not.toHaveBeenCalled();
  });
});
