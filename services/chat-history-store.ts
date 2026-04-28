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

export type ChatHistoryRow = {
  role: string;
  content: string;
  reasoning?: string;
  agentTrace?: string;
  usageMeta?: ChatHistoryUsageMeta;
};

const MAX_ROWS = 500;
const MAX_FIELD = 2_000_000;

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
