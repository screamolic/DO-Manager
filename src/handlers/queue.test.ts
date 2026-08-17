/**
 * Vitest tests for queue consumer (handleQueue) and pickCredential.
 *
 * Tests run inside @cloudflare/vitest-pool-workers which provides
 * Web-compatible globals (fetch, Response, crypto, etc.).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleQueue,
  pickCredential,
  JOB_SCOPE_MAP,
  buildDORequest,
  parseRateLimitHeaders,
} from "./queue";

/* ------------------------------------------------------------------ */
/*  Module-level mocks — vi.hoisted() ensures shared refs              */
/* ------------------------------------------------------------------ */

const { cryptoMock, doApiMock } = vi.hoisted(() => ({
  cryptoMock: {
    decryptTokenWithFallback: vi
      .fn()
      .mockResolvedValue("do-mock-token-12345"),
    encryptToken: vi
      .fn()
      .mockResolvedValue({ ciphertext: "mock-ciphertext", iv: "mock-iv" }),
  },
  doApiMock: {
    parseDOError: vi.fn().mockResolvedValue("mock DO error"),
  },
}));

vi.mock("../lib/crypto", () => cryptoMock);
vi.mock("../lib/do-api", () => doApiMock);

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Create a mock Message object (cast via `as any` for brevity). */
function createMsg(body: { job_id: number; type: string }) {
  return {
    id: `msg-${body.job_id}-${Date.now()}`,
    timestamp: new Date(),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createBatch(messages: ReturnType<typeof createMsg>[]) {
  return { queue: "do-jobs", messages } as any;
}

/** Tracked mock D1 binding. */
function createDB() {
  const firstFn = vi.fn();
  const runFn = vi.fn().mockResolvedValue({ success: true });
  const allFn = vi.fn().mockResolvedValue({ results: [] });
  const bindFn = vi.fn((..._args: unknown[]) => ({
    first: firstFn,
    run: runFn,
    all: allFn,
  }));
  const prepareFn = vi.fn((_sql: string) => ({ bind: bindFn }));

  return {
    db: { prepare: prepareFn } as unknown as D1Database,
    firstFn,
    runFn,
    allFn,
    bindFn,
    prepareFn,
  };
}

/** Minimal env with mock D1 and encryption keys. */
function testEnv(db: D1Database) {
  return {
    DB: db,
    ENCRYPTION_KEY_V1: "test-v1-base64-key",
    ENCRYPTION_KEY_V2: "test-v2-base64-key",
  };
}

const MOCK_TOKEN = "do-mock-token-12345";

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                  */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  cryptoMock.decryptTokenWithFallback.mockReset();
  cryptoMock.decryptTokenWithFallback.mockResolvedValue(MOCK_TOKEN);

  cryptoMock.encryptToken.mockReset();
  cryptoMock.encryptToken.mockResolvedValue({
    ciphertext: "mock-ciphertext",
    iv: "mock-iv",
  });

  doApiMock.parseDOError.mockReset();
  doApiMock.parseDOError.mockResolvedValue("mock DO error");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  JOB_SCOPE_MAP                                                     */
/* ------------------------------------------------------------------ */

describe("JOB_SCOPE_MAP", () => {
  it("maps create_droplet to write", () => {
    expect(JOB_SCOPE_MAP.create_droplet).toBe("write");
  });
  it("maps resize to write", () => {
    expect(JOB_SCOPE_MAP.resize).toBe("write");
  });
  it("maps snapshot to read", () => {
    expect(JOB_SCOPE_MAP.snapshot).toBe("read");
  });
  it("maps destroy to write", () => {
    expect(JOB_SCOPE_MAP.destroy).toBe("write");
  });
});

/* ------------------------------------------------------------------ */
/*  pickCredential – atomic selection                                  */
/* ------------------------------------------------------------------ */

describe("pickCredential", () => {
  it("uses correct SQL with scope bind", async () => {
    const { db, firstFn, bindFn, prepareFn } = createDB();
    firstFn.mockResolvedValue({
      id: 1,
      token_encrypted: "enc",
      token_iv: "iv",
      key_version: 1,
      requests_remaining: 50,
      window_reset_at: null,
      last_probed_at: null,
    });

    const env = testEnv(db);
    const result = await pickCredential("digitalocean", "write", env);

    expect(result).not.toBeNull();
    expect(result!.credential_id).toBe(1);
    expect(result!.token).toBe(MOCK_TOKEN);

    // SQL must contain scope filter pattern
    const sql = prepareFn.mock.calls[0][0] as string;
    expect(sql).toContain("scopes LIKE");
    expect(sql).toContain("RETURNING *");

    // Scope parameter passed in bind
    expect(bindFn).toHaveBeenCalledWith("digitalocean", "write");
  });

  it("returns null when all credentials exhausted", async () => {
    const { db, firstFn } = createDB();
    firstFn.mockResolvedValue(null);

    const env = testEnv(db);
    const result = await pickCredential("digitalocean", "write", env);

    expect(result).toBeNull();
  });

  it("concurrency — 3 parallel calls get different credentials", async () => {
    const { db, firstFn } = createDB();

    // Return different credentials sequentially
    let callIdx = 0;
    firstFn.mockImplementation(() => {
      const idx = callIdx++;
      if (idx === 0)
        return Promise.resolve({
          id: 101,
          token_encrypted: "e1",
          token_iv: "i1",
          key_version: 1,
          requests_remaining: 100,
          window_reset_at: null,
          last_probed_at: null,
        });
      if (idx === 1)
        return Promise.resolve({
          id: 102,
          token_encrypted: "e2",
          token_iv: "i2",
          key_version: 1,
          requests_remaining: 50,
          window_reset_at: null,
          last_probed_at: null,
        });
      if (idx === 2)
        return Promise.resolve({
          id: 103,
          token_encrypted: "e3",
          token_iv: "i3",
          key_version: 1,
          requests_remaining: 25,
          window_reset_at: null,
          last_probed_at: null,
        });
      return Promise.resolve(null);
    });

    const env = testEnv(db);
    const results = await Promise.all([
      pickCredential("digitalocean", "write", env),
      pickCredential("digitalocean", "write", env),
      pickCredential("digitalocean", "write", env),
    ]);

    const ids = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => r.credential_id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain(101);
    expect(ids).toContain(102);
    expect(ids).toContain(103);
  });

  it("scope filtering — write-scope only used for create_droplet", async () => {
    const { db, firstFn, bindFn } = createDB();
    firstFn.mockResolvedValue({
      id: 42,
      token_encrypted: "enc-write",
      token_iv: "iv",
      key_version: 1,
      requests_remaining: 10,
      window_reset_at: null,
      last_probed_at: null,
    });

    const env = testEnv(db);

    // Call pickCredential with 'write' scope (what create_droplet needs)
    const result = await pickCredential("digitalocean", "write", env);
    expect(result).not.toBeNull();
    expect(result!.credential_id).toBe(42);

    // Verify the bind includes 'write' scope
    const writeCall = bindFn.mock.calls.find((c) => c[1] === "write");
    expect(writeCall).toBeDefined();
    expect(writeCall![0]).toBe("digitalocean");

    // Now call with 'read' scope — verify bind includes 'read'
    firstFn.mockResolvedValue({
      id: 43,
      token_encrypted: "enc-read",
      token_iv: "iv",
      key_version: 1,
      requests_remaining: 10,
      window_reset_at: null,
      last_probed_at: null,
    });
    const readResult = await pickCredential("digitalocean", "read", env);
    expect(readResult).not.toBeNull();
    const readCall = bindFn.mock.calls.find((c) => c[1] === "read");
    expect(readCall).toBeDefined();
    expect(readCall![0]).toBe("digitalocean");
  });
});

/* ------------------------------------------------------------------ */
/*  buildDORequest & parseRateLimitHeaders                             */
/* ------------------------------------------------------------------ */

describe("buildDORequest", () => {
  it("create_droplet forwards payload as body", () => {
    const req = buildDORequest("create_droplet", {
      name: "test",
      region: "nyc3",
    });
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/droplets");
    expect(req.body).toEqual({ name: "test", region: "nyc3" });
  });

  it("resize includes type field", () => {
    const req = buildDORequest("resize", {
      droplet_id: 123,
      size: "s-2vcpu-2gb",
    } as any);
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/droplets/123/actions");
    expect(req.body).toEqual({
      droplet_id: 123,
      size: "s-2vcpu-2gb",
      type: "resize",
    });
  });

  it("snapshot includes type field", () => {
    const req = buildDORequest("snapshot", {
      droplet_id: 456,
      name: "snap-1",
    } as any);
    expect(req.body).toEqual({
      droplet_id: 456,
      name: "snap-1",
      type: "snapshot",
    });
  });

  it("destroy uses DELETE", () => {
    const req = buildDORequest("destroy", { droplet_id: 789 } as any);
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/droplets/789");
    expect(req.body).toBeUndefined();
  });
});

describe("parseRateLimitHeaders", () => {
  it("parses rate limit headers case-insensitively", () => {
    const headers = new Headers({
      "RATELIMIT-REMAINING": "42",
      "RateLimit-Reset": "1712345678",
    });
    const result = parseRateLimitHeaders(headers);
    expect(result.remaining).toBe(42);
    expect(result.reset).toBe(1712345678);
  });

  it("returns null when headers missing", () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const result = parseRateLimitHeaders(headers);
    expect(result.remaining).toBeNull();
    expect(result.reset).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  handleQueue – credential locking, idempotency, rate limits        */
/* ------------------------------------------------------------------ */

describe("handleQueue", () => {
  /** Convenient mock response factory. */
  function mockResponse(
    body: object,
    status: number,
    headers?: Record<string, string>,
  ) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
  }

  beforeEach(() => {
    cryptoMock.decryptTokenWithFallback.mockReset();
    cryptoMock.decryptTokenWithFallback.mockResolvedValue(MOCK_TOKEN);
    cryptoMock.encryptToken.mockReset();
    cryptoMock.encryptToken.mockResolvedValue({
      ciphertext: "enc-pwd",
      iv: "iv-pwd",
    });
  });

  /* ---------- Test 3: credential_id locking for retry ---------- */

  it("credential_id locking — retry uses same credential", async () => {
    const { db, firstFn, prepareFn } = createDB();

    // Job row with credential_id already set (retry scenario)
    firstFn
      .mockResolvedValueOnce({
        id: 1,
        type: "create_droplet",
        status: "processing",
        credential_id: 99,
        idempotency_key: "idem-001",
        payload_json: JSON.stringify({
          name: "retry-test",
          region: "nyc3",
          size: "s-1vcpu-1gb",
          image: "ubuntu-22-04",
        }),
        attempts: 1,
        error_log: null,
        next_retry_at: null,
      })
      // credential lookup (retry path reads from api_credentials)
      .mockResolvedValueOnce({
        id: 99,
        token_encrypted: "enc-retry",
        token_iv: "iv-retry",
        key_version: 1,
      });

    // Mock fetch → success
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        mockResponse(
          {
            droplet: {
              id: 1001,
              name: "retry-test",
              region: { slug: "nyc3" },
              size: { slug: "s-1vcpu-1gb" },
              networks: { v4: [{ ip_address: "1.2.3.4", type: "public" }] },
              tags: ["test"],
              password: "root-pwd-123",
            },
          },
          201,
          { "ratelimit-remaining": "4999" },
        ),
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const env = testEnv(db);
    const msg = createMsg({ job_id: 1, type: "create_droplet" });
    const batch = createBatch([msg]);

    await handleQueue(batch, env, {} as any);

    // 1) First D1 call reads job_queue row, NOT pickCredential
    const firstSQL = prepareFn.mock.calls[0][0] as string;
    expect(firstSQL).toContain("SELECT * FROM job_queue");

    // 2) Second D1 call reads api_credentials (retrieving the locked credential)
    const secondSQL = prepareFn.mock.calls[1][0] as string;
    expect(secondSQL).toContain("SELECT token_encrypted");
    expect(secondSQL).toContain("FROM api_credentials");
    expect(secondSQL).toContain("WHERE id = ?");

    // 3) Verify pickCredential SQL was NEVER called (no UPDATE api_credentials)
    const allPrepareCalls = prepareFn.mock.calls.map(
      (c: any) => c[0] as string,
    );
    const pickCredSQL = allPrepareCalls.find(
      (sql: string) =>
        sql.includes("UPDATE api_credentials") && sql.includes("RETURNING *"),
    );
    expect(pickCredSQL).toBeUndefined();

    // 4) DO API call included Idempotency-Key header
    const fetchCall = mockFetch.mock.calls[0];
    const reqHeaders = fetchCall[1].headers as Record<string, string>;
    expect(reqHeaders["Idempotency-Key"]).toBe("idem-001");

    // 5) Server was inserted (create_droplet succeeded)
    const insertCalls = prepareFn.mock.calls.filter(
      (c: any) =>
        typeof c[0] === "string" && c[0].includes("INSERT INTO servers"),
    );
    expect(insertCalls.length).toBe(1);

    // 6) Job marked done
    const doneCall = prepareFn.mock.calls.find(
      (c: any) =>
        typeof c[0] === "string" && c[0].includes("status = 'done'"),
    );
    expect(doneCall).toBeDefined();

    // 7) message.ack() called
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  /* ---------- Test 4: Idempotency key in DO API header ---------- */

  it("idempotency — DO API call includes Idempotency-Key header", async () => {
    const { db, firstFn } = createDB();

    // Job with idempotency_key and NO credential_id (first attempt)
    firstFn
      .mockResolvedValueOnce({
        id: 2,
        type: "snapshot",
        status: "pending",
        credential_id: null,
        idempotency_key: "idem-002",
        payload_json: JSON.stringify({
          droplet_id: 500,
          name: "snap-weekly",
        }),
        attempts: 0,
        error_log: null,
        next_retry_at: null,
      })
      // pickCredential returns a credential
      .mockResolvedValueOnce({
        id: 201,
        token_encrypted: "enc-snap",
        token_iv: "iv-snap",
        key_version: 1,
        requests_remaining: 100,
        window_reset_at: null,
        last_probed_at: null,
      });

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        mockResponse({ action: { id: 9001 } }, 201, {
          "ratelimit-remaining": "4998",
        }),
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const env = testEnv(db);
    const msg = createMsg({ job_id: 2, type: "snapshot" });
    const batch = createBatch([msg]);

    await handleQueue(batch, env, {} as any);

    // Verify fetch headers include Idempotency-Key
    const fetchCall = mockFetch.mock.calls[0];
    const reqHeaders = fetchCall[1].headers as Record<string, string>;
    expect(reqHeaders["Idempotency-Key"]).toBe("idem-002");

    // Verify ack was called (success path)
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  /* ---------- Test 5: Rate limit handling (429) ---------- */

  it("rate limit — 429 inserts rate_limit_events and calls retry with backoff", async () => {
    const { db, firstFn, prepareFn } = createDB();

    firstFn
      .mockResolvedValueOnce({
        id: 3,
        type: "resize",
        status: "pending",
        credential_id: 301,
        idempotency_key: "idem-003",
        payload_json: JSON.stringify({
          droplet_id: 700,
          size: "s-2vcpu-2gb",
          disk: true,
        }),
        attempts: 0,
        error_log: null,
        next_retry_at: null,
      })
      // credential lookup (retry path because credential_id is already set)
      .mockResolvedValueOnce({
        id: 301,
        token_encrypted: "enc-resize",
        token_iv: "iv-resize",
        key_version: 1,
      });

    // Fetch returns 429
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: {
            "ratelimit-remaining": "0",
            "ratelimit-reset": "1712345678",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const env = testEnv(db);
    const msg = createMsg({ job_id: 3, type: "resize" });
    const batch = createBatch([msg]);

    await handleQueue(batch, env, {} as any);

    // 1) rate_limit_events was inserted
    const rateLimitInsert = prepareFn.mock.calls.find(
      (c: any) =>
        typeof c[0] === "string" &&
        c[0].includes("INSERT INTO rate_limit_events"),
    );
    expect(rateLimitInsert).toBeDefined();

    // 2) api_credentials.requests_remaining set to 0
    const credUpdate = prepareFn.mock.calls.find(
      (c: any) =>
        typeof c[0] === "string" &&
        c[0].includes("UPDATE api_credentials") &&
        c[0].includes("requests_remaining = 0"),
    );
    expect(credUpdate).toBeDefined();

    // 3) job_queue next_retry_at updated with backoff
    const retryUpdate = prepareFn.mock.calls.find(
      (c: any) =>
        typeof c[0] === "string" &&
        c[0].includes("UPDATE job_queue") &&
        c[0].includes("next_retry_at"),
    );
    expect(retryUpdate).toBeDefined();

    // 4) message.retry() called with delaySeconds (30 for first attempt)
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  /* ---------- Missing credential exposes correct error ---------- */

  it("no credential available — job set to failed", async () => {
    const { db, firstFn, prepareFn, bindFn } = createDB();

    // Job row with no credential_id
    firstFn.mockResolvedValueOnce({
      id: 4,
      type: "destroy",
      status: "pending",
      credential_id: null,
      idempotency_key: "idem-004",
      payload_json: JSON.stringify({ droplet_id: 999 }),
      attempts: 0,
      error_log: null,
      next_retry_at: null,
    });

    // pickCredential returns null (all tokens exhausted)
    firstFn.mockResolvedValueOnce(null);

    const env = testEnv(db);
    const msg = createMsg({ job_id: 4, type: "destroy" });
    const batch = createBatch([msg]);

    await handleQueue(batch, env, {} as any);

    // Job should be marked as failed
    const failUpdate = prepareFn.mock.calls.find(
      (c: any) =>
        typeof c[0] === "string" && c[0].includes("status = 'failed'"),
    );
    expect(failUpdate).toBeDefined();

    // error_log bind should mention missing credentials
    const errorBind = bindFn.mock.calls.find(
      (args: any[]) =>
        typeof args[0] === "string" &&
        args[0].includes("No available credentials"),
    );
    expect(errorBind).toBeDefined();

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  /* ---------- 3rd attempt fails — job goes to failed ---------- */

  it("max retries exceeded — job set to failed after 3rd error", async () => {
    const { db, firstFn, prepareFn } = createDB();

    // Job on 3rd attempt with credential_id
    firstFn
      .mockResolvedValueOnce({
        id: 5,
        type: "resize",
        status: "processing",
        credential_id: 501,
        idempotency_key: "idem-005",
        payload_json: JSON.stringify({ droplet_id: 800 }),
        attempts: 2,
        error_log: null,
        next_retry_at: null,
      })
      .mockResolvedValueOnce({
        id: 501,
        token_encrypted: "enc-final",
        token_iv: "iv-final",
        key_version: 1,
      });

    doApiMock.parseDOError.mockResolvedValue("Droplet not found");

    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "not_found",
            message: "Droplet not found",
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const env = testEnv(db);
    const msg = createMsg({ job_id: 5, type: "resize" });
    const batch = createBatch([msg]);

    await handleQueue(batch, env, {} as any);

    // Job should be set to failed
    const failUpdate = prepareFn.mock.calls.find(
      (c: any) =>
        typeof c[0] === "string" &&
        c[0].includes("status = 'failed'") &&
        c[0].includes("attempts = ?"),
    );
    expect(failUpdate).toBeDefined();

    // parseDOError was called
    expect(doApiMock.parseDOError).toHaveBeenCalled();

    // Job acked (not retried — max retries reached)
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  /* ---------- Case-insensitive header parsing (integration) ---------- */

  it("parses UPPERCASE rate limit headers via handleQueue", async () => {
    const { db, firstFn } = createDB();

    firstFn
      .mockResolvedValueOnce({
        id: 6,
        type: "create_droplet",
        status: "pending",
        credential_id: 601,
        idempotency_key: "idem-006",
        payload_json: JSON.stringify({ name: "case-test", region: "nyc3" }),
        attempts: 0,
        error_log: null,
        next_retry_at: null,
      })
      .mockResolvedValueOnce({
        id: 601,
        token_encrypted: "enc-case",
        token_iv: "iv-case",
        key_version: 1,
      });

    // UPPERCASE headers
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        mockResponse(
          {
            droplet: {
              id: 2002,
              name: "case-test",
              region: { slug: "nyc3" },
              size: { slug: "s-1vcpu-1gb" },
              networks: { v4: [{ ip_address: "10.0.0.1", type: "public" }] },
              tags: [],
            },
          },
          201,
          { "RATELIMIT-REMAINING": "4995", "RATELIMIT-RESET": "1712349999" },
        ),
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const env = testEnv(db);
    const msg = createMsg({ job_id: 6, type: "create_droplet" });
    const batch = createBatch([msg]);

    await handleQueue(batch, env, {} as any);

    // Should succeed with uppercase headers
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });
});
