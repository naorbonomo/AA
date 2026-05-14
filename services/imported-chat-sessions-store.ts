/** Persist imported ChatGPT transcripts for History tab (`aa-imported-chat-sessions.json` under userData). */

import fs from "node:fs";
import path from "node:path";

import type { ChatHistoryRow } from "./chat-history-store.js";
import { parseChatHistoryRowLossless } from "./chat-history-store.js";
import type { ParsedChatgptConversation } from "./chatgpt-export-parse.js";

let storeUserDataDir: string | null = null;

const FILE = "aa-imported-chat-sessions.json";
const MAX_ROWS_PER_SESSION = 50_000;
const MAX_FIELD = 2_000_000;

export type ImportedChatSessionRecord = {
  conversationId: string;
  source: "chatgpt";
  sessionLabel: string;
  importedAtMs: number;
  rows: ChatHistoryRow[];
};

type FileShapeV1 = {
  v: 1;
  sessions: ImportedChatSessionRecord[];
};

function aaRootFromCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

export function initializeImportedChatSessionsStore(opts?: { userDataDir?: string }): void {
  storeUserDataDir = opts?.userDataDir?.trim() ? opts.userDataDir : null;
}

export function getImportedChatSessionsFilePath(): string {
  if (storeUserDataDir) {
    return path.join(storeUserDataDir, FILE);
  }
  return path.join(aaRootFromCwd(), FILE);
}

function clampStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function sanitizeRow(raw: unknown): ChatHistoryRow | null {
  const round = parseChatHistoryRowLossless(raw);
  if (!round) return null;
  const row: ChatHistoryRow = {
    ...round,
    content: clampStr(round.content, MAX_FIELD),
  };
  if (round.reasoning) row.reasoning = clampStr(round.reasoning, MAX_FIELD);
  if (round.agentTrace) row.agentTrace = clampStr(round.agentTrace, MAX_FIELD);
  return row;
}

function readFileShape(): FileShapeV1 {
  const fp = getImportedChatSessionsFilePath();
  try {
    const text = fs.readFileSync(fp, "utf8");
    const o = JSON.parse(text) as unknown;
    if (!o || typeof o !== "object") return { v: 1, sessions: [] };
    const rec = o as Record<string, unknown>;
    if (rec.v !== 1 || !Array.isArray(rec.sessions)) return { v: 1, sessions: [] };
    const sessions: ImportedChatSessionRecord[] = [];
    for (const s of rec.sessions) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      const conversationId = typeof so.conversationId === "string" ? so.conversationId.trim() : "";
      const source = so.source;
      const sessionLabel = typeof so.sessionLabel === "string" ? so.sessionLabel : "";
      const importedAtMs =
        typeof so.importedAtMs === "number" && Number.isFinite(so.importedAtMs)
          ? Math.floor(so.importedAtMs)
          : 0;
      if (!conversationId || source !== "chatgpt") continue;
      const rowsIn = Array.isArray(so.rows) ? so.rows : [];
      const rows: ChatHistoryRow[] = [];
      for (const raw of rowsIn) {
        if (!raw || typeof raw !== "object") continue;
        const sr = sanitizeRow(raw);
        if (sr) rows.push(sr);
      }
      if (!rows.length) continue;
      sessions.push({
        conversationId,
        source: "chatgpt",
        sessionLabel: sessionLabel.trim() || "Imported",
        importedAtMs,
        rows: rows.slice(0, MAX_ROWS_PER_SESSION),
      });
    }
    return { v: 1, sessions };
  } catch {
    return { v: 1, sessions: [] };
  }
}

function writeFileShape(shape: FileShapeV1): void {
  const fp = getImportedChatSessionsFilePath();
  const dir = path.dirname(fp);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  fs.writeFileSync(fp, JSON.stringify(shape), "utf8");
}

/** Newest imports first. */
export function readImportedChatSessionsLossless(): ImportedChatSessionRecord[] {
  const { sessions } = readFileShape();
  return [...sessions].sort((a, b) => b.importedAtMs - a.importedAtMs);
}

/**
 * Upsert by `conversationId` (re-import replaces transcript + bumps `importedAtMs`).
 * Skips conversations with no rows.
 */
export function mergeChatgptImportSessions(items: ParsedChatgptConversation[]): void {
  if (!items.length) return;
  const cur = readFileShape();
  const map = new Map(cur.sessions.map((s) => [s.conversationId, s]));
  const now = Date.now();
  for (const it of items) {
    if (!it.rows.length) continue;
    const rows: ChatHistoryRow[] = [];
    for (const raw of it.rows) {
      const sr = sanitizeRow(raw);
      if (sr) rows.push(sr);
    }
    if (!rows.length) continue;
    map.set(it.conversationId, {
      conversationId: it.conversationId,
      source: "chatgpt",
      sessionLabel: it.sessionLabel.trim() || "Imported",
      importedAtMs: now,
      rows: rows.slice(0, MAX_ROWS_PER_SESSION),
    });
  }
  const sessions = [...map.values()].sort((a, b) => b.importedAtMs - a.importedAtMs);
  writeFileShape({ v: 1, sessions });
}
