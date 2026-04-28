/** Secret key names — values live under `secrets-store` canonical `.env` (see AA `secrets_store`). Legacy JSON migrated once. */

/** Legacy JSON secrets file — superseded by `DOTENV_SECRET_BASENAME`. */
export const SECRETS_FILE_BASENAME = "aa-secrets.json";

/** Primary secrets filename in Electron userData / `AA/` (same keys as env names). */
export const DOTENV_SECRET_BASENAME = ".env";

/** Optional env fallback (same keys as backend where applicable). */

export type SecretsPayload = {
  /** Optional override; mirrors `TELEGRAM_BOT_TOKEN` in Smith backend `.env`. */
  telegram_bot_token?: string;
  /** Optional OpenAI-compat API key when provider requires Bearer auth (LM Studio usually does not). */
  openai_api_key?: string;
  /** Tavily Search — `web_search` reads from `userData/.env` `TAVILY_API_KEY` (Electron Settings → Secrets → Save all). */
  tavily_api_key?: string;
};
