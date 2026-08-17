/**
 * Helpers for interacting with the DigitalOcean API.
 */

/**
 * Extract a human-readable error message from a DO API error response.
 *
 * Handles three error shapes:
 * - `{"id": "unprocessable_entity", "message": "..."}` → returns `message`
 * - `{"errors": [{"detail": "..."}]}` → returns `errors[0].detail`
 * - Plain text body → returns trimmed string
 */
export async function parseDOError(response: Response): Promise<string> {
  const cloned = response.clone();

  try {
    const body = (await cloned.json()) as Record<string, unknown>;

    if (
      body &&
      typeof body === "object" &&
      "id" in body &&
      body.id === "unprocessable_entity" &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }

    if (
      body &&
      typeof body === "object" &&
      "errors" in body &&
      Array.isArray(body.errors) &&
      body.errors.length > 0
    ) {
      const first = body.errors[0] as Record<string, unknown> | undefined;
      if (first && typeof first.detail === "string") {
        return first.detail;
      }
    }

    return JSON.stringify(body);
  } catch {
    const text = await cloned.text();
    return text.trim();
  }
}
