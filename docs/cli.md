# aa CLI

Headless entry for same stack as Electron main: `user-settings` merge, `.env` secrets, LLM + agent runner. No window, **no scheduler engine** (scheduled jobs don’t run from CLI).

## Requirements

- Node 22+ recommended (matches project tooling).
- Built JS: `npm run build` → run `node dist/cli.js`.
- Or dev: `npm run cli -- <args>` (uses `tsx cli.ts`).

## Config directory

CLI reads **`aa-user-settings.json`** and **`.env`** inside one directory (created if missing).

| Source | Path |
|--------|------|
| `AA_USER_DATA` env | Absolute path you set |
| `--user-data DIR` / `-D DIR` | Overrides for one run |
| Linux / macOS | `$XDG_CONFIG_HOME/aa` if `XDG_CONFIG_HOME` set and absolute, else `~/.config/aa` |
| Windows | `%AppData%\aa` (`~/AppData/Roaming/aa`) |

Point `AA_USER_DATA` at Electron `userData` folder if you want one shared config with desktop.

Whisper model cache: `<userData>/whisper-models`.

## Global options

Place **before** the subcommand.

| Flag | Effect |
|------|--------|
| `--user-data DIR`, `-D DIR` | Config root |
| `--no-stream` | Full reply at end (no token streaming) |
| `--stream` | Force streaming (default for `chat` / `agent`) |
| `--reasoning-stderr` | Reasoning deltas → stderr; answer body stays stdout (easier piping) |

## Commands

### `help`

Print usage. Aliases: `-h`, `--help`.

### `chat <message>`

Single user turn → `/v1/chat/completions`. **No** agent tools (no web search, schedule, STT).

Message: all words after `chat`, or `-m` / `--message` plus one string.

Examples:

```bash
node dist/cli.js chat What is 2+2?
node dist/cli.js chat -m "multi word question"
npm run cli -- chat --no-stream hello
```

### `agent <message>`

Same agent loop as UI: tools per settings (web search, `schedule_job`, STT). Agent step lines go to **stderr**; streamed (or final) assistant text to **stdout**.

```bash
node dist/cli.js agent "brief web search: latest Node LTS version"
```

### `models`

Calls `GET /v1/models` on configured base URL; prints sorted ids, one per line.

```bash
node dist/cli.js models
```

## Output

- **stdout**: assistant text (`chat` / `agent`). With `--reasoning-stderr`, only non-reasoning content on stdout for streams.
- **stderr**: logger lines (`[cli] [INFO] …`), agent step traces (`# agent steps → stderr`), optional `# streaming` hint, `# usage` JSON after `agent`, reasoning tokens if `--reasoning-stderr`.

Pipe answer only (roughly):

```bash
node dist/cli.js chat --reasoning-stderr "hello" 2>/dev/null
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error (e.g. LLM failure, empty message) |
| 2 | Unknown subcommand |

## Programmatic use

`runCli(string[])` exported from `cli.ts` for tests or wrappers; main only runs when executed as entry script.
