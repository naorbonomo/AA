/** Nested runtime overrides — aligns with topic `*_config.ts` modules. Supports legacy flat keys on read. */

export type UserLlm = {
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

export type UserSettings = {
  llm?: UserLlm;
  logging?: UserLogging;
  agent?: UserAgent;

  /** @deprecated Legacy flat layout — migrated on load. */
  llmBaseUrl?: string;
  llmModel?: string;
  llmTemperature?: number;
  llmHttpTimeoutMs?: number;
  logToFile?: boolean;
  logToConsole?: boolean;
};

export type ResolvedLlm = {
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

export type ResolvedAppSettings = {
  llm: ResolvedLlm;
  logging: ResolvedLogging;
  agent: ResolvedAgent;
};
