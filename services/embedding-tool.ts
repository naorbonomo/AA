/** Agent tool: semantic search over embedded corpus (sqlite-vec). */

import { searchEmbeddingCorpus } from "./conversation-embeddings.js";
import { getLogger, logToolInfo } from "../utils/logger.js";

const log = getLogger("embedding-tool");

export const knowledgeSearchOpenAiTool = {
  type: "function" as const,
  function: {
    name: "knowledge_search",
    description:
      "Search locally embedded conversation text/images (Embedding tab + indexed chat history). Returns full per-hit JSON bodies stored at index time.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language or keywords matching embedded content.",
        },
        top_k: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max hits (default 8).",
        },
      },
      required: ["query"],
    },
  },
};

export type KnowledgeSearchHitPayload = {
  rowid: number;
  distance: number;
  body: string;
};

function parseKnowledgeArgs(raw: string | undefined): { query: string; top_k: number } {
  if (!raw || typeof raw !== "string") {
    return { query: "", top_k: 8 };
  }
  try {
    const o = JSON.parse(raw) as { query?: string; top_k?: unknown };
    const query = typeof o.query === "string" ? o.query : "";
    let top_k = 8;
    if (o.top_k !== undefined && typeof o.top_k === "number" && Number.isFinite(o.top_k)) {
      top_k = Math.min(50, Math.max(1, Math.floor(o.top_k)));
    }
    return { query, top_k };
  } catch {
    return { query: "", top_k: 8 };
  }
}

export async function executeKnowledgeSearchTool(rawArgs: string): Promise<{
  ok: boolean;
  query?: string;
  hits?: KnowledgeSearchHitPayload[];
  error?: string;
}> {
  const { query, top_k } = parseKnowledgeArgs(rawArgs);
  if (!query) {
    return { ok: false, error: "missing query in tool arguments" };
  }
  const r = await searchEmbeddingCorpus({ queryText: query, topK: top_k });
  if (!r.ok) {
    log.warn("knowledge_search", { query, error: r.error });
    return { ok: false, error: r.error, query };
  }
  const hits: KnowledgeSearchHitPayload[] = r.hits.map((h) => ({
    rowid: h.rowid,
    distance: h.distance,
    body: h.body,
  }));
  logToolInfo("knowledge_search", "hits", { query, hitCount: hits.length });
  return { ok: true, query, hits };
}

/** Peek query string for UI trace before awaiting network. */
export function peekKnowledgeQuery(rawArgs: string | undefined): string {
  return parseKnowledgeArgs(rawArgs).query;
}
