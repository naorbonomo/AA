/** Smoke test for `web_search` Tavily path — same `.env` as app: set `AA_USER_DATA` to Electron userData (see Settings path) or put `TAVILY_API_KEY` in `AA/.env` when running from repo. */

import { initializeSecretsStore } from "../services/secrets-store.js";
import { initializeSettingsStore } from "../services/settings-store.js";
import { webSearch } from "../services/web-search.js";

async function main(): Promise<void> {
  const ud = typeof process.env.AA_USER_DATA === "string" ? process.env.AA_USER_DATA.trim() : "";
  initializeSettingsStore(ud ? { userDataDir: ud } : undefined);
  initializeSecretsStore(ud ? { userDataDir: ud } : undefined);

  const q =
    process.argv.slice(2).join(" ").trim() || "current weather in Stockholm Sweden one line";
  const out = await webSearch(q, { maxResults: 3 });
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) {
    console.error(
      "Missing key: Electron → Settings → Secrets → paste Tavily key → Save all (writes userData .env). CLI: create AA/.env with TAVILY_API_KEY=... OR export AA_USER_DATA= path to that folder.",
    );
    process.exitCode = 1;
  }
}

void main();
