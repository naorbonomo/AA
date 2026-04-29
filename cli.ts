/** Headless entry: same settings + secrets as Electron (`userData`), no GUI. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatMessage } from "./services/llm.js";
import { chatCompletion, fetchOpenAiCompatibleModelIds, streamChatCompletion } from "./services/llm.js";
import { initializeSecretsStore } from "./services/secrets-store.js";
import { initializeSettingsStore, getSettingsFilePath } from "./services/settings-store.js";
import { initializeChatHistoryStore } from "./services/chat-history-store.js";
import { runChatWithWebSearchFromSettings, type AgentStepPayload } from "./services/agent-runner.js";
import { setTtsCacheDir } from "./services/tts-transformers.js";
import { setWhisperCacheDir } from "./services/whisper-transformers.js";
import { getLogger } from "./utils/logger.js";

const log = getLogger("cli");

function defaultUserDataDir(): string {
  const fromEnv = process.env.AA_USER_DATA?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "aa");
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const cfgRoot = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  return path.join(cfgRoot, "aa");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function printHelp(): void {
  process.stdout.write(`aa CLI — same LLM config as desktop (aa-user-settings.json + .env under user data).

Usage:
  npx tsx cli.ts [global-options] <command> [args]
  node dist/cli.js [global-options] <command> [args]

Global:
  --user-data DIR   Override config directory (or set AA_USER_DATA)
  --no-stream       Print full reply at once instead of streaming tokens
  --reasoning-stderr  Stream reasoning tokens to stderr (content stays stdout)

Commands:
  help              This text
  chat <message>    One-shot chat (no agent tools)
  agent <message>   Agent loop (web search, jobs, STT per settings)
  models            GET /v1/models (ids only, one per line)

Default user data (Ubuntu/macOS): $XDG_CONFIG_HOME/aa or ~/.config/aa
`);
}

type GlobalFlags = {
  userDataOverride?: string;
  stream: boolean;
  reasoningStderr: boolean;
  rest: string[];
};

function shiftGlobalFlags(argv: string[]): GlobalFlags {
  let userDataOverride: string | undefined;
  let stream = true;
  let reasoningStderr = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--user-data" || a === "-D") {
      userDataOverride = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--no-stream") {
      stream = false;
      continue;
    }
    if (a === "--stream") {
      stream = true;
      continue;
    }
    if (a === "--reasoning-stderr") {
      reasoningStderr = true;
      continue;
    }
    rest.push(a);
  }
  return { userDataOverride, stream, reasoningStderr, rest };
}

function consumeMessage(rest: string[]): string {
  if (rest[0] === "-m" || rest[0] === "--message") {
    return (rest[1] ?? "").trim();
  }
  return rest.join(" ").trim();
}

function formatAgentStep(p: AgentStepPayload): string {
  switch (p.kind) {
    case "web_search":
      if (p.status === "start") {
        return `[web_search] ${p.query}`;
      }
      return `[web_search] done query="${p.query}" hits=${p.hitCount} ok=${p.ok}`;
    case "schedule_job":
      return `[schedule_job] ${p.action} ok=${p.ok}${p.summary ? ` ${p.summary}` : ""}`;
    case "stt":
      if (p.status === "start") {
        return `[stt] ${p.file_name}`;
      }
      return `[stt] ${p.file_name} ok=${p.ok}`;
    case "tts":
      if (p.status === "start") {
        const prev = "preview" in p && typeof p.preview === "string" ? p.preview : "";
        return `[tts] ${prev || "…"}`;
      }
      return `[tts] ok=${p.ok}${"duration_seconds" in p && typeof p.duration_seconds === "number" ? ` ${p.duration_seconds}s` : ""}`;
    default:
      return JSON.stringify(p);
  }
}

async function cmdChat(message: string, stream: boolean, reasoningStderr: boolean): Promise<void> {
  if (!message) {
    throw new Error("chat: need non-empty message (see help)");
  }
  const messages: ChatMessage[] = [{ role: "user", content: message }];
  if (stream) {
    process.stderr.write(`# streaming → stdout${reasoningStderr ? " (reasoning → stderr)" : ""}\n`);
    await streamChatCompletion({ messages }, (d) => {
      if (d.reasoning) {
        if (reasoningStderr) {
          process.stderr.write(d.reasoning);
        } else {
          process.stdout.write(d.reasoning);
        }
      }
      if (d.content) {
        process.stdout.write(d.content);
      }
    });
    process.stdout.write("\n");
    return;
  }
  const text = await chatCompletion({ messages });
  process.stdout.write(`${text}\n`);
}

async function cmdAgent(message: string, stream: boolean, reasoningStderr: boolean): Promise<void> {
  if (!message) {
    throw new Error("agent: need non-empty message (see help)");
  }
  const history: ChatMessage[] = [{ role: "user", content: message }];
  process.stderr.write(`# agent steps → stderr\n`);
  const out = await runChatWithWebSearchFromSettings(
    history,
    (step) => {
      process.stderr.write(`${formatAgentStep(step)}\n`);
    },
    stream
      ? (d) => {
          if (d.reasoning) {
            if (reasoningStderr) {
              process.stderr.write(d.reasoning);
            } else {
              process.stdout.write(d.reasoning);
            }
          }
          if (d.content) {
            process.stdout.write(d.content);
          }
        }
      : undefined,
  );
  if (!stream) {
    process.stdout.write(`${out.text}\n`);
  } else {
    process.stdout.write("\n");
  }
  if (out.usage) {
    process.stderr.write(`# usage: ${JSON.stringify(out.usage)}\n`);
  }
}

async function cmdModels(): Promise<void> {
  const r = await fetchOpenAiCompatibleModelIds();
  if (!r.ok) {
    throw new Error(r.error);
  }
  for (const id of r.ids.sort()) {
    process.stdout.write(`${id}\n`);
  }
}

export async function runCli(argv: string[]): Promise<void> {
  const { userDataOverride, stream, reasoningStderr, rest: positional } = shiftGlobalFlags(argv);
  const cmd = (positional[0] ?? "help").toLowerCase();
  const rest = positional.slice(1);

  const ud = userDataOverride ? path.resolve(userDataOverride) : defaultUserDataDir();
  ensureDir(ud);
  initializeSettingsStore({ userDataDir: ud });
  initializeSecretsStore({ userDataDir: ud });
  initializeChatHistoryStore({ userDataDir: ud });
  setWhisperCacheDir(path.join(ud, "whisper-models"));
  setTtsCacheDir(path.join(ud, "tts-models"));

  log.info("cli userData", ud);
  log.info("settings", getSettingsFilePath());

  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    case "chat": {
      const message = consumeMessage(rest);
      await cmdChat(message, stream, reasoningStderr);
      return;
    }
    case "agent": {
      const message = consumeMessage(rest);
      await cmdAgent(message, stream, reasoningStderr);
      return;
    }
    case "models":
      await cmdModels();
      return;
    default:
      printHelp();
      process.stderr.write(`\nUnknown command: ${cmd}\n`);
      process.exitCode = 2;
  }
}

function isCliMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isCliMain()) {
  void runCli(process.argv.slice(2)).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${msg}\n`);
    process.exitCode = 1;
  });
}
