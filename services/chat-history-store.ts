/** Persist chat transcript as JSON next to `aa-user-settings.json` under Electron `userData` (macOS/Windows/Linux). */

import fs from "node:fs";
import path from "node:path";

let storeUserDataDir: string | null = null;

function aaRootFromCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

export function initializeChatHistoryStore(opts?: { userDataDir?: string }): void {
  storeUserDataDir = opts?.userDataDir?.trim() ? opts.userDataDir : null;
}

export function getChatHistoryFilePath(): string {
  if (storeUserDataDir) {
    return path.join(storeUserDataDir, "aa-chat-history.json");
  }
  return path.join(aaRootFromCwd(), "aa-chat-history.json");
}

export type ChatHistoryUsageMeta = {
  wallMs: number;
  total_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens?: number;
  msPerToken: number | null;
  system_fingerprint?: string;
};

export type ChatHistoryAttachment = {
  name: string;
  kind: "image" | "audio" | "file";
  thumbnailDataUrl?: string;
  /** Absolute path under userData/chat-attachments (survives restarts; STT can re-read). */
  savedPath?: string;
};

/** Assistant message: in-memory TTS WAV as data URL (same cap as persist). */
export type ChatHistoryTtsClip = {
  dataUrl: string;
};

export type ChatHistoryRow = {
  role: string;
  content: string;
  /** Wall-clock ms when row was created (renderer); shown in Chat tab header. */
  atMs?: number;
  reasoning?: string;
  agentTrace?: string;
  usageMeta?: ChatHistoryUsageMeta;
  /** Persisted from renderer when assistant row is an HTTP/agent failure bubble. */
  errReply?: boolean;
  /** User bubble attachment chips (image thumbnails as data URLs). */
  displayAttachments?: ChatHistoryAttachment[];
  /** Agent `tts` tool output: WAV data URLs for replay after restart. */
  agentTtsClips?: ChatHistoryTtsClip[];
  /** Where the row originated: main Chat UI, Telegram bridge, or scheduled job. */
  source?: "app" | "telegram" | "scheduler";
  /** Telegram thread id — only set for merged mirror rows from `aa-telegram-chats` (not persisted in app history). */
  telegramChatId?: number;
};

const MAX_ROWS = 500;
const MAX_FIELD = 2_000_000;
/** Max length per persisted on-disk attachment path string. */
const MAX_SAVED_PATH_CHARS = 16_384;
/** Max length per persisted `data:` thumbnail (~2.5 MB ASCII). */
const MAX_THUMB_DATA_URL = 2_500_000;
/** Max length per TTS WAV data URL (base64); drops clip if larger. */
const MAX_TTS_CLIP_DATA_URL = 6_000_000;
const MAX_TTS_CLIPS_PER_ROW = 8;

function clampStr(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeRow(raw: unknown): ChatHistoryRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const role = typeof o.role === "string" ? o.role.trim().toLowerCase() : "";
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const content = clampStr(o.content, MAX_FIELD);
  const row: ChatHistoryRow = { role, content };
  if (typeof o.atMs === "number" && Number.isFinite(o.atMs)) {
    row.atMs = Math.floor(o.atMs);
  }
  if (typeof o.reasoning === "string" && o.reasoning.length) {
    row.reasoning = clampStr(o.reasoning, MAX_FIELD);
  }
  if (typeof o.agentTrace === "string" && o.agentTrace.length) {
    row.agentTrace = clampStr(o.agentTrace, MAX_FIELD);
  }
  if (o.usageMeta && typeof o.usageMeta === "object") {
    const u = o.usageMeta as Record<string, unknown>;
    const wallMs = typeof u.wallMs === "number" && Number.isFinite(u.wallMs) ? u.wallMs : 0;
    const prompt_tokens =
      u.prompt_tokens !== undefined && typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens)
        ? Math.floor(u.prompt_tokens)
        : null;
    const completion_tokens =
      u.completion_tokens !== undefined && typeof u.completion_tokens === "number" && Number.isFinite(u.completion_tokens)
        ? Math.floor(u.completion_tokens)
        : null;
    const total_tokens =
      u.total_tokens !== undefined && typeof u.total_tokens === "number" && Number.isFinite(u.total_tokens)
        ? Math.floor(u.total_tokens)
        : null;
    let reasoning_tokens: number | undefined;
    if (u.reasoning_tokens !== undefined && typeof u.reasoning_tokens === "number" && Number.isFinite(u.reasoning_tokens)) {
      reasoning_tokens = Math.floor(u.reasoning_tokens);
    }
    let msPerToken: number | null = null;
    if (u.msPerToken !== undefined && typeof u.msPerToken === "number" && Number.isFinite(u.msPerToken)) {
      msPerToken = u.msPerToken;
    }
    const meta: ChatHistoryUsageMeta = {
      wallMs,
      total_tokens,
      prompt_tokens,
      completion_tokens,
      msPerToken,
    };
    if (reasoning_tokens !== undefined) meta.reasoning_tokens = reasoning_tokens;
    if (typeof u.system_fingerprint === "string" && u.system_fingerprint.length) {
      meta.system_fingerprint = u.system_fingerprint.length > 256 ? u.system_fingerprint.slice(0, 256) : u.system_fingerprint;
    }
    row.usageMeta = meta;
  }
  if (o.errReply === true) {
    row.errReply = true;
  }
  const src = o.source;
  if (src === "app" || src === "telegram" || src === "scheduler") {
    row.source = src;
  }
  if (o.telegramChatId !== undefined && typeof o.telegramChatId === "number" && Number.isFinite(o.telegramChatId)) {
    row.telegramChatId = Math.floor(o.telegramChatId);
  }
  if (Array.isArray(o.displayAttachments)) {
    const list: ChatHistoryAttachment[] = [];
    for (const raw of o.displayAttachments) {
      if (!raw || typeof raw !== "object") continue;
      const ao = raw as Record<string, unknown>;
      const name = typeof ao.name === "string" ? ao.name.trim() : "";
      const k = ao.kind;
      const kind: ChatHistoryAttachment["kind"] =
        k === "audio" ? "audio" : k === "file" ? "file" : "image";
      if (!name) continue;
      const att: ChatHistoryAttachment = { name, kind };
      const thumb = ao.thumbnailDataUrl;
      if (typeof thumb === "string" && thumb.startsWith("data:") && thumb.length <= MAX_THUMB_DATA_URL) {
        att.thumbnailDataUrl = thumb;
      }
      const sp = ao.savedPath;
      if (typeof sp === "string" && sp.length > 0 && sp.length <= MAX_SAVED_PATH_CHARS) {
        att.savedPath = sp;
      }
      list.push(att);
    }
    if (list.length) {
      row.displayAttachments = list;
    }
  }
  if (Array.isArray(o.agentTtsClips)) {
    const clips: ChatHistoryTtsClip[] = [];
    for (const raw of o.agentTtsClips) {
      if (clips.length >= MAX_TTS_CLIPS_PER_ROW) {
        break;
      }
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const co = raw as Record<string, unknown>;
      const dataUrl = typeof co.dataUrl === "string" ? co.dataUrl : "";
      if (!dataUrl.startsWith("data:audio/") || dataUrl.length > MAX_TTS_CLIP_DATA_URL) {
        continue;
      }
      clips.push({ dataUrl });
    }
    if (clips.length) {
      row.agentTtsClips = clips;
    }
  }
  return row;
}

export function readChatHistory(): ChatHistoryRow[] {
  const p = getChatHistoryFilePath();
  let raw: unknown;
  try {
    const text = fs.readFileSync(p, "utf8");
    raw = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ChatHistoryRow[] = [];
  for (const item of raw) {
    const row = normalizeRow(item);
    if (row) out.push(row);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

export function writeChatHistory(rows: unknown[]): void {
  const p = getChatHistoryFilePath();
  const safe = (Array.isArray(rows) ? rows : [])
    .slice(-MAX_ROWS)
    .map((r) => normalizeRow(r))
    .filter((x): x is ChatHistoryRow => x !== null);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}
