/**
 * Notification helpers for DO Manager.
 *
 * Sends Telegram messages via the Telegram Bot API directly.
 */

export interface TelegramEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

/**
 * Send a message to Telegram via the Bot API.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, description }` if the
 * bot token is missing or the API returns an error.  Throws on network errors
 * — the caller should catch and handle those.
 */
export async function sendTelegram(
  message: string,
  env: TelegramEnv,
): Promise<{ ok: boolean; description?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: "TELEGRAM_BOT_TOKEN not configured" };

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    },
  );

  // Telegram Bot API always returns JSON: { ok: boolean, description?: string }
  const body = await response.json<{ ok: boolean; description?: string }>();
  return body;
}
