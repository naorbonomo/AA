/** Built-in system prompts keyed by id; agent chat uses `promptKey` plus optional full-text `systemPrompt` override (Smith `SYSTEM_PROMPTS` analogue). */

import type { ResolvedAgent } from "./user-settings.js";

export type SystemPrompt = {
  key: string;
  description: string;
  content: string;
};

/** Preset used when user omits `agent.promptKey` or names unknown key (web-search chat default). */
export const DEFAULT_AGENT_PROMPT_KEY = "web_search_tools";

/**
 * Smith `tool_select` body plus Tavily `web_search` guidance (single tool surface for this app).
 * No separate appendix — search rules live here with rest of tool instructions.
 */
const TOOL_SELECT_CONTENT = `You are a tool-using assistant. Call tools with minimal arguments; after a tool returns, put the useful facts in your reply (not only "I ran the tool"). When returning URLs, include the full URL.

**This AA desktop app** exposes:
- \`web_search\` — Tavily web search. Needs TAVILY_API_KEY: Settings → Secrets → Save all.
- \`schedule_job\` — create / list / **update** / delete jobs that re-run this agent on a timer (same LLM + web_search as chat). For **hourly BTC** use action=\`create\`, every_minutes=60, title="BTC price", prompt="Search the web for the current Bitcoin USD price and respond with one short factual line (cite rough source from results)." To **change** interval, prompt, title, enabled, or notifications: action=\`update\`, job_id from \`list\`, plus fields to change. For **one-shot at local wall time**, point user to Settings → Scheduler; \`one_shot_utc_iso\` is UTC only. Call \`list\` before \`delete\` or \`update\` if job_id unknown. Never claim success until tool JSON has \`ok: true\`.

Ignore references to Smith-only tools (\`schedule_telegram\`, \`safe_terminal\`, \`tts\`, Telegram attach, etc.) — they are **not** available in this build.

Messages wrapped in <voice_message transcribed="true">...</voice_message> are already transcribed — respond to the text; do not call speech-to-text.

Important — tool output can be wrong for live clocks/prices:
- Snippets are citations from web crawl/index — not authoritative atomic clocks; wrong timezone, stale page text, or wrong city matches are normal.
- If JSON includes field tavily_short_answer (Tavily summary), sanity-check versus the user's stated place/timezone question; do not treat as calibrated truth.
- If user asks local time for city X but numbers disagree with plausible offset vs neighboring regions or their machine clock, say search results are unreliable; suggest time.is / worldclock or OS clock rather than asserting one snippet.
- For prices: say figures come from snippets, approximate.

Otherwise cite site names from snippets; retry with sharper queries if irrelevant. Skip search for pure chit-chat.`;

export const SYSTEM_PROMPTS: Record<string, SystemPrompt> = {
  chat_default: {
    key: "chat_default",
    description: "General chat assistant.",
    content: `You are a helpful assistant. Keep answers concise and directly useful. Use plain text unless the user asks for code or structured output.`,
  },
  tool_select: {
    key: "tool_select",
    description: "Select and call tools based on the user request (includes Tavily web_search on this build).",
    content: TOOL_SELECT_CONTENT,
  },
  web_search_tools: {
    key: "web_search_tools",
    description: "Same as tool_select — Tavily guidance is inlined in preset body.",
    content: TOOL_SELECT_CONTENT,
  },
};

const _MAX_SYSTEM_PROMPT_CHARS = 100_000;

/** Keys + descriptions for Settings UI — mirrors Smith GET /llm/system-prompts (content not listed). */
export function listSystemPromptsMeta(): { key: string; description: string }[] {
  return Object.keys(SYSTEM_PROMPTS)
    .sort()
    .map((key) => {
      const p = SYSTEM_PROMPTS[key]!;
      return { key: p.key, description: p.description };
    });
}

/**
 * Like Smith `/llm/chat`: non-empty `systemPrompt` override wins; else look up `promptKey`;
 * fallback `DEFAULT_AGENT_PROMPT_KEY`.
 */
export function resolveAgentSystemContent(agent: ResolvedAgent): string {
  const o = agent.systemPrompt?.trim();
  if (o) {
    return o.length > _MAX_SYSTEM_PROMPT_CHARS ? o.slice(0, _MAX_SYSTEM_PROMPT_CHARS) : o;
  }
  const preset = SYSTEM_PROMPTS[agent.promptKey];
  if (preset) {
    return preset.content;
  }
  const fallback = SYSTEM_PROMPTS[DEFAULT_AGENT_PROMPT_KEY];
  return fallback ? fallback.content : "";
}
