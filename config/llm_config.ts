/** LLM endpoints, timeouts (parity with `backend/app/config/llm_config.ts`, TS slice for AA). */

/** OpenAI-compat server base (no trailing slash). */
export const LLM_DEFAULT_BASE_URL = "http://192.168.0.166:1234";

/** Default `model` in `POST /v1/chat/completions`. */
export const LLM_DEFAULT_MODEL = "qwen3.6-35b-a3b-turboquant-mlx";

export const LLM_DEFAULT_TEMPERATURE = 0.2;

/** Single POST timeout (ms). */
export const LLM_DEFAULT_HTTP_TIMEOUT_MS = 3_600_000;

/** Preset id used when `llm.provider` missing / unknown (LM Studio local compat). */
export const LLM_DEFAULT_PROVIDER_ID = "lm_studio";

/** Settings UI + merge: each provider has default base URL and optional dropdown model ids. */
export type LlmProviderPreset = {
  id: string;
  label: string;
  defaultBaseUrl: string;
  /** Empty = model id is free text (typical for LM Studio). */
  models: readonly string[];
  /** Used when user has no stored model yet. */
  defaultModel: string;
};

export const LLM_PROVIDERS: readonly LlmProviderPreset[] = [
  {
    id: "lm_studio",
    label: "LM Studio (local)",
    defaultBaseUrl: LLM_DEFAULT_BASE_URL,
    models: [],
    defaultModel: LLM_DEFAULT_MODEL,
  },
  {
    id: "openai",
    label: "OpenAI API",
    defaultBaseUrl: "https://api.openai.com",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3-mini"],
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    defaultBaseUrl: "https://api.cerebras.ai",
    models: [
      "llama3.1-8b",
      "gpt-oss-120b",
      "qwen-3-235b-a22b-instruct-2507",
      "zai-glm-4.7",
    ],
    defaultModel: "llama3.1-8b",
  },
  {
    id: "claude",
    label: "Claude (Anthropic · OpenAI-compat)",
    defaultBaseUrl: "https://api.anthropic.com",
    models: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-haiku-4-20250514",
      "claude-3-5-haiku-20241022",
    ],
    defaultModel: "claude-sonnet-4-20250514",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api",
    models: [
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "google/gemini-2.0-flash-001",
    ],
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible URL)",
    defaultBaseUrl: "http://127.0.0.1:1234",
    models: [],
    defaultModel: LLM_DEFAULT_MODEL,
  },
];

export function getLlmProviderPreset(id: string): LlmProviderPreset | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/** Resolve preset id from explicit `user.provider` or URL heuristics (legacy files without `provider`). */
export function inferLlmProviderId(user: { provider?: string; baseUrl?: string }): string {
  const explicit = typeof user.provider === "string" ? user.provider.trim() : "";
  if (explicit && getLlmProviderPreset(explicit)) {
    return explicit;
  }
  const bu = typeof user.baseUrl === "string" ? user.baseUrl.trim().toLowerCase() : "";
  if (!bu) {
    return LLM_DEFAULT_PROVIDER_ID;
  }
  if (bu.includes("api.openai.com")) {
    return "openai";
  }
  if (bu.includes("api.groq.com")) {
    return "groq";
  }
  if (bu.includes("api.cerebras.ai")) {
    return "cerebras";
  }
  if (bu.includes("api.anthropic.com")) {
    return "claude";
  }
  if (bu.includes("openrouter.ai")) {
    return "openrouter";
  }
  return LLM_DEFAULT_PROVIDER_ID;
}
