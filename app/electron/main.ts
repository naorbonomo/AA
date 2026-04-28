/** Electron main: IPC for LLM, nested settings + secrets stores. */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, Notification, app, ipcMain } from "electron";

import type { SecretsPayload } from "../../config/secrets_config.js";
import type { UserAgent, UserAppTime, UserLogging, UserLlm, UserSettings } from "../../config/user-settings.js";
import type { ChatMessage, ChatUsageSnapshot, StreamDelta } from "../../services/llm.js";
import { chatCompletion, fetchOpenAiCompatibleModelIds, streamChatCompletion } from "../../services/llm.js";
import { listSystemPromptsMeta } from "../../config/system_prompts.js";
import { runChatWithWebSearchFromSettings, type AgentStepPayload } from "../../services/agent-runner.js";
import { webSearch } from "../../services/web-search.js";
import {
  getSecretsSnapshot,
  initializeSecretsStore,
  reloadSecretsFromDisk,
  saveSecretsPatch,
} from "../../services/secrets-store.js";
import {
  getResolvedSettings,
  getSettingsFilePath,
  getSettingsSnapshot,
  initializeSettingsStore,
  reloadSettingsFromDisk,
  resetUserSettingsFile,
  saveUserSettingsPatch,
} from "../../services/settings-store.js";
import { getLogger } from "../../utils/logger.js";
import { utcMsToWallDatetimeLocalValue, wallDateTimeInZoneToUtcMs } from "../../utils/app-time.js";
import { initializeChatHistoryStore, readChatHistory, writeChatHistory } from "../../services/chat-history-store.js";
import {
  initializeSchedulerStore,
  createScheduledJob,
  deleteScheduledJob,
  getSchedulerJobsFilePath,
  listScheduledJobsWithMeta,
  updateScheduledJob,
  type CreateScheduledJobInput,
  type UpdateScheduledJobPatch,
} from "../../services/scheduler-store.js";
import { runScheduledJobNow, startSchedulerEngine } from "../../services/scheduler-engine.js";

const log = getLogger("electron-main");

const __electronDir = path.dirname(fileURLToPath(import.meta.url));

function aaRoot(): string {
  return path.resolve(__electronDir, "..", "..", "..");
}

function rendererHtmlPath(): string {
  return path.join(aaRoot(), "app", "renderer", "chat.html");
}

function createWindow(): void {
  const s = getResolvedSettings();
  log.info("open window", {
    preload: path.join(aaRoot(), "app", "electron", "preload.cjs"),
    llmUrl: `${s.llm.baseUrl}/v1/chat/completions`,
    settingsFile: getSettingsFilePath(),
  });

  const win = new BrowserWindow({
    width: 960,
    height: 820,
    backgroundColor: "#0a0a0c",
    webPreferences: {
      preload: path.join(aaRoot(), "app", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void win.loadFile(rendererHtmlPath());
}

ipcMain.handle("chat-history:get", () => {
  try {
    return { ok: true as const, rows: readChatHistory() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("chat-history:get", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("chat-history:save", (_e, rows: unknown) => {
  try {
    writeChatHistory(Array.isArray(rows) ? rows : []);
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("chat-history:save", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("lm:chat", async (_event, messages: ChatMessage[]) => {
  try {
    const text = await chatCompletion({ messages });
    return { ok: true as const, text };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error("lm:chat", err);
    return { ok: false as const, error: err };
  }
});

/** Token stream: `lm:chat-stream-delta` (tokens), then `lm:chat-stream-done` { wallMs, usage? }. */
ipcMain.on("lm:chat-stream", (event, messages: ChatMessage[]) => {
  const wc = event.sender;
  void (async () => {
    try {
      const { wallMs, usage, system_fingerprint } = await streamChatCompletion(
        { messages },
        (d: StreamDelta) => {
          if (!wc.isDestroyed()) {
            wc.send("lm:chat-stream-delta", d);
          }
        },
      );
      const payload: {
        wallMs: number;
        usage?: ChatUsageSnapshot | null;
        system_fingerprint?: string | null;
      } = {
        wallMs,
        usage: usage ?? null,
        system_fingerprint: system_fingerprint ?? null,
      };
      if (!wc.isDestroyed()) {
        wc.send("lm:chat-stream-done", payload);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("lm:chat-stream", msg);
      if (!wc.isDestroyed()) {
        wc.send("lm:chat-stream-error", { message: msg });
      }
    }
  })();
});

ipcMain.handle("settings:get", () => getSettingsSnapshot());

ipcMain.handle("settings:save", (_e, patch: unknown) =>
  saveUserSettingsPatch(sanitizeSettingsPatch(patch)),
);

ipcMain.handle("settings:reset", () => resetUserSettingsFile());

ipcMain.handle("settings:reload", () => {
  const r = reloadSettingsFromDisk();
  reloadSecretsFromDisk();
  return r;
});

ipcMain.handle("prompts:list", () => ({
  prompts: listSystemPromptsMeta(),
}));

ipcMain.handle("secrets:get", () => getSecretsSnapshot());

ipcMain.handle("secrets:save", (_e, patch: unknown) =>
  saveSecretsPatch(sanitizeSecretsPatch(patch as Partial<SecretsPayload>)),
);

ipcMain.handle("scheduler:list", () => {
  try {
    return {
      ok: true as const,
      jobs: listScheduledJobsWithMeta(),
      filePath: getSchedulerJobsFilePath(),
      notifySupported: Notification.isSupported(),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("scheduler:list", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("scheduler:create", (_e, raw: unknown) => {
  try {
    const input = sanitizeSchedulerCreate(raw);
    const r = createScheduledJob(input);
    if (!r.ok) {
      return { ok: false as const, error: r.error };
    }
    return { ok: true as const, job: r.job };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("scheduler:create", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("scheduler:update", (_e, raw: unknown) => {
  try {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const patch = sanitizeSchedulerPatch(o.patch);
    const r = updateScheduledJob(id, patch);
    if (!r.ok) {
      return { ok: false as const, error: r.error };
    }
    return { ok: true as const, job: r.job };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("scheduler:update", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("scheduler:delete", (_e, id: unknown) => {
  try {
    const jid = typeof id === "string" ? id.trim() : "";
    const r = deleteScheduledJob(jid);
    if (!r.ok) {
      return { ok: false as const, error: r.error };
    }
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("scheduler:delete", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("app-time:wall-to-utc-iso", (_e, raw: unknown) => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const wall = typeof o.wall === "string" ? o.wall.trim() : "";
  const tzRaw = typeof o.timeZone === "string" ? o.timeZone.trim() : "";
  const tz = tzRaw.length > 0 ? tzRaw : getResolvedSettings().appTime.timeZone;
  if (!wall) {
    return { ok: false as const, error: "wall required" };
  }
  try {
    const ms = wallDateTimeInZoneToUtcMs(wall, tz);
    return { ok: true as const, iso: new Date(ms).toISOString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("app-time:utc-to-wall", (_e, raw: unknown) => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ms = Number(o.ms);
  const tzRaw = typeof o.timeZone === "string" ? o.timeZone.trim() : "";
  const tz = tzRaw.length > 0 ? tzRaw : getResolvedSettings().appTime.timeZone;
  if (!Number.isFinite(ms)) {
    return { ok: false as const, error: "ms required" };
  }
  try {
    const wall = utcMsToWallDatetimeLocalValue(ms, tz);
    return { ok: true as const, wall };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false as const, error: msg };
  }
});

/** OpenAI-compat `GET /v1/models` for current LLM Base URL + Bearer (same chain as chat). */
ipcMain.handle("llm:listModels", async () => {
  try {
    return await fetchOpenAiCompatibleModelIds();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("llm:listModels", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("scheduler:runNow", async (_e, id: unknown) => {
  try {
    const jid = typeof id === "string" ? id.trim() : "";
    const r = await runScheduledJobNow(jid);
    if (!r.ok) {
      return { ok: false as const, error: r.error };
    }
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("scheduler:runNow", msg);
    return { ok: false as const, error: msg };
  }
});

/**
 * Agent turn with `web_search` + `schedule_job` tools.
 * Sends `agent:step` for each tool step, `agent:stream-delta` for token/reasoning deltas. Returns `{ ok, text, steps, usage }`.
 */
ipcMain.handle("agent:chat", async (event, messages: unknown) => {
  if (!Array.isArray(messages)) {
    return { ok: false as const, error: "messages must be an array" };
  }
  const hist: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      continue;
    }
    const o = m as { role?: unknown; content?: unknown };
    const role = o.role === "user" ? "user" : o.role === "assistant" ? "assistant" : o.role === "system" ? "system" : null;
    if (!role || typeof o.content !== "string") {
      continue;
    }
    hist.push({ role, content: o.content });
  }
  const wc = event.sender;
  try {
    const out = await runChatWithWebSearchFromSettings(
      hist,
      (p: AgentStepPayload) => {
        if (!wc.isDestroyed()) {
          wc.send("agent:step", p);
        }
      },
      (d: StreamDelta) => {
        if (!wc.isDestroyed()) {
          wc.send("agent:stream-delta", d);
        }
      },
    );
    return {
      ok: true as const,
      text: out.text,
      steps: out.steps,
      usage: out.usage ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("agent:chat", msg);
    return { ok: false as const, error: msg };
  }
});

/** Web search tool (Tavily) — args `{ query, maxResults? }`. */
ipcMain.handle("tools:webSearch", async (_e, raw: unknown) => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const query = typeof o.query === "string" ? o.query : "";
  const maxResults =
    o.maxResults !== undefined && typeof o.maxResults === "number" && Number.isFinite(o.maxResults)
      ? Math.floor(o.maxResults)
      : undefined;
  return webSearch(query, maxResults !== undefined ? { maxResults } : {});
});

function sanitizeSecretsPatch(patch: Partial<SecretsPayload>): Partial<SecretsPayload> {
  const out: Partial<SecretsPayload> = {};
  if (patch.telegram_bot_token !== undefined) {
    out.telegram_bot_token = patch.telegram_bot_token;
  }
  if (patch.openai_api_key !== undefined) {
    out.openai_api_key = patch.openai_api_key;
  }
  if (patch.groq_api_key !== undefined) {
    out.groq_api_key = patch.groq_api_key;
  }
  if (patch.cerebras_api_key !== undefined) {
    out.cerebras_api_key = patch.cerebras_api_key;
  }
  if (patch.anthropic_api_key !== undefined) {
    out.anthropic_api_key = patch.anthropic_api_key;
  }
  if (patch.openrouter_api_key !== undefined) {
    out.openrouter_api_key = patch.openrouter_api_key;
  }
  if (patch.tavily_api_key !== undefined) {
    out.tavily_api_key = patch.tavily_api_key;
  }
  return out;
}

function sanitizeSchedulerCreate(raw: unknown): CreateScheduledJobInput {
  if (!raw || typeof raw !== "object") {
    return { prompt: "", schedule: { kind: "interval", intervalMinutes: 60 } };
  }
  const o = raw as Record<string, unknown>;
  const prompt = typeof o.prompt === "string" ? o.prompt : "";
  const title = typeof o.title === "string" ? o.title : undefined;
  const enabled = typeof o.enabled === "boolean" ? o.enabled : undefined;
  const notify = typeof o.notify === "boolean" ? o.notify : undefined;
  const scheduleRaw = o.schedule;
  let schedule: CreateScheduledJobInput["schedule"] = { kind: "interval", intervalMinutes: 60 };
  if (scheduleRaw && typeof scheduleRaw === "object") {
    const s = scheduleRaw as Record<string, unknown>;
    if (s.kind === "once" && typeof s.runAtIso === "string") {
      schedule = { kind: "once", runAtIso: s.runAtIso };
    } else if (s.kind === "interval") {
      const n = Number(s.intervalMinutes);
      schedule = {
        kind: "interval",
        intervalMinutes: Number.isFinite(n) ? n : 60,
      };
    }
  }
  return { prompt, title, enabled, notify, schedule };
}

function sanitizeSchedulerPatch(raw: unknown): UpdateScheduledJobPatch {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const o = raw as Record<string, unknown>;
  const patch: UpdateScheduledJobPatch = {};
  if (typeof o.title === "string") {
    patch.title = o.title;
  }
  if (typeof o.prompt === "string") {
    patch.prompt = o.prompt;
  }
  if (typeof o.enabled === "boolean") {
    patch.enabled = o.enabled;
  }
  if (typeof o.notify === "boolean") {
    patch.notify = o.notify;
  }
  if (o.schedule && typeof o.schedule === "object") {
    const s = o.schedule as Record<string, unknown>;
    if (s.kind === "once" && typeof s.runAtIso === "string") {
      patch.schedule = { kind: "once", runAtIso: s.runAtIso };
    } else if (s.kind === "interval") {
      const n = Number(s.intervalMinutes);
      patch.schedule = {
        kind: "interval",
        intervalMinutes: Number.isFinite(n) ? n : 60,
      };
    }
  }
  return patch;
}

function sanitizeSettingsPatch(raw: unknown): Partial<UserSettings> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const o = raw as Record<string, unknown>;
  const out: Partial<UserSettings> = {};

  if ("llm" in o && o.llm && typeof o.llm === "object") {
    const l = o.llm as Record<string, unknown>;
    const llm: Partial<UserLlm> = {};
    if (typeof l.provider === "string") llm.provider = l.provider.trim();
    if (typeof l.baseUrl === "string") llm.baseUrl = l.baseUrl.trim();
    if (typeof l.model === "string") llm.model = l.model.trim();
    if (l.temperature !== undefined) {
      const t = Number(l.temperature);
      if (Number.isFinite(t)) llm.temperature = t;
    }
    if (l.httpTimeoutMs !== undefined) {
      const ms = Number(l.httpTimeoutMs);
      if (Number.isFinite(ms) && ms > 0) llm.httpTimeoutMs = ms;
    }
    if (Object.keys(llm).length) out.llm = llm as UserLlm;
  }

  if ("logging" in o && o.logging && typeof o.logging === "object") {
    const g = o.logging as Record<string, unknown>;
    const logging: Partial<UserLogging> = {};
    if (typeof g.logToFile === "boolean") logging.logToFile = g.logToFile;
    if (typeof g.logToConsole === "boolean") logging.logToConsole = g.logToConsole;
    if (Object.keys(logging).length) out.logging = logging as UserLogging;
  }

  if ("agent" in o && o.agent && typeof o.agent === "object") {
    const a = o.agent as Record<string, unknown>;
    const agent: Partial<UserAgent> = {};
    if (a.maxToolRounds !== undefined) {
      const n = Number(a.maxToolRounds);
      if (Number.isFinite(n) && n >= 1 && n <= 500) agent.maxToolRounds = Math.floor(n);
    }
    if (typeof a.sessionLabel === "string") agent.sessionLabel = a.sessionLabel.trim();
    if (typeof a.promptKey === "string") agent.promptKey = a.promptKey.trim();
    if (typeof a.systemPrompt === "string") agent.systemPrompt = a.systemPrompt;
    if (Object.keys(agent).length) out.agent = agent as UserAgent;
  }

  if ("appTime" in o && o.appTime && typeof o.appTime === "object") {
    const a = o.appTime as Record<string, unknown>;
    const appTime: Partial<UserAppTime> = {};
    if (typeof a.timeZone === "string") {
      appTime.timeZone = a.timeZone.trim();
    }
    if (typeof a.regionLabel === "string") {
      appTime.regionLabel = a.regionLabel.trim();
    }
    if (Object.keys(appTime).length) {
      out.appTime = appTime as UserAppTime;
    }
  }

  return out;
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.github.aa.desktop");
  }
  const ud = app.getPath("userData");
  initializeSettingsStore({ userDataDir: ud });
  initializeSecretsStore({ userDataDir: ud });
  initializeChatHistoryStore({ userDataDir: ud });
  initializeSchedulerStore({ userDataDir: ud });
  log.info("userData", ud);
  log.info("settings file", getSettingsFilePath());
  log.info("scheduler jobs file", getSchedulerJobsFilePath());
  startSchedulerEngine();

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
