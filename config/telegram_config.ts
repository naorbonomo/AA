/** Telegram Bot API tuning — mirrors Smith `telegram_config.py` where applicable. */

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Max updates stored for webhook dedupe (file-backed). */
export const TELEGRAM_DEDUPE_MAX_IDS = 8000;

/** Last N user/assistant turns passed into agent (excludes system). */
export const TELEGRAM_HISTORY_MAX_MESSAGES = 24;

/** Cap one message body when building agent context. */
export const TELEGRAM_HISTORY_MAX_MESSAGE_CHARS = 12_000;

/** Outgoing text chunk size (Telegram hard limit 4096). */
export const TELEGRAM_MAX_MESSAGE_CHARS = 3900;

export const TELEGRAM_GETUPDATES_TIMEOUT_SEC = 30;
export const TELEGRAM_GETUPDATES_HTTP_TIMEOUT_MS = 35_000;
export const TELEGRAM_GETUPDATES_ERROR_RETRY_MS = 5000;

/**
 * Cap one inbound user message → agent → `sendMessage` chain. If LLM/tool loop hangs, queue for
 * this `chat_id` used to block forever while scheduler still used `sendMessage` (one-way alerts).
 */
export const TELEGRAM_AGENT_REPLY_TIMEOUT_MS = 600_000;
