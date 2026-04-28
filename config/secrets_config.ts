/** Secret key names — values live under `secrets-store` canonical `.env` (see AA `secrets_store`). Legacy JSON migrated once. */

/** Legacy JSON secrets file — superseded by `DOTENV_SECRET_BASENAME`. */
export const SECRETS_FILE_BASENAME = "aa-secrets.json";

/** Primary secrets filename in Electron userData / `AA/` (same keys as env names). */
export const DOTENV_SECRET_BASENAME = ".env";

/** Optional env fallback (same keys as backend where applicable). */

export type SecretsPayload = {
  /** Optional override; mirrors `TELEGRAM_BOT_TOKEN` in Smith backend `.env`. */
  telegram_bot_token?: string;
  /** OpenAI (`providerId` openai) + fallback for other LLM keys when dedicated secret missing. */
  openai_api_key?: string;
  groq_api_key?: string;
  cerebras_api_key?: string;
  /** Claude / Anthropic OpenAI-compat (`providerId` claude). */
  anthropic_api_key?: string;
  openrouter_api_key?: string;
  /** Tavily Search — `web_search` reads from `userData/.env` `TAVILY_API_KEY` (Electron Settings → Secrets → Save all). */
  tavily_api_key?: string;
};
