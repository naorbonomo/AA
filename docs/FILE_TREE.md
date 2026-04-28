# AA — file tree

**Keep this file aligned** whenever you add, rename, or repurpose paths under `AA/`.

Abbreviated layout (omit `node_modules`, `dist/`, generated logs):

```
AA/
├── docs/
│   └── FILE_TREE.md
├── app/
│   ├── electron/
│   │   ├── main.ts          # Electron main: window, IPC (LLM chat + stream, settings, secrets)
│   │   └── preload.cjs      # contextBridge → `window.aaDesktop` (must stay CommonJS; not emitted by `tsc`)
│   └── renderer/            # static HTML/JS/CSS (excluded from `tsc`; no bundler)
│       ├── chat.html        # Loads `chat.js`
│       ├── chat.js          # TAB: streamed `/v1/chat/completions`; thinking (blue card) + answer (green); expand/collapse thinking panel
│       ├── settings.html    # Loads `settings-page.js`; collapsible cards per topic; nav tabs ↔ chat
│       ├── settings-page.js
│       └── styles.css       # Viewport-relative sizing (`vw/vh/vmin/%/em`; hairlines only via `max(1px, …)` rule in file header)
├── config/
├── services/
├── utils/
├── cli.ts                   # Headless smoke: optional `tsx cli.ts` (`npm run cli`)
├── package.json
└── tsconfig.json
```

**Output / local files (often gitignored at repo root):**

- `dist/` — `tsc` emit (`main.js`, `cli.js`, `services/`, `config/`, `utils/`; **not** preload).
- `AA/user-settings.json` — non-secret overrides next to CLI when not using Electron `userData`.
- `userData/.env` (Electron) or `AA/.env` (CLI) — secrets (`TAVILY_API_KEY`, …); legacy `aa-secrets.json` migrated once to `.env`.
- `logs/aa.log` — when file logging enabled (dir name from config).

---

## Config (pattern similar to `backend/app/config/`)

| File | Role |
|------|------|
| `config/llm_config.ts` | Checked-in LM defaults: `baseUrl`, `model`, `temperature`, `httpTimeoutMs`. |
| `config/logging_config.ts` | Log dir/file names; console/file toggle defaults. |
| `config/agent_config.ts` | Agent defaults (`maxToolRounds`, `sessionLabel`, etc.). |
| `config/web_search_config.ts` | Tavily tool limits/timeouts; API key stored in secrets `tavily_api_key`. |
| `config/secrets_config.ts` | **Types + key names** for secrets; persisted as env vars in `.env` via `secrets-store`. |
| `config/user-settings.ts` | TypeScript types: `UserSettings` (partial overrides), resolved nested settings. |
| `config/user-settings.example.json` | Example nested JSON (`llm`, `logging`, `agent`). |
| `config/defaults.ts` | Aggregated re-export of topic defaults from `*_config.ts` modules. |
| `config/index.ts` | Package-style barrel: defaults, `logging`/`llm` aliases, `user-settings`, `secrets_config`. |
| `config/llm.ts`, `config/logging.ts` | Thin aliases for imports that expected these paths historically. |

**Runtime persistence**

- **Settings (nested, non-secret):** Electron loads/saves under `userData` (e.g. `aa-user-settings.json`); CLI can use `AA/user-settings.json` in cwd when not in Electron mode.
- **Secrets:** Electron `userData/.env` (`TAVILY_API_KEY`, etc.) + `process.env` on load/save; CLI `AA/.env`; legacy `aa-secrets.json` auto-migrated once. Masked hints in Settings UI.

**Where is the secrets `.env`?** — Implemented in `services/secrets-store.ts` → `getSecretsFilePath()`.

| Mode | Directory | File |
|------|-----------|------|
| Electron | `app.getPath("userData")` (shown in Settings beside “Secrets” + inside Secrets card). Examples: macOS `~/Library/Application Support/aa/` · Windows `%AppData%/aa/` · Linux `~/.config/aa/` | `.env` |
| CLI (`tsx` from repo) | `AA/` resolved from cwd (`user-settings.json` same pattern) | `.env` |

Keys in file: `TAVILY_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`. On start and on save, those are copied into `process.env`. If `aa-secrets.json` existed there, it is migrated once to `.env`, then renamed `aa-secrets.json.migrated`.

Legacy flat keys in older JSON shapes are normalized when read (user settings only).

---

## Services

| Module | Responsibility |
|--------|------------------|
| `services/llm.ts` | OpenAI-compat `POST /v1/chat/completions`: **`chatCompletion`** (JSON, `stream: false`), **`streamChatCompletion`** (SSE `stream: true`, splits `delta.reasoning_content` / `reasoning` / `thinking` vs `delta.content`). |
| `services/settings-store.ts` | Merge defaults + user JSON; paths for Electron vs CLI; get/snapshot/save/reload/reset. |
| `services/web-search.ts` | Agent `web_search` tool: Tavily REST + optional `tavily_short_answer`; key from `getSecrets().tavily_api_key` / `TAVILY_API_KEY`. |
| `services/secrets-store.ts` | Load/save canonical `.env`; legacy JSON migration; hydrate `process.env`; masked snapshot for renderer. |

`utils/env-file.ts` — parse/format dotenv fragments. **`utils/logger.ts`** reads resolved logging flags + paths.

---

## Electron IPC (`preload.cjs` → `window.aaDesktop`)

| Channel | Direction | Notes |
|---------|-----------|--------|
| `lm:chat` | invoke → main | `{ ok, text }` or `{ ok: false, error }` (non-streaming; still exposed). |
| `lm:chat-stream` | send ← renderer start | Main runs `streamChatCompletion`; emits `lm:chat-stream-delta`, then `lm:chat-stream-done` or `lm:chat-stream-error`. Wrapped as **`chatStream(messages, { onDelta })`** in preload. |
| `settings:get` / `:save` / `:reset` / `:reload` | invoke | Nested settings snapshots + patch save. |
| `secrets:get` / `:save` | invoke | Masked read; selective patch write. |

---

## npm scripts

| Script | Behavior |
|--------|----------|
| `npm run build` | `rimraf dist && tsc -p tsconfig.json` |
| `npm start` | `electron .` (needs prior `build`; `main` points at `dist/app/electron/main.js`) |
| `npm run electron:packed` | `build` then `electron .` |
| `npm run dev` | `build`, then concurrently: `tsc -w` and `wait-on dist/app/electron/main.js && electron .` (`preload.cjs` is not built) |
| `npm run cli` | `tsx cli.ts` smoke test |

---

## Conventions worth preserving

1. **`preload.cjs`**: compile **not** relied on — keep plain CommonJS `require`/`contextBridge`; ESM preload was known to fail silently (`aaDesktop` missing).
2. **Renderer sizing**: `%` / `vw` / `vh` / `vmin` / `em` — see comment at top of `app/renderer/styles.css`.
3. **Imports in TS**: compiled output uses `.js` extensions (`NodeNext`).
