/** OpenAI `POST /v1/chat/completions` — URLs from settings; Bearer from `bearerTokenForLlm(provider)` in secrets-store. */

import { bearerTokenForLlm } from "./secrets-store.js";
import { getResolvedSettings } from "./settings-store.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("llm");

/** Cerebras `gpt-oss-*`: match public curl (`max_tokens`, `top_p`, `reasoning_effort`). Temperature stays from resolved settings. */
function cerebrasChatExtras(provider: string, model: string): Record<string, unknown> {
  if (provider !== "cerebras") return {};
  if (!model.includes("gpt-oss")) return {};
  return {
    reasoning_effort: "medium",
    max_tokens: 32768,
    top_p: 1,
  };
}

/** Turn JSON error bodies into clearer thrown strings (model_not_found, etc.). */
function llmHttpErrorText(status: number, raw: string): string {
  const slice = raw.slice(0, 500).trim();
  try {
    const j = JSON.parse(raw) as {
      message?: string;
      code?: string;
      error?: { message?: string; code?: string };
    };
    const msg =
      typeof j.message === "string"
        ? j.message
        : typeof j.error?.message === "string"
          ? j.error.message
          : undefined;
    const code =
      typeof j.code === "string"
        ? j.code
        : typeof j.error?.code === "string"
          ? j.error.code
          : undefined;
    if (msg && code === "model_not_found") {
      return `${msg} (HTTP ${status}) · Settings → LLM → “Fetch model ids from API”; pick id listed for your key.`;
    }
    if (msg) return `${msg} (HTTP ${status})`;
  } catch {
    /* keep slice */
  }
  return `LLM HTTP ${status}: ${slice}`;
}

/** Lists ids from OpenAI-compat `GET /v1/models` using resolved Base URL + `bearerTokenForLlm(provider)`. */
export async function fetchOpenAiCompatibleModelIds(): Promise<
  { ok: true; ids: string[] } | { ok: false; error: string }
> {
  const s = getResolvedSettings();
  const base = String(s.llm.baseUrl || "").replace(/\/$/, "");
  if (!base.length) {
    return { ok: false, error: "Base URL empty" };
  }
  const url = `${base}/v1/models`;
  const key = bearerTokenForLlm(s.llm.provider)?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  const to = Math.min(Math.max(s.llm.httpTimeoutMs, 5_000), 30_000);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(to) });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${raw.slice(0, 400)}` };
    }
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: "GET /v1/models response not JSON" };
    }
    const arr =
      data && typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : [];
    const ids: string[] = [];
    for (const item of arr) {
      if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        ids.push((item as { id: string }).id);
      }
    }
    return { ok: true, ids };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export type ChatRole = "user" | "assistant" | "system";

/** One user-turn image for vision-capable chat models (data URL built at API boundary). */
export type ChatImagePart = { fileName: string; mediaType: string; base64: string };

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** User images only; included in API when Settings → Vision is enabled. */
  images?: ChatImagePart[];
};

export type ChatCompletionArgs = {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
};

export type OpenAiChatCompletionRequestBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  stream: boolean;
  /** OpenAI: ask for `usage` on final streamed chunk (ignored by some backends). */
  stream_options?: { include_usage?: boolean };
};

export function normalizeAssistantContent(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw === null || raw === undefined) {
    return null;
  }
  if (Array.isArray(raw)) {
    const textParts: string[] = [];
    for (const part of raw) {
      if (typeof part === "object" && part !== null && "text" in part) {
        const t = (part as { text?: unknown }).text;
        if (typeof t === "string") textParts.push(t);
      }
    }
    return textParts.length ? textParts.join("") : JSON.stringify(raw);
  }
  return String(raw);
}

function pickAssistantText(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new Error("LLM response: expected JSON object");
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("LLM response: missing choices[]");
  }
  const first = choices[0] as {
    message?: { content?: unknown };
    delta?: { content?: unknown };
  };
  const content =
    first.message?.content !== undefined ? first.message.content : first.delta?.content;
  const text = normalizeAssistantContent(content);
  if (text === null || text === "") {
    throw new Error("LLM response: empty assistant content");
  }
  return text;
}

function usageLine(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const u = (body as { usage?: Record<string, unknown> }).usage;
  if (!u || typeof u !== "object") {
    return "";
  }
  const p = u.prompt_tokens;
  const c = u.completion_tokens;
  const t = u.total_tokens;
  const bits: string[] = [];
  if (typeof p === "number") bits.push(`prompt_tokens=${p}`);
  if (typeof c === "number") bits.push(`completion_tokens=${c}`);
  if (typeof t === "number") bits.push(`total_tokens=${t}`);
  return bits.join(" ");
}

function buildOpenAiBody(
  args: ChatCompletionArgs,
  s: ReturnType<typeof getResolvedSettings>,
  stream: boolean,
): OpenAiChatCompletionRequestBody {
  const lm = s.llm;
  const model = args.model ?? lm.model;
  const temperature = args.temperature ?? lm.temperature;
  const messages = args.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : String(m.content),
  }));
  const body = {
    model,
    messages,
    temperature,
    stream,
    ...cerebrasChatExtras(lm.provider, model),
  } as OpenAiChatCompletionRequestBody & Record<string, unknown>;
  if (stream) {
    body.stream_options = { include_usage: true };
  }
  return body;
}

/** POST `/v1/chat/completions` (OpenAI shape); returns assistant text. */
export async function chatCompletion(args: ChatCompletionArgs): Promise<string> {
  const s = getResolvedSettings();
  const url = `${s.llm.baseUrl}/v1/chat/completions`;
  const bodyPayload = buildOpenAiBody(args, s, false);
  const started = Date.now();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const key = bearerTokenForLlm(s.llm.provider)?.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  log.info("POST /v1/chat/completions", {
    url,
    model: bodyPayload.model,
    messageCount: bodyPayload.messages.length,
    temperature: bodyPayload.temperature,
    stream: bodyPayload.stream,
    authBearer: Boolean(key),
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyPayload),
    signal: AbortSignal.timeout(s.llm.httpTimeoutMs),
  });

  const elapsed = Date.now() - started;
  const raw = await res.text();

  if (!res.ok) {
    log.error(`HTTP ${res.status}`, raw.slice(0, 800));
    throw new Error(llmHttpErrorText(res.status, raw));
  }

  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    log.error("response not JSON", raw.slice(0, 400));
    throw new Error("LLM response not JSON");
  }

  const text = pickAssistantText(body);
  const u = usageLine(body);
  log.info(`OK ${elapsed}ms`, u || "(no usage)");
  return text;
}

/** OpenAI-style multimodal user fragment. */
export type ApiUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** OpenAI-compat message with optional `tool_calls` / `tool` results (agent loops). */
export type ApiToolCallPart = {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type CompletionApiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ApiUserContentPart[] }
  | {
      role: "assistant";
      content?: string | null;
      reasoning_content?: unknown;
      tool_calls?: ApiToolCallPart[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** Build one user message for the completions API (multimodal when `vision` and images present). */
export function completionUserMessage(
  m: ChatMessage,
  vision: boolean,
): Extract<CompletionApiMessage, { role: "user" }> {
  const text = typeof m.content === "string" ? m.content : String(m.content);
  const imgs = vision && m.images?.length ? m.images : [];
  if (!imgs.length) {
    return { role: "user", content: text };
  }
  const parts: ApiUserContentPart[] = [{ type: "text", text: text }];
  for (const img of imgs) {
    const mt = (img.mediaType || "image/png").trim() || "image/png";
    const b64 = (img.base64 || "").trim();
    if (!b64) {
      continue;
    }
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mt};base64,${b64}` },
    });
  }
  if (parts.length === 1) {
    return { role: "user", content: text };
  }
  return { role: "user", content: parts };
}

/** Non-streaming `/v1/chat/completions`; returns parsed JSON (tool_calls + usage when supported). */
export async function completionPost(params: {
  messages: CompletionApiMessage[];
  tools?: readonly unknown[];
  tool_choice?: "auto" | "none";
  model?: string;
  temperature?: number;
}): Promise<unknown> {
  const s = getResolvedSettings();
  const url = `${s.llm.baseUrl}/v1/chat/completions`;
  const bodyPayload: Record<string, unknown> = {
    model: params.model ?? s.llm.model,
    messages: params.messages as unknown[],
    temperature: params.temperature ?? s.llm.temperature,
    stream: false,
  };
  if (params.tools && params.tools.length > 0) {
    bodyPayload.tools = [...params.tools];
    bodyPayload.tool_choice = params.tool_choice ?? "auto";
  }
  Object.assign(bodyPayload, cerebrasChatExtras(s.llm.provider, String(bodyPayload.model)));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const key = bearerTokenForLlm(s.llm.provider)?.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  log.info("POST /v1/chat/completions (tools)", {
    url,
    model: bodyPayload.model,
    toolCount: params.tools?.length ?? 0,
    messageLen: params.messages.length,
    authBearer: Boolean(key),
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyPayload),
    signal: AbortSignal.timeout(s.llm.httpTimeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) {
    log.error(`HTTP ${res.status}`, raw.slice(0, 800));
    throw new Error(llmHttpErrorText(res.status, raw));
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("LLM response not JSON");
  }
}

type StreamToolPiece = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

function mergeStreamingToolPieces(
  acc: Map<number, { id: string; type: string; name: string; args: string }>,
  deltaToolCalls: unknown,
): void {
  if (!Array.isArray(deltaToolCalls)) return;
  for (const raw of deltaToolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const tc = raw as StreamToolPiece;
    const ix = typeof tc.index === "number" && Number.isFinite(tc.index) ? Math.floor(tc.index) : 0;
    let slot = acc.get(ix);
    if (!slot) {
      slot = { id: "", type: "function", name: "", args: "" };
      acc.set(ix, slot);
    }
    if (typeof tc.id === "string" && tc.id.length) slot.id = tc.id;
    if (typeof tc.type === "string" && tc.type.length) slot.type = tc.type;
    const fn = tc.function;
    if (fn && typeof fn === "object") {
      if (typeof fn.name === "string" && fn.name.length) slot.name = fn.name;
      if (typeof fn.arguments === "string") slot.args += fn.arguments;
    }
  }
}

function finalizedToolCallsFromAcc(
  acc: Map<number, { id: string; type: string; name: string; args: string }>,
): ApiToolCallPart[] | undefined {
  const keys = [...acc.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return undefined;
  return keys.map((k, i) => {
    const c = acc.get(k)!;
    const id = c.id || `call_${i}`;
    return {
      id,
      type: c.type || "function",
      function: {
        name: c.name || "",
        arguments: c.args.length ? c.args : "{}",
      },
    };
  });
}

/** Same as `/v1/chat/completions` with tools but `stream: true`; accumulates deltas into one assistant message. */
export async function streamCompletionPost(params: {
  messages: CompletionApiMessage[];
  tools?: readonly unknown[];
  tool_choice?: "auto" | "none";
  model?: string;
  temperature?: number;
  onDelta?: (d: StreamDelta) => void;
  signal?: AbortSignal;
}): Promise<{
  message: CompletionApiMessage & { role: "assistant" };
  wallMs: number;
  usage?: ChatUsageSnapshot;
  system_fingerprint?: string;
  streamedReasoning: string;
}> {
  const s = getResolvedSettings();
  const url = `${s.llm.baseUrl}/v1/chat/completions`;
  const bodyPayload: Record<string, unknown> = {
    model: params.model ?? s.llm.model,
    messages: params.messages as unknown[],
    temperature: params.temperature ?? s.llm.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.tools && params.tools.length > 0) {
    bodyPayload.tools = [...params.tools];
    bodyPayload.tool_choice = params.tool_choice ?? "auto";
  }
  Object.assign(bodyPayload, cerebrasChatExtras(s.llm.provider, String(bodyPayload.model)));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const key = bearerTokenForLlm(s.llm.provider)?.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const started = Date.now();
  log.info("POST /v1/chat/completions (tools+stream)", {
    url,
    model: bodyPayload.model,
    toolCount: params.tools?.length ?? 0,
    messageLen: params.messages.length,
    authBearer: Boolean(key),
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyPayload),
    signal: params.signal ?? AbortSignal.timeout(s.llm.httpTimeoutMs),
  });

  if (!res.ok) {
    const raw = await res.text();
    log.error(`HTTP ${res.status}`, raw.slice(0, 800));
    throw new Error(llmHttpErrorText(res.status, raw));
  }

  const bodyStream = res.body;
  if (!bodyStream) {
    throw new Error("LLM stream: empty body");
  }

  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolAcc = new Map<number, { id: string; type: string; name: string; args: string }>();
  let contentAcc = "";
  let streamedReasoning = "";
  let lastUsage: ChatUsageSnapshot | undefined;
  let lastFingerprint: string | undefined;
  let lastFinishReason: string | undefined;

  function parseDataLine(line: string): unknown | null {
    const t = line.trim();
    if (!t || t.startsWith(":") || !t.startsWith("data:")) return null;
    const payload = t.slice(5).trimStart();
    if (payload === "[DONE]") return null;
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }

  function ingestStreamObject(obj: unknown): void {
    if (typeof obj !== "object" || obj === null) return;
    const u = completionBodyUsage(obj);
    if (u) lastUsage = u;
    const fp = pickFingerprint(obj);
    if (fp) lastFingerprint = fp;
    const choices = (obj as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const ch0 = choices[0] as { finish_reason?: unknown; delta?: unknown };
    if (typeof ch0.finish_reason === "string" && ch0.finish_reason.length) {
      lastFinishReason = ch0.finish_reason;
    }
    if (ch0.delta && typeof ch0.delta === "object") {
      const delta = ch0.delta as Record<string, unknown>;
      mergeStreamingToolPieces(toolAcc, delta.tool_calls);
      const pieces = sliceDeltaPieces(delta);
      if (pieces.reasoning) {
        streamedReasoning += pieces.reasoning;
      }
      if (pieces.content) {
        contentAcc += pieces.content;
      }
      if (params.onDelta && (pieces.reasoning || pieces.content)) {
        params.onDelta(pieces);
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const obj = parseDataLine(line);
        if (obj !== null) ingestStreamObject(obj);
      }
    }
    if (buffer.trim()) {
      const obj = parseDataLine(buffer);
      if (obj !== null) ingestStreamObject(obj);
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = finalizedToolCallsFromAcc(toolAcc);
  const message: CompletionApiMessage & { role: "assistant" } = {
    role: "assistant",
    content: contentAcc.length ? contentAcc : null,
    ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
  };

  const wallMs = Date.now() - started;
  const ulog = lastUsage
    ? `usage total=${lastUsage.total_tokens ?? "?"} prompt=${lastUsage.prompt_tokens ?? "?"}`
    : "(no usage in stream)";
  log.info(`streamCompletionPost OK ${wallMs}ms`, {
    finish: lastFinishReason ?? "?",
    hasTools: Boolean(toolCalls?.length),
    contentChars: contentAcc.length,
    ulog,
  });

  const finalText = normalizeAssistantContent(message.content ?? null);
  if (!toolCalls?.length && (finalText === null || finalText === "")) {
    throw new Error("Agent: streamed assistant produced no text and no tool calls");
  }

  return {
    message,
    wallMs,
    usage: lastUsage,
    system_fingerprint: lastFingerprint,
    streamedReasoning,
  };
}

/** Subset of `usage` returned by LM Studio / OpenAI-compatible servers. */
export type ChatUsageSnapshot = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

/** OpenAI SSE `data: {...}` line — slice delta for reasoning vs answer (models vary). */
export type StreamDelta = { reasoning?: string; content?: string };

/** Extract `usage` from a `/v1/chat/completions` JSON body (streaming or non-streaming). */
export function completionBodyUsage(obj: unknown): ChatUsageSnapshot | undefined {
  if (typeof obj !== "object" || obj === null) {
    return undefined;
  }
  const u = (obj as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") {
    return undefined;
  }
  const ou = u as Record<string, unknown>;
  const out: ChatUsageSnapshot = {};
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const n = ou[k];
    if (typeof n === "number" && Number.isFinite(n)) {
      out[k] = Math.floor(n);
    }
  }
  const details = ou.completion_tokens_details;
  if (details && typeof details === "object") {
    const rt = (details as { reasoning_tokens?: unknown }).reasoning_tokens;
    if (typeof rt === "number" && Number.isFinite(rt)) {
      out.completion_tokens_details = { reasoning_tokens: Math.floor(rt) };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function sliceDeltaPieces(delta: unknown): StreamDelta {
  if (typeof delta !== "object" || delta === null) {
    return {};
  }
  const d = delta as Record<string, unknown>;
  const pieces: string[] = [];
  for (const k of ["reasoning_content", "reasoning", "thinking"] as const) {
    const v = d[k];
    if (typeof v === "string" && v.length) pieces.push(v);
  }
  const reasoning = pieces.length ? pieces.join("") : undefined;
  const c = d.content;
  const content = typeof c === "string" && c.length ? c : undefined;
  return { reasoning, content };
}

/** Top-level `system_fingerprint` on completion final chunk (OpenAI-compatible). */
function pickFingerprint(obj: unknown): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const fp = (obj as { system_fingerprint?: unknown }).system_fingerprint;
  return typeof fp === "string" && fp.length ? fp : undefined;
}

/** One SSE `data:` JSON object: may carry `delta` and/or `usage` (often only on last chunk). */
function parseSseDataObject(obj: unknown): {
  delta: StreamDelta;
  usage?: ChatUsageSnapshot;
  system_fingerprint?: string;
} {
  const empty: StreamDelta = {};
  if (typeof obj !== "object" || obj === null) {
    return { delta: empty };
  }
  const usage = completionBodyUsage(obj);
  const fingerprint = pickFingerprint(obj);
  const choices = (obj as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { delta: empty, usage, system_fingerprint: fingerprint };
  }
  const first = choices[0] as { delta?: unknown };
  const delta = sliceDeltaPieces(first.delta);
  return { delta, usage, system_fingerprint: fingerprint };
}

function parseSseLine(line: string): {
  delta: StreamDelta;
  usage?: ChatUsageSnapshot;
  system_fingerprint?: string;
} | null {
  const t = line.trim();
  if (!t || t.startsWith(":")) {
    return null;
  }
  if (!t.startsWith("data:")) {
    return null;
  }
  const payload = t.slice(5).trimStart();
  if (payload === "[DONE]") {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  return parseSseDataObject(obj);
}

/** POST `/v1/chat/completions` with `stream: true`; invokes `onDelta` per SSE chunk; returns wall time + last `usage` if server emits it. */
export async function streamChatCompletion(
  args: ChatCompletionArgs,
  onDelta: (d: StreamDelta) => void,
  signal?: AbortSignal,
): Promise<{
  wallMs: number;
  usage?: ChatUsageSnapshot;
  system_fingerprint?: string;
}> {
  const s = getResolvedSettings();
  const url = `${s.llm.baseUrl}/v1/chat/completions`;
  const bodyPayload = buildOpenAiBody(args, s, true);
  const started = Date.now();
  let lastUsage: ChatUsageSnapshot | undefined;
  let lastFingerprint: string | undefined;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const key = bearerTokenForLlm(s.llm.provider)?.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  log.info("POST /v1/chat/completions (stream)", {
    url,
    model: bodyPayload.model,
    messageCount: bodyPayload.messages.length,
    temperature: bodyPayload.temperature,
    stream: bodyPayload.stream,
    authBearer: Boolean(key),
  });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyPayload),
    signal: signal ?? AbortSignal.timeout(s.llm.httpTimeoutMs),
  });

  if (!res.ok) {
    const raw = await res.text();
    log.error(`HTTP ${res.status}`, raw.slice(0, 800));
    throw new Error(llmHttpErrorText(res.status, raw));
  }

  const body = res.body;
  if (!body) {
    throw new Error("LLM stream: empty body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;
        if (parsed.usage) {
          lastUsage = parsed.usage;
        }
        if (parsed.system_fingerprint) {
          lastFingerprint = parsed.system_fingerprint;
        }
        const d = parsed.delta;
        if (d.reasoning || d.content) {
          onDelta(d);
        }
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseLine(buffer);
      if (parsed) {
        if (parsed.usage) {
          lastUsage = parsed.usage;
        }
        if (parsed.system_fingerprint) {
          lastFingerprint = parsed.system_fingerprint;
        }
        const d = parsed.delta;
        if (d.reasoning || d.content) {
          onDelta(d);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const elapsed = Date.now() - started;
  const ulog = lastUsage
    ? `usage total=${lastUsage.total_tokens ?? "?"} prompt=${lastUsage.prompt_tokens ?? "?"}`
    : "(no usage in stream — server may omit unless final chunk or include_usage)";
  log.info(`stream OK ${elapsed}ms`, ulog);
  return { wallMs: elapsed, usage: lastUsage, system_fingerprint: lastFingerprint };
}
