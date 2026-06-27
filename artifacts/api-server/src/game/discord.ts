/**
 * Discord webhook notifier for the Carrier game server.
 *
 * Fire-and-forget, server-only side effect: it posts short event messages to a
 * Discord channel via an incoming webhook.  It is intentionally isolated from
 * the authoritative, deterministic simulation — nothing here ever blocks the
 * game loop, throws into it, or influences sim state.  The webhook URL is read
 * once from the `carry_discord_webhook` secret; if it is absent every call is a
 * silent no-op so local/dev runs without the secret behave normally.
 */
import { logger } from "../lib/logger";

const WEBHOOK_URL = process.env.carry_discord_webhook?.trim() ?? "";

/** True when a webhook is configured (so callers can skip building messages). */
export const discordEnabled = WEBHOOK_URL.length > 0;

/**
 * Post a plain message to the configured Discord channel.  Never awaited by the
 * caller, never throws: any failure is logged and swallowed so a flaky webhook
 * can never stall or crash the 30Hz game loop.
 */
export function postDiscord(content: string): void {
  if (!discordEnabled) return;
  const body = content.slice(0, 1900); // stay well under Discord's 2000-char cap
  void fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Carrier Command",
      content: body,
      // Suppress role/everyone pings from any user-supplied callsign text.
      allowed_mentions: { parse: [] },
    }),
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn({ status: res.status }, "discord webhook returned non-2xx");
      }
    })
    .catch((err: unknown) => {
      logger.warn({ err }, "discord webhook post failed");
    });
}
