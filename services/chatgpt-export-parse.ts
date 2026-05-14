/**
 * ChatGPT "Export data" ZIP → `conversations.json` shape:
 * - Root: JSON array of conversations (or rare wrapper — see `normalizeExportRoot`).
 * - Each conversation: `id?`, `title`, `create_time`, `mapping`, `current_node`.
 * - `mapping[id]`: `{ id, message?, parent, children[] }`
 * - `message`: `{ author: { role }, content: string | { content_type, parts[] } | …, create_time, metadata? }`
 *
 * Linear thread: walk `current_node` → follow `parent` until missing, reverse (main branch only).
 */

import type { ChatHistoryRow } from "./chat-history-store.js";

function partsToLossless(parts: unknown[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") chunks.push(p);
    else chunks.push(JSON.stringify(p));
  }
  return chunks.join("");
}

function extractContentLossless(message: Record<string, unknown>): string {
  const content = message.content;
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (Array.isArray(c.parts)) return partsToLossless(c.parts);
    return JSON.stringify(content);
  }
  return String(content);
}

function augmentWithMetadata(message: Record<string, unknown>, base: string): string {
  const md = message.metadata;
  if (md === undefined || md === null) return base;
  return `${base}\n\n--- chatgpt message.metadata ---\n${JSON.stringify(md)}`;
}

function messageTimeMs(message: Record<string, unknown>): number | undefined {
  const t = message.create_time;
  if (typeof t === "number" && Number.isFinite(t)) return Math.floor(t * 1000);
  return undefined;
}

const WRONG_FILE_HINT =
  "Unzip OpenAI's export and pick **conversations.json** (ChatGPT → Settings → Data controls → Export data). Other ZIP entries (user.json, message_feedback.json, model_comparisons.json, chat.html) are not conversation graphs.";

/** One exported ChatGPT thread — always has non-array object `mapping`. */
function isConversationRecord(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const m = (o as Record<string, unknown>).mapping;
  return typeof m === "object" && m !== null && !Array.isArray(m);
}

/**
 * Accept official **conversations.json** (root = JSON array) plus common wrappers.
 * Ref: OpenAI export — array of objects with `mapping`, `current_node`, `title`, etc.
 */
export function normalizeExportRoot(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    const objs = raw.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x)) as Record<
      string,
      unknown
    >[];
    const convs = objs.filter(isConversationRecord);
    if (convs.length > 0) return convs;
    if (objs.length === 0) return [];
    throw new Error(
      `JSON array has no objects with ChatGPT \`mapping\` graph. ${WRONG_FILE_HINT}`,
    );
  }

  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;

    if (Array.isArray(o.conversations)) {
      return normalizeExportRoot(o.conversations);
    }

    const namedArrays = ["data", "items", "chats", "history", "threads", "export"] as const;
    for (const k of namedArrays) {
      const v = o[k];
      if (Array.isArray(v)) {
        try {
          const inner = normalizeExportRoot(v);
          if (inner.length > 0) return inner;
        } catch {
          /* try next */
        }
      }
    }

    for (const v of Object.values(o)) {
      if (Array.isArray(v)) {
        try {
          const inner = normalizeExportRoot(v);
          if (inner.length > 0) return inner;
        } catch {
          /* continue */
        }
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const innerObj = v as Record<string, unknown>;
        if (Array.isArray(innerObj.conversations)) {
          try {
            const inner = normalizeExportRoot(innerObj.conversations);
            if (inner.length > 0) return inner;
          } catch {
            /* continue */
          }
        }
      }
    }

    if (isConversationRecord(o)) return [o];
  }

  throw new Error(
    `Unrecognized ChatGPT export shape. ${WRONG_FILE_HINT} Need array of objects each with \`mapping\`, or one such object.`,
  );
}

type ChatgptMappingNode = {
  message?: unknown;
  parent?: unknown;
  children?: unknown;
};

function mappingMessagesInTimeOrder(conv: Record<string, unknown>): Record<string, unknown>[] {
  const mapping = conv.mapping as Record<string, ChatgptMappingNode> | undefined;
  if (!mapping || typeof mapping !== "object") return [];

  const fromLeaf = (): Record<string, unknown>[] => {
    let id: string | null =
      typeof conv.current_node === "string" && conv.current_node.trim() ? conv.current_node.trim() : null;
    if (!id) return [];
    const chain: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      const node: ChatgptMappingNode = mapping[id]!;
      const msg = node.message;
      if (msg && typeof msg === "object") chain.push(msg as Record<string, unknown>);
      const p: unknown = node.parent;
      id = typeof p === "string" && p.trim() ? p.trim() : null;
    }
    return chain.reverse();
  };

  const ordered = fromLeaf();
  if (ordered.length > 0) return ordered;

  const all: Record<string, unknown>[] = [];
  for (const key of Object.keys(mapping)) {
    const node = mapping[key];
    if (!node || typeof node !== "object") continue;
    const msg = node.message;
    if (!msg || typeof msg !== "object") continue;
    const author = (msg as Record<string, unknown>).author;
    if (!author || typeof author !== "object") continue;
    if (typeof (author as Record<string, unknown>).role !== "string") continue;
    all.push(msg as Record<string, unknown>);
  }
  all.sort((a, b) => (messageTimeMs(a) ?? 0) - (messageTimeMs(b) ?? 0));
  return all;
}

function mapExportRoleToRowRole(roleRaw: string): "user" | "assistant" | "system" {
  const r = roleRaw.trim().toLowerCase();
  if (r === "user") return "user";
  if (r === "assistant") return "assistant";
  if (r === "system") return "system";
  return "system";
}

export function conversationExportToRows(conv: Record<string, unknown>): ChatHistoryRow[] {
  const messages = mappingMessagesInTimeOrder(conv);
  const rows: ChatHistoryRow[] = [];

  for (const msg of messages) {
    const author = msg.author && typeof msg.author === "object" ? (msg.author as Record<string, unknown>) : null;
    const roleRaw = author && typeof author.role === "string" ? author.role : "";
    if (!roleRaw.trim()) continue;

    let body = augmentWithMetadata(msg, extractContentLossless(msg));
    const low = roleRaw.trim().toLowerCase();
    if (low === "tool") {
      body = `[tool]\n${body}`;
    }

    const rowRole = mapExportRoleToRowRole(roleRaw);
    const atMs = messageTimeMs(msg);
    const row: ChatHistoryRow = { role: rowRole, content: body };
    if (atMs !== undefined) row.atMs = atMs;
    rows.push(row);
  }

  return rows;
}

export type ParsedChatgptConversation = {
  conversationId: string;
  sessionLabel: string;
  rows: ChatHistoryRow[];
};

function safeConversationId(conv: Record<string, unknown>, index: number): string {
  const id = conv.id;
  if (typeof id === "string" && id.trim()) return `chatgpt:${id.trim()}`;
  const title = typeof conv.title === "string" ? conv.title : "Untitled";
  const ct =
    typeof conv.create_time === "number" && Number.isFinite(conv.create_time)
      ? Math.floor(conv.create_time)
      : index;
  const slug = title.replace(/\s+/g, " ").trim().slice(0, 120) || "untitled";
  const safe = slug.replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 80) || "untitled";
  return `chatgpt:${safe}:${ct}`;
}

function sessionLabelFrom(conv: Record<string, unknown>): string {
  const t = typeof conv.title === "string" ? conv.title.trim() : "";
  return t || "Untitled ChatGPT conversation";
}

/** Parse already-`JSON.parse`d export → per-conversation row lists (lossless text, no trimming). */
export function parseChatgptExport(raw: unknown): ParsedChatgptConversation[] {
  const roots = normalizeExportRoot(raw);
  const out: ParsedChatgptConversation[] = [];
  for (let i = 0; i < roots.length; i += 1) {
    const conv = roots[i];
    const rows = conversationExportToRows(conv);
    out.push({
      conversationId: safeConversationId(conv, i),
      sessionLabel: sessionLabelFrom(conv),
      rows,
    });
  }
  return out;
}
