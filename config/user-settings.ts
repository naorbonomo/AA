/** Nested runtime overrides — aligns with topic `*_config.ts` modules. Supports legacy flat keys on read. */

export type UserLlm = {
  /** Preset id from `LLM_PROVIDERS` (`lm_studio`, `openai`, …). */
  provider?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  httpTimeoutMs?: number;
};

export type UserLogging = {
  logToFile?: boolean;
  logToConsole?: boolean;
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

export type UserSettings = {
  llm?: UserLlm;
  logging?: UserLogging;
  agent?: UserAgent;
  appTime?: UserAppTime;

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
};

export type ResolvedLogging = {
  logToFile: boolean;
  logToConsole: boolean;
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

export type ResolvedAppSettings = {
  llm: ResolvedLlm;
  logging: ResolvedLogging;
  agent: ResolvedAgent;
  appTime: ResolvedAppTime;
};
