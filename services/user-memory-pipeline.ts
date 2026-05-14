/** Fact extraction + profile-intent helpers (main-process); LLM via `chatCompletion`. */

import type { ChatMessage, ChatUsageSnapshot, StreamDelta } from "./llm.js";
import { chatCompletion, streamChatCompletion } from "./llm.js";
import type { EmbeddingSearchHit } from "./embedding-vector-store.js";
import { hitToContextString } from "./knowledge-search-curate.js";
import type { StoredUserFact } from "./user-memory-store.js";
import { normalizeFactCategory, normalizeFactKey, upsertFactWithDedup } from "./user-memory-store.js";
import { readImportedChatSessionsLossless } from "./imported-chat-sessions-store.js";
import { readChatHistoryLossless } from "./chat-history-store.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("user-memory-pipeline");

const EXTRACTION_SYSTEM = `You extract durable facts about the USER only from one chat exchange (previous user message + assistant reply).

Rules:
- Respond with JSON object shaped { "facts": Fact[] } where Fact has:
  key (string, snake_case),
  value (string, concise),
  confidence (number 0..1),
  category (exactly one of: identity, preference, behavior, goal, relationship, context),
  source_turn_id (string — copy from input verbatim).
- If nothing clearly describes the user, return { "facts": [] }.
- Ignore facts about the assistant, third parties unless they describe user's relationship to them (then category relationship).
- Never invent; skip uncertain items.

Your stack may emit reasoning or tags before/after the JSON; the app strips those and parses the facts object (response_format still expects JSON).
`;

/** Remove common inline thinking blocks so brace-scan can find { "facts": … }. */
function stripThinkingNoise(s: string): string {
  let out = s;
  const blocks: RegExp[] = [
    /<antThinking\b[\s\S]*?<\/antThinking>/gi,
    /<thinking\b[\s\S]*?<\/thinking>/gi,
    /<think\b[\s\S]*?<\/think>/gi,
    /<thought\b[\s\S]*?<\/thought>/gi,
    /<reflection\b[\s\S]*?<\/reflection>/gi,
    /<scratchpad\b[\s\S]*?<\/scratchpad>/gi,
    /<redacted_reasoning>[\s\S]*?<\/reasoning>/gi,
    /<thinking>[\s\S]*?<\/think>/gi,
    /\[\s*thinking\s*\][\s\S]*?\[\s*\/\s*thinking\s*\]/gi,
  ];
  for (const re of blocks) out = out.replace(re, "");
  return out;
}

function stripJsonFence(raw: string): string {
  let x = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(x);
  if (fence?.[1]) x = fence[1].trim();
  return x;
}

/** Finds balanced `{ ... }` from startIdx (quotes + escapes approximated). */
function balancedJsonObjectFrom(s: string, startIdx: number): string | null {
  if (s[startIdx] !== "{") return null;
  let depth = 0;
  let i = startIdx;
  let inStr: '"' | "'" | "`" | null = null;
  let esc = false;
  for (; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c as '"' | "'" | "`";
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** Pull substring that JSON-parses to { facts: [...] } (thinking / prose tolerated). */
export function extractFactsJsonPayload(raw: string): string {
  const fenced = stripJsonFence(raw.trim());
  const cleaned = stripThinkingNoise(fenced);
  const tryRoot = (t: string): unknown | undefined => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return undefined;
    }
  };
  const hasFactsKey = (o: unknown): boolean =>
    Boolean(o && typeof o === "object" && Array.isArray((o as { facts?: unknown }).facts));

  let parsed = tryRoot(cleaned);
  if (hasFactsKey(parsed)) return cleaned.trim();
  parsed = tryRoot(stripJsonFence(cleaned));
  if (hasFactsKey(parsed)) return stripJsonFence(cleaned).trim();

  const hunt = stripThinkingNoise(fenced);
  for (let i = 0; i < hunt.length; i += 1) {
    if (hunt[i] !== "{") continue;
    const chunk = balancedJsonObjectFrom(hunt, i);
    if (!chunk) continue;
    if (hasFactsKey(tryRoot(chunk))) return chunk.trim();
  }
  return cleaned.trim();
}

export type ParsedExtractedFact = {
  key: string;
  value: string;
  confidence: number;
  category: string;
  source_turn_id: string;
};

export function parseFactsJson(raw: string): ParsedExtractedFact[] {
  const payload = extractFactsJsonPayload(raw);
  const s = stripJsonFence(payload);
  let root: unknown;
  try {
    root = JSON.parse(s) as unknown;
  } catch {
    log.warn("parseFactsJson: invalid JSON", { head: s.slice(0, 140) });
    return [];
  }
  let arr: unknown[];
  if (Array.isArray(root)) {
    arr = root;
  } else if (root && typeof root === "object" && Array.isArray((root as { facts?: unknown }).facts)) {
    arr = (root as { facts: unknown[] }).facts;
  } else {
    return [];
  }
  const out: ParsedExtractedFact[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = normalizeFactKey(typeof o.key === "string" ? o.key : "");
    const value = typeof o.value === "string" ? o.value.trim() : "";
    let confidence = Number(o.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    const catRaw = typeof o.category === "string" ? o.category : "";
    const sid = typeof o.source_turn_id === "string" ? o.source_turn_id.trim() : "";
    if (!key.length || !value.length || !normalizeFactCategory(catRaw)) continue;
    out.push({
      key,
      value,
      confidence,
      category: catRaw.trim().toLowerCase(),
      source_turn_id: sid.slice(0, 2048),
    });
  }
  return out;
}

export async function extractFactsFromExchange(opts: {
  userText: string;
  assistantText: string;
  sourceTurnId: string;
}): Promise<void> {
  const payload = {
    user: opts.userText,
    assistant: opts.assistantText,
    source_turn_id: opts.sourceTurnId,
  };
  let text: string;
  try {
    text = await chatCompletion({
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });
  } catch (e) {
    log.warn("extractFactsFromExchange chatCompletion failed", {
      msg: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  const facts = parseFactsJson(text);
  for (const f of facts) {
    try {
      await upsertFactWithDedup({
        key: f.key,
        value: f.value,
        confidence: f.confidence,
        category: f.category,
        source_turn_id: opts.sourceTurnId,
      });
    } catch (err) {
      log.warn("extractFactsFromExchange upsert failed", {
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Fire-and-forget after assistant reply (`hist` ends with latest user; assistant comes from this turn only). */
export function enqueueFactExtractionAfterAssistantTurn(
  hist: ChatMessage[],
  assistantText: string,
  sourceTurnId: string,
): void {
  let lastUser = "";
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const m = hist[i];
    if (m.role !== "user") continue;
    lastUser = typeof m.content === "string" ? m.content.trim() : "";
    break;
  }
  const asst = assistantText.trim();
  if (!lastUser.length || !asst.length) return;
  void extractFactsFromExchange({
    userText: lastUser,
    assistantText: asst,
    sourceTurnId,
  }).catch((e) =>
    log.warn("enqueueFactExtractionAfterAssistantTurn failed", {
      msg: e instanceof Error ? e.message : String(e),
    }),
  );
}

export function isProfileQueryIntent(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (t.length < 8 || t.length > 400) return false;
  const patterns = [
    /\bwhat do you know about me\b/,
    /\btell me what you know about me\b/,
    /\bdescribe me\b/,
    /\bsummarize me\b/,
    /\bwho am i\b.*\b(from what you know|to you)\b/,
    /\btell me about myself\b/,
    /\bwhat can you tell me about myself\b/,
    /\bmy profile\b.*\b(show|summarize|give|tell)\b/,
    /\bwhat have you learned about me\b/,
    /\bwhat do you remember about me\b/,
  ];
  return patterns.some((re) => re.test(t));
}

export function latestUserMessage(hist: ChatMessage[]): string | null {
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const m = hist[i];
    if (m.role !== "user") continue;
    const c = typeof m.content === "string" ? m.content.trim() : "";
    if (!c.length) continue;
    return c;
  }
  return null;
}

export function buildProfileSynthesisPrompt(opts: {
  facts: StoredUserFact[];
  hits: EmbeddingSearchHit[];
  userQuestion: string;
  corpusNote?: string;
}): { system: string; user: string } {
  const factLines = opts.facts.length
    ? opts.facts.map((f) => `- (${f.category}) ${f.key}: ${f.value} [confidence ${f.confidence.toFixed(2)}]`).join("\n")
    : "(no structured facts stored)";
  const excerptLines =
    opts.hits.length > 0
      ? opts.hits.map((h, i) => `${i + 1}. ${hitToContextString(h)}`).join("\n\n")
      : "(no semantic excerpts retrieved — rely on facts above)";
  const system = `You synthesize an accurate, helpful profile answer about the user.

Rules:
- Combine structured facts with conversation excerpts when relevant.
- Be concise but informative; use Markdown bullets where helpful.
- If excerpts contradict facts, mention uncertainty briefly.
- Do not invent traits not supported by facts or excerpts.
${opts.corpusNote ?? ""}`;
  const user = `User asked (intent: profile / self-summary):\n"${opts.userQuestion}"\n\nStructured facts (confidence descending):\n${factLines}\n\nTop semantic excerpts from indexed conversation history:\n${excerptLines}`;
  return { system, user };
}

export async function streamProfileSynthesis(opts: {
  facts: StoredUserFact[];
  hits: EmbeddingSearchHit[];
  userQuestion: string;
  corpusNote?: string;
  onDelta: (d: StreamDelta) => void;
}): Promise<{ text: string; wallMs: number; usage?: ChatUsageSnapshot }> {
  const { system, user } = buildProfileSynthesisPrompt(opts);
  let acc = "";
  const out = await streamChatCompletion(
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
    },
    (d) => {
      if (typeof d.content === "string") acc += d.content;
      opts.onDelta(d);
    },
  );
  return { text: acc.trim(), wallMs: out.wallMs, usage: out.usage };
}

export type HarvestProgressPayload = {
  step: number;
  total: number;
  /** Set after SQLite upserts for pair; renderer can reload fact list cheaply (debounced). */
  factsTick?: boolean;
};

export type HarvestPair = { userText: string; assistantText: string; sourceTurnId: string };

/** Stable ordering: all imported sessions, then optional live transcript tail. */
export function buildHarvestPairList(includeLiveHistory: boolean): HarvestPair[] {
  const pairs: HarvestPair[] = [];
  const imported = readImportedChatSessionsLossless();
  for (const s of imported) {
    const rows = s.rows;
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev.role === "user" && cur.role === "assistant") {
        pairs.push({
          userText: prev.content.trim(),
          assistantText: cur.content.trim(),
          sourceTurnId: `imported:${s.conversationId}:${i}`,
        });
      }
    }
  }
  if (includeLiveHistory) {
    const rows = readChatHistoryLossless();
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev.role === "user" && cur.role === "assistant") {
        pairs.push({
          userText: prev.content.trim(),
          assistantText: cur.content.trim(),
          sourceTurnId: `live:${i}`,
        });
      }
    }
  }
  return pairs;
}

export type HarvestRunResult = {
  pairsTotal: number;
  pairsProcessed: number;
  aborted: boolean;
  /** Next 0-based index into same `buildHarvestPairList(includeLiveHistory)` order. */
  nextPairIndex: number;
};

const DEFAULT_HARVEST_MAX_CONCURRENCY = 4;
const MAX_HARVEST_MAX_CONCURRENCY = 32;

function clampHarvestConcurrency(raw: unknown): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_HARVEST_MAX_CONCURRENCY;
  return Math.min(MAX_HARVEST_MAX_CONCURRENCY, Math.max(1, n));
}

/**
 * Imported sessions (+ optional live transcript). Schedules up to `maxConcurrency` overlapping LLM extracts;
 * contiguous prefix advances `HarvestProgress.step` for stable progress bar; skips inter-pair delay when concurrency > 1.
 */
export async function harvestFactsFromImportedSessions(opts: {
  includeLiveHistory: boolean;
  delayMsBetweenPairs?: number;
  /** Parallel LLM extractions cap (default 4). */
  maxConcurrency?: number;
  /** First pair index to process (resume). */
  startPairIndex?: number;
  signal?: AbortSignal;
  onProgress?: (p: HarvestProgressPayload) => void;
}): Promise<HarvestRunResult> {
  const pairs = buildHarvestPairList(opts.includeLiveHistory);
  const delayMsRaw =
    typeof opts.delayMsBetweenPairs === "number" ? Math.max(0, Math.floor(opts.delayMsBetweenPairs)) : 120;
  const concurrency = clampHarvestConcurrency(opts.maxConcurrency);
  const delayMs = concurrency > 1 ? 0 : delayMsRaw;
  let start = typeof opts.startPairIndex === "number" ? Math.floor(opts.startPairIndex) : 0;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (start > pairs.length) start = pairs.length;

  let processed = 0;
  const total = pairs.length;
  const done = new Set<number>();

  /** Stable `step` toward `total`: 1-based next slot in `[start …)` missing from contiguous done prefix from `start`; backfill completions keep bar moving. */
  const emitHarvestProgress = (factsTick?: boolean) => {
    let fm = start;
    while (fm < pairs.length && done.has(fm)) fm += 1;
    const step = fm >= pairs.length ? total : fm + 1;
    opts.onProgress?.({
      step: total === 0 ? 0 : step,
      total,
      factsTick: factsTick === true ? true : undefined,
    });
  };

  const processOne = async (j: number): Promise<void> => {
    const p = pairs[j];
    if (!p.userText.length || !p.assistantText.length) {
      done.add(j);
      emitHarvestProgress();
      if (delayMs > 0 && j < pairs.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      return;
    }
    await extractFactsFromExchange({
      userText: p.userText,
      assistantText: p.assistantText,
      sourceTurnId: p.sourceTurnId,
    });
    processed += 1;
    done.add(j);
    emitHarvestProgress(true);
    if (delayMs > 0 && j < pairs.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  };

  const indices = Array.from({ length: pairs.length - start }, (_, k) => start + k);
  const executing = new Set<Promise<void>>();
  const sig = opts.signal;

  for (const j of indices) {
    if (sig?.aborted) break;
    const p = processOne(j).finally(() => {
      executing.delete(p);
    });
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  let nextPairIndex = pairs.length;
  for (let j = start; j < pairs.length; j += 1) {
    if (!done.has(j)) {
      nextPairIndex = j;
      break;
    }
  }
  const aborted = Boolean(sig?.aborted);
  if (aborted) {
    return { pairsTotal: total, pairsProcessed: processed, aborted: true, nextPairIndex };
  }
  return { pairsTotal: total, pairsProcessed: processed, aborted: false, nextPairIndex: pairs.length };
}
