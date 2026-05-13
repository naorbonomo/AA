/** Nested runtime overrides — aligns with topic `*_config.ts` modules. Supports legacy flat keys on read. */

import type { WhisperModelSize } from "./whisper_config.js";

export type UserLlm = {
  /** Preset id from `LLM_PROVIDERS` (`lm_studio`, `openai`, …). */
  provider?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  httpTimeoutMs?: number;
  /** When true, user-attached images are sent as OpenAI-style `image_url` parts (model must support vision). */
  vision?: boolean;
};

export type UserLogging = {
  logToFile?: boolean;
  logToConsole?: boolean;
  /** Verbose tool tracing to file/console (see `logging_config.ts`). */
  logTools?: boolean;
};

export type UserAgent = {
  maxToolRounds?: number;
  sessionLabel?: string;
  /** Preset id from `SYSTEM_PROMPTS`; invalid/missing merges to default preset. */
  promptKey?: string;
  /** Full system message; when non-empty after trim, replaces preset content (Smith `system_prompt`). */
  systemPrompt?: string;
};

/** App-wide clock: scheduling + labels use this IANA zone (empty = device zone). */
export type UserAppTime = {
  timeZone?: string;
  /** Optional display line; when empty, derived from zone (generic name + IANA). */
  regionLabel?: string;
};

/** Local Whisper (Transformers.js); models load from Hugging Face on first use. */
export type UserWhisper = {
  modelSize?: WhisperModelSize;
  quantized?: boolean;
  multilingual?: boolean;
};

/** Telegram ingress (Smith-style: long-poll and/or local webhook). Token in Secrets (`telegram_bot_token`). */
export type UserTelegram = {
  /** `getUpdates` loop in main process (default true). */
  usePolling?: boolean;
  /** HTTP `POST /telegram/webhook` on this port; 0 = off (default). Bind `127.0.0.1` only — use tunnel for cloud. */
  webhookPort?: number;
  /**
   * Fallback Telegram `chat_id` when a scheduled job delivers to Telegram but has no per-job id.
   * When omitted/null, first inbound Telegram message (any update) saves that chat id here.
   */
  schedulerDefaultChatId?: number | null;
};

/** Chat UI-only preferences (no model impact). */
export type UserChat = {
  /** When true, Chat tab merges Telegram transcripts (read-only) with desktop history, sorted by time. */
  showTelegramMirror?: boolean;
};

/** OpenAI-compat embeddings (`POST /v1/embeddings`); uses same Base URL + Bearer as LLM. */
export type UserEmbedding = {
  /** Embedding model id served at `{LLM base}/v1/embeddings`. */
  model?: string;
  /**
   * Vector length stored in sqlite-vec — must match API output row length.
   * Changing after `aa-embeddings.sqlite` exists requires new DB or matching prior dim.
   */
  vecDimension?: number;
};

export type UserSettings = {
  llm?: UserLlm;
  logging?: UserLogging;
  agent?: UserAgent;
  appTime?: UserAppTime;
  whisper?: UserWhisper;
  telegram?: UserTelegram;
  chat?: UserChat;
  embedding?: UserEmbedding;

  /** @deprecated Legacy flat layout — migrated on load. */
  llmBaseUrl?: string;
  llmModel?: string;
  llmTemperature?: number;
  llmHttpTimeoutMs?: number;
  logToFile?: boolean;
  logToConsole?: boolean;
};

export type ResolvedLlm = {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  httpTimeoutMs: number;
  vision: boolean;
};

export type ResolvedLogging = {
  logToFile: boolean;
  logToConsole: boolean;
  logTools: boolean;
};

export type ResolvedAgent = {
  maxToolRounds: number;
  sessionLabel: string;
  promptKey: string;
  /** Stored trimmed override only when user set non-empty body; merged preset used when omitted. */
  systemPrompt?: string;
};

/** Single resolved clock for the app (always valid IANA + label). */
export type ResolvedAppTime = {
  timeZone: string;
  regionLabel: string;
  /** OS-reported IANA zone (for “device” line in UI). */
  deviceTimeZone: string;
};

export type ResolvedWhisper = {
  modelSize: WhisperModelSize;
  quantized: boolean;
  multilingual: boolean;
};

export type ResolvedTelegram = {
  usePolling: boolean;
  webhookPort: number;
  /** Resolved integer chat id or null when unset. */
  schedulerDefaultChatId: number | null;
};

export type ResolvedChat = {
  showTelegramMirror: boolean;
};

export type ResolvedEmbedding = {
  model: string;
  vecDimension: number;
};

export type ResolvedAppSettings = {
  llm: ResolvedLlm;
  logging: ResolvedLogging;
  agent: ResolvedAgent;
  appTime: ResolvedAppTime;
  whisper: ResolvedWhisper;
  telegram: ResolvedTelegram;
  chat: ResolvedChat;
  embedding: ResolvedEmbedding;
};
