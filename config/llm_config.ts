/** LLM endpoints, timeouts (parity with `backend/app/config/llm_config.ts`, TS slice for AA). */

/** OpenAI-compat server base (no trailing slash). */
export const LLM_DEFAULT_BASE_URL = "http://192.168.0.166:1234";

/** Default `model` in `POST /v1/chat/completions`. */
export const LLM_DEFAULT_MODEL = "qwen3.6-35b-a3b-turboquant-mlx";

export const LLM_DEFAULT_TEMPERATURE = 0.2;

/** Single POST timeout (ms). */
export const LLM_DEFAULT_HTTP_TIMEOUT_MS = 3_600_000;
