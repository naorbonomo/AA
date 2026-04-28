/** Agent loop: `web_search` tool + follow-up completions (main process; Python Smith `quick_web_search` analogue). */

import type { ChatMessage, ChatUsageSnapshot, CompletionApiMessage, StreamDelta } from "./llm.js";
import { normalizeAssistantContent, streamCompletionPost } from "./llm.js";
import { webSearch, webSearchOpenAiTool } from "./web-search.js";
import { getResolvedSettings } from "./settings-store.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("agent-runner");

const SYSTEM_WITH_TOOLS = `You have a web_search tool — Tavily API (Keys: Settings → Secrets → Save all; persists to userData .env as TAVILY_API_KEY and mirrors into process.env).

Important — tool output can be wrong for live clocks/prices:
- Snippets are citations from web crawl/index — not authoritative atomic clocks; wrong timezone, stale page text, or wrong city matches are normal.
- If JSON includes field tavily_short_answer (Tavily summary), sanity-check versus the user's stated place/timezone question; do not treat as calibrated truth.
- If user asks local time for city X but numbers disagree with plausible offset vs neighboring regions or their machine clock, say search results are unreliable; suggest time.is / worldclock or OS clock rather than asserting one snippet.
- For prices: say figures come from snippets, approximate.

Otherwise cite site names from snippets; retry with sharper queries if irrelevant. Skip search for pure chit-chat.`;

export type AgentStepPayload =
  | { kind: "web_search"; status: "start"; query: string }
  | {
      kind: "web_search";
      status: "done";
      query: string;
      hitCount: number;
      ok: boolean;
      provider?: string;
      scrapeBackend?: string;
      /** First-hit preview for logs + UI trace. */
      previewSummary?: string;
    };

function mergeUsage(acc: ChatUsageSnapshot | undefined, next: ChatUsageSnapshot | undefined): ChatUsageSnapshot | undefined {
  if (!next) {
    return acc;
  }
  if (!acc) {
    return { ...next };
  }
  const merged: ChatUsageSnapshot = { ...acc };
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const a = merged[k];
    const b = next[k];
    if (typeof b === "number") {
      merged[k] = (typeof a === "number" ? a : 0) + b;
    }
  }
  return merged;
}

function parseToolArgs(raw: string | undefined): { query?: string; max_results?: number } {
  if (!raw || typeof raw !== "string") {
    return {};
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const query = typeof o.query === "string" ? o.query : undefined;
    const max_results = o.max_results !== undefined ? Number(o.max_results) : undefined;
    return {
      query,
      max_results: Number.isFinite(max_results) ? max_results : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Tool loop with `web_search` only: streamed completions until assistant returns text (no tool_calls) or rounds exhausted.
 */
export async function runChatWithWebSearchTool(opts: {
  history: ChatMessage[];
  maxToolRounds: number;
  onStep?: (p: AgentStepPayload) => void;
  /** Token/reasoning deltas for current assistant round (each completion is streamed). */
  onStreamDelta?: (d: StreamDelta) => void;
}): Promise<{
  text: string;
  steps: AgentStepPayload[];
  usage?: ChatUsageSnapshot;
}> {
  const maxRounds = Math.max(1, Math.min(500, opts.maxToolRounds));
  const msgs: CompletionApiMessage[] = [{ role: "system", content: SYSTEM_WITH_TOOLS }];
  for (const m of opts.history) {
    const c = typeof m.content === "string" ? m.content : String(m.content);
    msgs.push({ role: m.role, content: c } as CompletionApiMessage);
  }

  let usageAcc: ChatUsageSnapshot | undefined;
  const stepsOut: AgentStepPayload[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    log.info("agent round", { round });
    const streamed = await streamCompletionPost({
      messages: msgs,
      tools: [webSearchOpenAiTool],
      tool_choice: "auto",
      onDelta: opts.onStreamDelta,
    });
    usageAcc = mergeUsage(usageAcc, streamed.usage);
    const message = streamed.message;
    if (!message || typeof message !== "object") {
      throw new Error("Agent: missing message");
    }

    msgs.push(JSON.parse(JSON.stringify(message)) as CompletionApiMessage);

    const tc = message.tool_calls;
    if (!Array.isArray(tc) || tc.length === 0) {
      const text = normalizeAssistantContent(message.content ?? null);
      if (text === null || text === "") {
        throw new Error("Agent: assistant returned no text and no tools");
      }
      return { text, steps: stepsOut, usage: usageAcc };
    }

    for (const call of tc) {
      const id = typeof call.id === "string" ? call.id : "";
      const name = call.function?.name?.trim() ?? "";
      const rawArgs = typeof call.function?.arguments === "string" ? call.function.arguments : "{}";
      if (name !== "web_search") {
        const errText = JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
        msgs.push({ role: "tool", tool_call_id: id, content: errText });
        continue;
      }

      const parsed = parseToolArgs(rawArgs);
      const q = (parsed.query ?? "").trim();
      if (!q) {
        msgs.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify({ ok: false, error: "missing query in tool arguments" }),
        });
        continue;
      }

      const st: AgentStepPayload = { kind: "web_search", status: "start", query: q };
      opts.onStep?.(st);
      stepsOut.push(st);

      const result = await webSearch(q, {
        maxResults: parsed.max_results,
      });
      const hitCount = result.ok ? result.results.length : 0;

      let previewSummary: string | undefined;
      let providerLabel: string | undefined;
      let scrapeLabel: string | undefined;
      if (result.ok && result.results.length > 0) {
        providerLabel = result.provider;
        scrapeLabel = result.scrapeBackend;
        let host = "";
        try {
          host = new URL(result.results[0].url).hostname.replace(/^www\./, "");
        } catch {
          host = "?";
        }
        const sn = result.results[0].snippet.replace(/\s+/g, " ").slice(0, 120);
        previewSummary = `${host}: ${sn}${result.results[0].snippet.length > 120 ? "…" : ""}`;
        log.info("agent web_search tool", {
          round,
          query: q,
          provider: providerLabel,
          scrapeBackend: scrapeLabel,
          hitCount,
          firstUrl: result.results[0].url,
          firstSnippet: result.results[0].snippet.slice(0, 280),
        });
      } else if (!result.ok) {
        log.warn("agent web_search tool", {
          round,
          query: q,
          error: result.error,
        });
      } else {
        log.warn("agent web_search tool", { round, query: q, note: "ok but zero hits" });
      }

      const done: AgentStepPayload = {
        kind: "web_search",
        status: "done",
        query: q,
        hitCount,
        ok: result.ok,
        provider: providerLabel,
        scrapeBackend: scrapeLabel,
        previewSummary,
      };
      opts.onStep?.(done);
      stepsOut.push(done);

      msgs.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result) });
    }
  }

  throw new Error(`Agent: exceeded max tool rounds (${maxRounds})`);
}

/** Uses `agent.maxToolRounds` from merged settings. */
export async function runChatWithWebSearchFromSettings(
  history: ChatMessage[],
  onStep?: (p: AgentStepPayload) => void,
  onStreamDelta?: (d: StreamDelta) => void,
): Promise<{ text: string; steps: AgentStepPayload[]; usage?: ChatUsageSnapshot }> {
  const n = getResolvedSettings().agent.maxToolRounds;
  return runChatWithWebSearchTool({ history, maxToolRounds: n, onStep, onStreamDelta });
}
