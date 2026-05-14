/**
 * Claude web export (Settings → Privacy → Export data) → `conversations.json`:
 * - Root: JSON array of conversations (or wrapper — see `normalizeClaudeExportRoot`).
 * - Each conversation: `uuid`, `name?`, `chat_messages[]`.
 * - Each message: `sender` ("human" | "assistant"), `text?`, `content[]?` (blocks with `type`:
 *   `text`, `thinking`, `tool_use`, `tool_result`, `token_budget`, …).
 * - Timestamps: ISO strings on `created_at` / `updated_at`.
 *
 * Ref: Anthropic data export; field layout cross-checked with community mappings (e.g. portable-ai-memory.org/providers/anthropic).
 */

import type { ChatHistoryRow } from "./chat-history-store.js";

const WRONG_FILE_HINT =
  "Unzip Claude export and pick **conversations.json** (Claude → Settings → Privacy → Export data). Other files (memories.json, projects.json, users.json) are not chat threads.";

function parseIsoMs(iso: unknown): number | undefined {
  if (typeof iso !== "string" || !iso.trim()) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function losslessUnknown(x: unknown): string {
  if (typeof x === "string") return x;
  return JSON.stringify(x);
}

/** Structured `content[]` block → lossy text (preserves nested JSON for tool/knowledge). */
function blockToText(block: Record<string, unknown>): string {
  const t = block.type;
  if (t === "text" && typeof block.text === "string") return block.text;
  if (t === "thinking") {
    if (typeof block.thinking === "string") return block.thinking;
    if (Array.isArray(block.summaries)) return block.summaries.map(losslessUnknown).join("\n");
    return JSON.stringify(block);
  }
  if (t === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "?";
    return `[tool_use ${name}]\n${JSON.stringify(block.input ?? null)}`;
  }
  if (t === "tool_result") {
    const bits: string[] = [];
    if (block.is_error === true) bits.push("(error)");
    if (Array.isArray(block.content)) {
      for (const c of block.content) {
        if (c && typeof c === "object" && !Array.isArray(c)) {
          bits.push(blockToText(c as Record<string, unknown>));
        } else {
          bits.push(losslessUnknown(c));
        }
      }
    }
    const head =
      typeof block.name === "string"
        ? `[tool_result ${block.name}]`
        : `[tool_result]`;
    return bits.length ? `${head}\n${bits.join("\n")}` : head;
  }
  if (t === "token_budget") return "";
  if (t === "knowledge" && typeof block.title === "string") {
    const url = typeof block.url === "string" ? block.url : "";
    return `[knowledge] ${block.title}${url ? ` ${url}` : ""}`;
  }
  return JSON.stringify(block);
}

function messageBodyLossless(msg: Record<string, unknown>): string {
  const chunks: string[] = [];
  const text = msg.text;
  if (typeof text === "string" && text.length) chunks.push(text);
  const arr = msg.content;
  if (Array.isArray(arr) && arr.length) {
    const parts: string[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        parts.push(losslessUnknown(raw));
        continue;
      }
      const s = blockToText(raw as Record<string, unknown>);
      if (s.length) parts.push(s);
    }
    if (parts.length) {
      if (chunks.length) chunks.push("\n\n--- claude content[] ---\n");
      chunks.push(parts.join("\n\n"));
    }
  }
  return chunks.join("");
}

function senderToRowRole(sender: unknown): "user" | "assistant" | "system" {
  if (sender === "human" || sender === "user") return "user";
  if (sender === "assistant") return "assistant";
  return "system";
}

function isClaudeConversationRecord(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.chat_messages)) return false;
  if (typeof r.uuid === "string" && r.uuid.trim()) return true;
  return r.chat_messages.length > 0;
}

/**
 * Accept official **conversations.json** (root = array) plus common wrappers.
 */
export function normalizeClaudeExportRoot(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    const objs = raw.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x)) as Record<
      string,
      unknown
    >[];
    const convs = objs.filter(isClaudeConversationRecord);
    if (convs.length > 0) return convs;
    if (objs.length === 0) return [];
    throw new Error(`JSON array has no Claude-style objects (\`uuid\` + \`chat_messages[]\`). ${WRONG_FILE_HINT}`);
  }

  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.conversations)) {
      return normalizeClaudeExportRoot(o.conversations);
    }
    const namedArrays = ["data", "items", "chats", "history", "threads", "export"] as const;
    for (const k of namedArrays) {
      const v = o[k];
      if (Array.isArray(v)) {
        try {
          const inner = normalizeClaudeExportRoot(v);
          if (inner.length > 0) return inner;
        } catch {
          /* try next */
        }
      }
    }
    if (isClaudeConversationRecord(o)) return [o];
  }

  throw new Error(`Unrecognized Claude export shape. ${WRONG_FILE_HINT}`);
}

export function claudeConversationToRows(conv: Record<string, unknown>): ChatHistoryRow[] {
  const messages = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
  const rows: ChatHistoryRow[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const msg = raw as Record<string, unknown>;
    const body = messageBodyLossless(msg);
    if (!body.trim()) continue;
    const role = senderToRowRole(msg.sender);
    const atMs = parseIsoMs(msg.created_at) ?? parseIsoMs(msg.updated_at);
    const row: ChatHistoryRow = { role, content: body };
    if (atMs !== undefined) row.atMs = atMs;
    rows.push(row);
  }
  return rows;
}

export type ParsedClaudeConversation = {
  conversationId: string;
  sessionLabel: string;
  rows: ChatHistoryRow[];
};

function safeConversationId(conv: Record<string, unknown>, index: number): string {
  const id = conv.uuid;
  if (typeof id === "string" && id.trim()) return `claude:${id.trim()}`;
  const name = typeof conv.name === "string" ? conv.name : "Untitled";
  const slug = name.replace(/\s+/g, " ").trim().slice(0, 120) || "untitled";
  const safe = slug.replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 80) || "untitled";
  const ct = parseIsoMs(conv.created_at) ?? index;
  return `claude:${safe}:${ct}`;
}

function sessionLabelFrom(conv: Record<string, unknown>): string {
  const n = typeof conv.name === "string" ? conv.name.trim() : "";
  return n || "Untitled Claude conversation";
}

/** Parse already-`JSON.parse`d export → per-conversation row lists. */
export function parseClaudeExport(raw: unknown): ParsedClaudeConversation[] {
  const roots = normalizeClaudeExportRoot(raw);
  const out: ParsedClaudeConversation[] = [];
  for (let i = 0; i < roots.length; i += 1) {
    const conv = roots[i];
    const rows = claudeConversationToRows(conv);
    out.push({
      conversationId: safeConversationId(conv, i),
      sessionLabel: sessionLabelFrom(conv),
      rows,
    });
  }
  return out;
}
