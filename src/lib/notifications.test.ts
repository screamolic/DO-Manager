/**
 * Vitest tests for notification helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendTelegram } from "./notifications";

describe("sendTelegram", () => {
  const mockToken = "TEST_TOKEN";
  const mockEnv = {
    TELEGRAM_BOT_TOKEN: mockToken,
    TELEGRAM_CHAT_ID: "-1001234567890",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls fetch with correct URL, method, headers, and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegram("Hello world", mockEnv);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botTEST_TOKEN/sendMessage",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: "-1001234567890",
          text: "Hello world",
          parse_mode: "Markdown",
        }),
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("returns { ok: true } on 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: true })),
    );
    const result = await sendTelegram("test", mockEnv);
    expect(result).toEqual({ ok: true });
  });

  it("returns { ok: false } when Telegram API returns error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ ok: false, description: "error" }),
      ),
    );
    const result = await sendTelegram("test", mockEnv);
    expect(result).toEqual({ ok: false, description: "error" });
  });

  it("returns { ok: false, description } when TELEGRAM_BOT_TOKEN is missing", async () => {
    const result = await sendTelegram("test", {
      ...mockEnv,
      TELEGRAM_BOT_TOKEN: undefined,
    });
    expect(result).toEqual({
      ok: false,
      description: "TELEGRAM_BOT_TOKEN not configured",
    });
  });

  it("rejects on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network failure")),
    );
    await expect(sendTelegram("test", mockEnv)).rejects.toThrow(
      "Network failure",
    );
  });
});
