/** Per-Telegram-chat transcript for agent context — JSON under Electron userData. */

import fs from "node:fs";
import path from "node:path";

import type { ChatMessage } from "./llm.js";
import {
  TELEGRAM_HISTORY_MAX_MESSAGES,
  TELEGRAM_HISTORY_MAX_MESSAGE_CHARS,
} from "../config/telegram_config.js";

let storeUserDataDir: string | null = null;

export function initializeTelegramHistoryStore(opts?: { userDataDir?: string }): void {
  storeUserDataDir = opts?.userDataDir?.trim() ? opts.userDataDir : null;
}

export type TelegramHistorySource = "telegram";

export type TelegramHistoryRow = {
  role: "user" | "assistant";
  content: string;
  /** Always `telegram` for this store; present for unified export / tooling. */
  source: TelegramHistorySource;
};

function baseDir(): string {
  if (storeUserDataDir) {
    return path.join(storeUserDataDir, "aa-telegram-chats");
  }
  return path.join(process.cwd(), "aa-telegram-chats");
}

function chatPath(chatId: number): string {
  return path.join(baseDir(), `${chatId}.json`);
}

function clampContent(s: string): string {
  if (s.length <= TELEGRAM_HISTORY_MAX_MESSAGE_CHARS) {
    return s;
  }
  return `${s.slice(0, TELEGRAM_HISTORY_MAX_MESSAGE_CHARS)}\n\n…[truncated]`;
}

function normalizeMessages(raw: unknown): TelegramHistoryRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TelegramHistoryRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const role = typeof o.role === "string" ? o.role.trim().toLowerCase() : "";
    if (role !== "user" && role !== "assistant") continue;
    const content = typeof o.content === "string" ? o.content : "";
    out.push({
      role: role as "user" | "assistant",
      content: clampContent(content),
      source: "telegram",
    });
  }
  return out.slice(-TELEGRAM_HISTORY_MAX_MESSAGES);
}

/** Rows on disk (includes `source`). */
export function readTelegramHistoryRows(chatId: number): TelegramHistoryRow[] {
  const p = chatPath(chatId);
  try {
    const text = fs.readFileSync(p, "utf8");
    return normalizeMessages(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

/** Messages for LLM (role + content only). */
export function readTelegramChatMessages(chatId: number): ChatMessage[] {
  return readTelegramHistoryRows(chatId).map((r) => ({ role: r.role, content: r.content }));
}

export function appendTelegramMessages(chatId: number, rows: ChatMessage[]): void {
  const cur = readTelegramHistoryRows(chatId);
  const tagged: TelegramHistoryRow[] = rows.map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    content: clampContent(r.content),
    source: "telegram",
  }));
  const next = normalizeMessages([...cur, ...tagged]);
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(chatPath(chatId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
