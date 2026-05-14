/** OpenAI-compatible `POST /v1/embeddings` — same Base URL + Bearer as Settings → LLM. */

import fs from "node:fs";
import path from "node:path";

import { getResolvedSettings } from "./settings-store.js";
import { bearerTokenForLlm } from "./secrets-store.js";
import { getLogger } from "../utils/logger.js";
import { EMBEDDING_DEFAULT_MODEL_ID } from "../config/embedding_config.js";

const log = getLogger("embeddings");

/** @deprecated use `EMBEDDING_DEFAULT_MODEL_ID` from `config/embedding_config.ts` */
export const DEFAULT_EMBEDDING_MODEL = EMBEDDING_DEFAULT_MODEL_ID;

export type EmbeddingUsage = {
  prompt_tokens?: number;
  total_tokens?: number;
};

export type EmbeddingsResult = {
  model: string;
  embeddings: number[][];
  usage?: EmbeddingUsage;
};

function resolvedEmbeddingModel(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const env = process.env.AA_EMBEDDING_MODEL?.trim();
  if (env) return env;
  const fromSettings = getResolvedSettings().embedding.model.trim();
  if (fromSettings) return fromSettings;
  return EMBEDDING_DEFAULT_MODEL_ID;
}

function httpErrorSummary(status: number, raw: string): string {
  const slice = raw.slice(0, 500).trim();
  try {
    const j = JSON.parse(raw) as { message?: string; error?: { message?: string } };
    const msg =
      typeof j.message === "string"
        ? j.message
        : typeof j.error?.message === "string"
          ? j.error.message
          : undefined;
    if (msg) return `${msg} (HTTP ${status})`;
  } catch {
    /* keep slice */
  }
  return `Embeddings HTTP ${status}: ${slice}`;
}

function parseEmbeddingsJson(body: unknown): EmbeddingsResult {
  if (typeof body !== "object" || body === null) {
    throw new Error("Embeddings response: expected JSON object");
  }
  const o = body as {
    model?: unknown;
    data?: unknown;
    usage?: unknown;
  };
  const model = typeof o.model === "string" ? o.model : "";
  if (!model) {
    throw new Error("Embeddings response: missing model");
  }
  if (!Array.isArray(o.data)) {
    throw new Error("Embeddings response: missing data[]");
  }
  type Row = { embedding?: unknown; index?: unknown };
  const rows: Row[] = o.data.filter((x): x is Row => typeof x === "object" && x !== null) as Row[];
  rows.sort((a, b) => {
    const ia = typeof a.index === "number" ? a.index : 0;
    const ib = typeof b.index === "number" ? b.index : 0;
    return ia - ib;
  });
  const embeddings: number[][] = [];
  for (const row of rows) {
    const emb = row.embedding;
    if (!Array.isArray(emb)) {
      throw new Error("Embeddings response: item missing embedding[]");
    }
    const nums: number[] = [];
    for (const v of emb) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error("Embeddings response: non-numeric embedding value");
      }
      nums.push(v);
    }
    embeddings.push(nums);
  }
  if (embeddings.length === 0) {
    throw new Error("Embeddings response: empty data[]");
  }
  let usage: EmbeddingUsage | undefined;
  if (o.usage && typeof o.usage === "object") {
    const u = o.usage as Record<string, unknown>;
    const prompt_tokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
    const total_tokens = typeof u.total_tokens === "number" ? u.total_tokens : undefined;
    if (prompt_tokens !== undefined || total_tokens !== undefined) {
      usage = { prompt_tokens, total_tokens };
    }
  }
  return { model, embeddings, usage };
}

/** UTF-16 code-unit slices that concatenate back to `s` exactly (lossless partition). */
export function losslessUtf16Chunks(s: string, maxCodeUnits: number): string[] {
  if (!Number.isFinite(maxCodeUnits) || maxCodeUnits < 1) {
    throw new Error("losslessUtf16Chunks: maxCodeUnits must be >= 1");
  }
  if (s.length <= maxCodeUnits) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += maxCodeUnits) {
    out.push(s.slice(i, i + maxCodeUnits));
  }
  return out;
}

/** Override via `AA_EMBEDDING_LOSSLESS_CHUNK_CODE_UNITS` (min 1024). */
export function resolvedLosslessChunkCodeUnits(): number {
  const raw = process.env.AA_EMBEDDING_LOSSLESS_CHUNK_CODE_UNITS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1024) return Math.floor(n);
  }
  return 80_000;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Read image from disk → `data:image/...;base64,...` for multimodal embedding payloads. */
export function absImageFileToDataUrl(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const buf = fs.readFileSync(absPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export type EmbeddingMultimodalPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

async function postEmbeddingsRequest(
  model: string,
  input: unknown,
  signal: AbortSignal,
): Promise<EmbeddingsResult> {
  const s = getResolvedSettings();
  const base = String(s.llm.baseUrl || "").replace(/\/$/, "");
  if (!base.length) {
    throw new Error("Embeddings: LLM Base URL empty (Settings)");
  }
  const url = `${base}/v1/embeddings`;
  const bodyPayload = { model, input };
  const bodyStr = JSON.stringify(bodyPayload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const key = bearerTokenForLlm(s.llm.provider)?.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const batchHint =
    typeof input === "string" ? 1 : Array.isArray(input) ? input.length : typeof input === "object" ? 1 : 0;

  log.info("POST /v1/embeddings", {
    url,
    model,
    batchSize: batchHint,
    authBearer: Boolean(key),
    bodyUtf8Bytes: Buffer.byteLength(bodyStr, "utf8"),
  });

  const started = Date.now();
  const res = await fetch(url, { method: "POST", headers, body: bodyStr, signal });
  const raw = await res.text();
  const elapsed = Date.now() - started;

  if (!res.ok) {
    log.error(`HTTP ${res.status}`, raw.slice(0, 800));
    throw new Error(httpErrorSummary(res.status, raw));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Embeddings response not JSON");
  }

  const out = parseEmbeddingsJson(parsed);
  log.info("/v1/embeddings ok", {
    elapsedMs: elapsed,
    dims: out.embeddings[0]?.length ?? 0,
    rows: out.embeddings.length,
    usage: out.usage,
  });
  return out;
}

export type CreateEmbeddingsArgs = {
  /** Single string or batch (OpenAI `input`). */
  input: string | string[];
  /** Defaults to `AA_EMBEDDING_MODEL` or `DEFAULT_EMBEDDING_MODEL`. */
  model?: string;
  signal?: AbortSignal;
};

/**
 * POST `{ baseUrl }/v1/embeddings` with JSON `{ model, input }`.
 * Returns one vector per input string, ordered by response `index`.
 */
export async function createEmbeddings(args: CreateEmbeddingsArgs): Promise<EmbeddingsResult> {
  const s = getResolvedSettings();
  const model = resolvedEmbeddingModel(args.model);
  const input = args.input;
  if (typeof input === "string") {
    if (input.length === 0) throw new Error("Embeddings: empty input string");
  } else if (Array.isArray(input)) {
    if (input.length === 0) throw new Error("Embeddings: empty input[]");
    for (let i = 0; i < input.length; i += 1) {
      if (typeof input[i] !== "string") {
        throw new Error(`Embeddings: input[${i}] not a string`);
      }
    }
  } else {
    throw new Error("Embeddings: input must be string or string[]");
  }
  const timeoutMs = s.llm.httpTimeoutMs;
  const signal = args.signal ?? AbortSignal.timeout(timeoutMs);
  return postEmbeddingsRequest(model, input, signal);
}

export type CreateEmbeddingMultimodalArgs = {
  parts: EmbeddingMultimodalPart[];
  model?: string;
  signal?: AbortSignal;
};

/**
 * Single multimodal document — `input` is chat-style `parts[]` (OpenAI-compatible servers may accept this on `/v1/embeddings`).
 */
export async function createEmbeddingFromParts(args: CreateEmbeddingMultimodalArgs): Promise<EmbeddingsResult> {
  const s = getResolvedSettings();
  if (!Array.isArray(args.parts) || args.parts.length === 0) {
    throw new Error("Embeddings: multimodal parts[] required");
  }
  const model = resolvedEmbeddingModel(args.model);
  const timeoutMs = s.llm.httpTimeoutMs;
  const signal = args.signal ?? AbortSignal.timeout(timeoutMs);
  return postEmbeddingsRequest(model, args.parts, signal);
}
