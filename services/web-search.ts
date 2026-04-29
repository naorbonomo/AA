/**
 * Web search — Tavily REST only (`POST https://api.tavily.com/search`).
 *
 * Flow: agent calls `completionPost` → model may emit `web_search` → we call Tavily → JSON `{ results[], tavily_short_answer? }`
 * appended as **tool message** → model composes reply. Snippets reflect **indexed web pages**; wrong/stale clocks happen when
 * the search index returns an old line or unrelated page (not “live” instrumentation). Tavily optional `answer` is still model-synthesized upstream.
 *
 * Key: **`TAVILY_API_KEY`** in `userData/.env` — Settings → Secrets → **Save all** (Electron mirrors into `process.env` on startup).
 */

import * as webSearchCfg from "../config/web_search_config.js";
import { getSecrets } from "./secrets-store.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("web-search");

export type WebSearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchOk = {
  ok: true;
  provider: "tavily";
  query: string;
  results: WebSearchHit[];
  /** Tavily synthesized summary when requested — still verify against user question and locale. */
  tavily_short_answer?: string | null;
  scrapeBackend?: "api";
};

export type WebSearchErr = {
  ok: false;
  error: string;
};

export type WebSearchResult = WebSearchOk | WebSearchErr;

/** Cap hit snippets and Tavily answer in tool messages so agent POST body stays bounded (avoids brittle servers dropping huge JSON). */
export function shrinkWebSearchForToolMessage(
  result: WebSearchResult,
  opts?: { maxSnippetChars?: number; maxAnswerChars?: number },
): WebSearchResult {
  if (!result.ok) {
    return result;
  }
  const maxSnip = opts?.maxSnippetChars ?? 800;
  const maxAns = opts?.maxAnswerChars ?? 2000;
  const results = result.results.map((h) => {
    const sn = h.snippet;
    return {
      ...h,
      snippet: sn.length > maxSnip ? `${sn.slice(0, maxSnip)}…` : sn,
    };
  });
  let short = result.tavily_short_answer;
  if (typeof short === "string" && short.length > maxAns) {
    short = `${short.slice(0, maxAns)}…`;
  }
  return {
    ...result,
    results,
    ...(short !== null && short !== undefined ? { tavily_short_answer: short } : {}),
  };
}

/** OpenAI-style `tools[]` entry for chat/completions agent loops. */
export const webSearchOpenAiTool = {
  type: "function" as const,
  function: {
    name: "web_search",
    description:
      "Search the public web via Tavily for current information. Returns ranked titles, URLs, and short snippets (not full page text). Prefer for news, facts after training cutoff, or verification.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (keywords or natural language).",
        },
        max_results: {
          type: "integer",
          description: "Max results to return (1–10). Defaults to 5.",
        },
      },
      required: ["query"],
    },
  },
};

function clampMax(n: number): number {
  const d = webSearchCfg.WEB_SEARCH_MAX_RESULTS_DEFAULT;
  const cap = webSearchCfg.WEB_SEARCH_MAX_RESULTS_CAP;
  if (!Number.isFinite(n) || n < 1) {
    return d;
  }
  return Math.min(cap, Math.max(1, Math.floor(n)));
}

async function searchTavily(query: string, key: string, max: number): Promise<WebSearchOk | WebSearchErr> {
  const sig = AbortSignal.timeout(webSearchCfg.WEB_SEARCH_HTTP_TIMEOUT_MS);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "basic",
      include_answer: true,
      include_raw_content: false,
      max_results: max,
    }),
    signal: sig,
  });
  const raw = await res.text();
  if (!res.ok) {
    log.error(`tavily HTTP ${res.status}`, raw.slice(0, 400));
    return { ok: false, error: `Tavily HTTP ${res.status}: ${raw.slice(0, 200)}` };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "Tavily response not JSON" };
  }
  const parsed = body as { results?: unknown; answer?: unknown };
  const answerRaw = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  if (!Array.isArray(parsed.results)) {
    return { ok: false, error: "Tavily response: missing results[]" };
  }
  const out: WebSearchHit[] = [];
  for (const r of parsed.results) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title : "";
    const url = typeof o.url === "string" ? o.url : "";
    const snippet = typeof o.content === "string" ? o.content : typeof o.snippet === "string" ? o.snippet : "";
    if (url) {
      out.push({ title: title || url, url, snippet });
    }
  }
  log.info("tavily ok", {
    query,
    hits: out.length,
    hasShortAnswer: Boolean(answerRaw),
  });
  const shortAns = answerRaw.length > 0 ? answerRaw : null;
  return {
    ok: true,
    provider: "tavily",
    query,
    results: out.slice(0, max),
    ...(shortAns !== null ? { tavily_short_answer: shortAns } : {}),
    scrapeBackend: "api",
  };
}

/**
 * Tavily search only — requires `tavily_api_key` in secrets (Electron: Settings → Secrets → Save all).
 */
export async function webSearch(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult> {
  const q = (query || "").trim();
  if (!q) {
    return { ok: false, error: "query is empty" };
  }
  const max = clampMax(opts?.maxResults ?? webSearchCfg.WEB_SEARCH_MAX_RESULTS_DEFAULT);
  const key = (getSecrets().tavily_api_key ?? "").trim();
  if (!key) {
    return {
      ok: false,
      error:
        "Tavily API key missing — Settings → Secrets → paste key → Save all (writes userData `.env`; also sets process.env.TAVILY_API_KEY).",
    };
  }
  return searchTavily(q, key, max);
}
