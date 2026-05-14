/** Electron main: IPC for LLM, nested settings + secrets stores. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, Notification, app, dialog, ipcMain, type OpenDialogOptions, type WebContents } from "electron";

import type { SecretsPayload } from "../../config/secrets_config.js";
import type {
  UserAgent,
  UserAppTime,
  UserChat,
  UserEmbedding,
  UserLogging,
  UserLlm,
  UserSettings,
  UserTelegram,
  UserWhisper,
} from "../../config/user-settings.js";
import type { ChatImagePart, ChatMessage, ChatUsageSnapshot, StreamDelta } from "../../services/llm.js";
import { chatCompletion, fetchOpenAiCompatibleModelIds, streamChatCompletion } from "../../services/llm.js";
import { listSystemPromptsMeta } from "../../config/system_prompts.js";
import { runChatWithWebSearchFromSettings, type AgentStepPayload } from "../../services/agent-runner.js";
import type { StagedAudioClip } from "../../services/whisper-transcribe-tool.js";
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
import {
  initializeChatHistoryStore,
  writeChatHistory,
  readChatHistoryLossless,
  parseChatHistoryRowLossless,
  type ChatHistoryRow,
} from "../../services/chat-history-store.js";
import {
  initializeImportedChatSessionsStore,
  mergeImportedChatSessions,
  readImportedChatSessionsLossless,
} from "../../services/imported-chat-sessions-store.js";
import {
  getEmbeddingVectorStoreInitError,
  initializeEmbeddingVectorStore,
  isEmbeddingVectorStoreReady,
  listEmbeddingBodies,
} from "../../services/embedding-vector-store.js";
import { readChatHistoryForDisplay } from "../../services/chat-display-merge.js";
import { initializeTelegramHistoryStore } from "../../services/telegram-history-store.js";
import {
  configureTelegramAppIconPath,
  configureTelegramUserDataDir,
  startTelegramIntegration,
  stopTelegramIntegration,
  type TelegramIntegrationHandles,
} from "../../services/telegram-channel.js";
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
import { setTtsCacheDir } from "../../services/tts-transformers.js";
import { saveChatAttachmentCopy } from "../../services/chat-attachment-store.js";
import {
  decodeAudioBytesTo16kMonoFloat,
  ffmpegAvailable,
  MAX_CHAT_AUDIO_ATTACH_BYTES,
} from "../../services/telegram-voice.js";
import { setWhisperCacheDir, transcribePcm } from "../../services/whisper-transformers.js";
import {
  type EmbeddingIndexProgressEvent,
  indexChatHistoryRows,
  indexDevEmbeddingPayload,
  searchEmbeddingCorpus,
} from "../../services/conversation-embeddings.js";
import {
  buildKnowledgeCuratorSystemPrompt,
  hitToContextString,
  searchKnowledgeEnhanced,
} from "../../services/knowledge-search-curate.js";
import { parseClaudeExport, type ParsedClaudeConversation } from "../../services/claude-export-parse.js";
import { parseChatgptExport, type ParsedChatgptConversation } from "../../services/chatgpt-export-parse.js";

const log = getLogger("electron-main");

function safeSendEmbeddingIndexProgress(
  wc: WebContents,
  payload: {
    phase: "index_conversation" | "chatgpt_import" | "claude_import" | "dev_index";
  } & EmbeddingIndexProgressEvent,
): void {
  try {
    if (!wc.isDestroyed()) wc.send("embedding:index-progress", payload);
  } catch {
    /* ignore */
  }
}

const CHATGPT_CONV_SHARD_RE = /^conversations-(\d+)\.json$/i;

/**
 * ChatGPT + Claude put transcripts in `conversations.json` or `conversations-NNN.json`.
 * Native pickers cannot grey out wrong `.json`; we default filter to JSON + label hints, optional macOS `message`, and warn on odd basenames (user can force).
 */
const CONVERSATION_EXPORT_JSON_BASENAME_RE = /^conversations(-\d+)?\.json$/i;

async function pickChatExportJsonPath(
  win: BrowserWindow,
  args: { title: string; /** macOS: line above picker */ macMessage: string },
): Promise<string | null> {
  const openOpts = {
    title: args.title,
    message: args.macMessage,
    buttonLabel: "Choose",
    filters: [
      { name: "conversations.json · conversations-*.json", extensions: ["json"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile"] as OpenDialogOptions["properties"],
  };
  for (;;) {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, openOpts);
    if (canceled || filePaths.length === 0) return null;
    const picked = filePaths[0];
    const base = path.basename(picked);
    if (CONVERSATION_EXPORT_JSON_BASENAME_RE.test(base)) return picked;
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Choose another…", `Use “${base}”`],
      defaultId: 0,
      cancelId: 0,
      title: args.title,
      message: `“${base}” is not named like the main chat export file.`,
      detail:
        "Expected conversations.json or conversations-000.json. Other export JSON (memories.json, user.json, …) is usually wrong. Pick again, or force this file if you renamed the export.",
    });
    if (response === 1) return picked;
  }
}

function chatgptShardSortKey(fileName: string): number | null {
  const m = CHATGPT_CONV_SHARD_RE.exec(fileName);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Newer exports use `conversations-000.json`, `conversations-001.json`, … in one folder.
 * Picking any shard loads every matching file in that directory (numeric order).
 * Legacy single `conversations.json` → unchanged.
 */
function resolveChatgptExportJsonPaths(pickedPath: string): string[] {
  const dir = path.dirname(pickedPath);
  const base = path.basename(pickedPath);
  if (chatgptShardSortKey(base) === null) return [pickedPath];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [pickedPath];
  }
  const shards = entries.filter((n) => chatgptShardSortKey(n) !== null);
  shards.sort((a, b) => chatgptShardSortKey(a)! - chatgptShardSortKey(b)!);
  return shards.map((n) => path.join(dir, n));
}

/** Same thread should not appear twice across shards; keep last occurrence if duplicates. */
function dedupeParsedImports<T extends { conversationId: string }>(items: T[]): T[] {
  const m = new Map<string, T>();
  const order: string[] = [];
  for (const it of items) {
    if (!m.has(it.conversationId)) order.push(it.conversationId);
    m.set(it.conversationId, it);
  }
  return order.map((id) => m.get(id)!);
}

let telegramHandles: TelegramIntegrationHandles | null = null;

const __electronDir = path.dirname(fileURLToPath(import.meta.url));

function aaRoot(): string {
  return path.resolve(__electronDir, "..", "..", "..");
}

/** PNG for BrowserWindow + Dock — Electron NativeImage; keep separate from Telegram profile JPG. */
function appIconPath(): string {
  return path.join(aaRoot(), "resources", "app-icon.png");
}

/** Bundled Telegram bot profile JPG (`/icon`, `/set_bot_icon`); ships under `resources/` with app. */
function telegramProfileAssetPath(): string {
  return path.join(aaRoot(), "resources", "telegram-bot-profile.jpg");
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
    icon: appIconPath(),
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
    const mirror = getResolvedSettings().chat.showTelegramMirror;
    return { ok: true as const, rows: readChatHistoryForDisplay(mirror) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("chat-history:get", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("chat-history:get-lossless", () => {
  try {
    return { ok: true as const, rows: readChatHistoryLossless() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("chat-history:get-lossless", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("imported-chat:get-lossless", () => {
  try {
    return { ok: true as const, sessions: readImportedChatSessionsLossless() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("imported-chat:get-lossless", msg);
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

function pcmPayloadToArrayBuffer(p: unknown): ArrayBuffer | null {
  if (p instanceof ArrayBuffer) {
    return p;
  }
  if (p instanceof Uint8Array) {
    const u = new Uint8Array(p.byteLength);
    u.set(p);
    return u.buffer;
  }
  if (ArrayBuffer.isView(p)) {
    const v = p as ArrayBufferView;
    const u = new Uint8Array(v.byteLength);
    u.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return u.buffer;
  }
  return null;
}

/**
 * Renderer Web Audio often fails on WhatsApp-style Opus/Ogg; ffmpeg fallback for chat attach staging.
 * @returns `{ ok, sampleRate, pcm: ArrayBuffer }` float32 LE mono @ 16k, or `{ ok: false, error }`.
 */
ipcMain.handle("audio:decodeAttachment", async (_e, raw: unknown) => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fileName = typeof o.fileName === "string" ? o.fileName.trim() : "";
  const data = o.data;
  let ab: ArrayBuffer | null = null;
  if (data instanceof ArrayBuffer) {
    ab = data;
  } else if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    const u = new Uint8Array(v.byteLength);
    u.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    ab = u.buffer as ArrayBuffer;
  }
  if (!fileName) {
    return { ok: false as const, error: "fileName required" };
  }
  if (!ab || ab.byteLength === 0) {
    return { ok: false as const, error: "data (ArrayBuffer) required" };
  }
  if (!ffmpegAvailable()) {
    log.warn("audio:decodeAttachment ffmpeg missing");
    return { ok: false as const, error: "ffmpeg not on PATH" };
  }
  if (ab.byteLength > MAX_CHAT_AUDIO_ATTACH_BYTES) {
    return {
      ok: false as const,
      error: `attachment too large (max ${MAX_CHAT_AUDIO_ATTACH_BYTES} bytes)`,
    };
  }
  const decoded = decodeAudioBytesTo16kMonoFloat(Buffer.from(ab), fileName);
  if (!decoded) {
    log.warn("audio:decodeAttachment decode failed", { fileName: fileName.slice(0, 120) });
    return { ok: false as const, error: "ffmpeg could not decode this file" };
  }
  const { samples, sampleRate } = decoded;
  const pcmBuf = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
  log.info("audio:decodeAttachment ok", { fileName: fileName.slice(0, 120), sampleRate, frames: samples.length });
  return { ok: true as const, sampleRate, pcm: pcmBuf };
});

/** Persist raw attach bytes beside chat history (`chat-attachments/`); survives restarts. */
ipcMain.handle("chat-attachment:save", async (_e, raw: unknown) => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fileName = typeof o.fileName === "string" ? o.fileName.trim() : "";
  const data = o.data;
  let ab: ArrayBuffer | null = null;
  if (data instanceof ArrayBuffer) {
    ab = data;
  } else if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    const u = new Uint8Array(v.byteLength);
    u.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    ab = u.buffer as ArrayBuffer;
  }
  if (!fileName) {
    return { ok: false as const, error: "fileName required" };
  }
  if (!ab || ab.byteLength === 0) {
    return { ok: false as const, error: "data (ArrayBuffer) required" };
  }
  const r = saveChatAttachmentCopy(fileName, Buffer.from(ab));
  if (!r.ok) {
    log.warn("chat-attachment:save fail", { fileName: fileName.slice(0, 120), error: r.error });
    return { ok: false as const, error: r.error };
  }
  log.info("chat-attachment:save ok", { fileName: fileName.slice(0, 80), bytes: ab.byteLength });
  return { ok: true as const, path: r.path };
});

ipcMain.handle("whisper:transcribe", async (event, raw: unknown) => {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sr = Number(o.sampleRate);
  const pcm = pcmPayloadToArrayBuffer(o.pcm);
  if (!pcm || pcm.byteLength === 0 || !Number.isFinite(sr) || sr <= 0) {
    return { ok: false as const, error: "pcm (ArrayBuffer) and positive sampleRate required" };
  }
  if (pcm.byteLength % 4 !== 0) {
    return { ok: false as const, error: "pcm byte length must be multiple of 4 (float32)" };
  }
  const samples = new Float32Array(pcm);
  const language = typeof o.language === "string" ? o.language : undefined;
  const taskRaw = o.task;
  const task =
    taskRaw === "translate" || taskRaw === "transcribe" ? taskRaw : undefined;
  const wc = event.sender;
  try {
    const w = getResolvedSettings().whisper;
    const r = await transcribePcm({
      samples,
      sampleRate: sr,
      whisper: w,
      language,
      task,
      onProgress: (status) => {
        if (!wc.isDestroyed()) {
          wc.send("whisper:progress", status);
        }
      },
    });
    if (r.ok) {
      return { ok: true as const, text: r.text };
    }
    return { ok: false as const, error: r.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("whisper:transcribe", msg);
    return { ok: false as const, error: msg };
  }
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
 * Agent turn with `web_search` + `schedule_job` + `stt` + `tts` + `youtube_transcribe` tools.
 * Sends `agent:step` for each tool step, `agent:stream-delta` for token/reasoning deltas. Returns `{ ok, text, steps, usage }`.
 */
ipcMain.handle("agent:chat", async (event, raw: unknown) => {
  let messagesIn: unknown[] | null = null;
  let stagedRaw: unknown[] = [];
  if (Array.isArray(raw)) {
    messagesIn = raw;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.messages)) {
      messagesIn = o.messages;
    }
    if (Array.isArray(o.stagedAudio)) {
      stagedRaw = o.stagedAudio;
    }
  }
  if (!Array.isArray(messagesIn)) {
    return { ok: false as const, error: "payload.messages must be an array" };
  }
  const hist: ChatMessage[] = [];
  for (const m of messagesIn) {
    if (!m || typeof m !== "object") {
      continue;
    }
    const o = m as {
      role?: unknown;
      content?: unknown;
      images?: unknown;
      attachmentPaths?: unknown;
    };
    const role = o.role === "user" ? "user" : o.role === "assistant" ? "assistant" : o.role === "system" ? "system" : null;
    if (!role || typeof o.content !== "string") {
      continue;
    }
    const row: ChatMessage = { role, content: o.content };
    if (role === "user" && Array.isArray(o.images)) {
      const images: ChatImagePart[] = [];
      for (const im of o.images) {
        if (!im || typeof im !== "object") {
          continue;
        }
        const io = im as Record<string, unknown>;
        const mediaType = typeof io.mediaType === "string" ? io.mediaType.trim() : "";
        const base64 = typeof io.base64 === "string" ? io.base64.trim() : "";
        const fileName = typeof io.fileName === "string" ? io.fileName : "";
        if (base64.length && mediaType.startsWith("image/")) {
          images.push({ fileName, mediaType, base64 });
        }
      }
      if (images.length) {
        row.images = images;
      }
    }
    if (role === "user" && Array.isArray(o.attachmentPaths)) {
      const ap: { name: string; path: string }[] = [];
      for (const it of o.attachmentPaths) {
        if (!it || typeof it !== "object") continue;
        const io = it as Record<string, unknown>;
        const name = typeof io.name === "string" ? io.name.trim() : "";
        const filepath = typeof io.path === "string" ? io.path.trim() : "";
        if (name.length && filepath.length) {
          ap.push({ name, path: filepath });
        }
      }
      if (ap.length) {
        row.attachmentPaths = ap;
      }
    }
    hist.push(row);
  }

  const stagedAudioByFileName = new Map<string, StagedAudioClip>();
  for (const item of stagedRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const it = item as Record<string, unknown>;
    const name = typeof it.name === "string" ? it.name : "";
    const sr = Number(it.sampleRate);
    const pcmBuf = pcmPayloadToArrayBuffer(it.pcm);
    if (!name || !pcmBuf || pcmBuf.byteLength < 4 || !Number.isFinite(sr) || sr <= 0 || pcmBuf.byteLength % 4 !== 0) {
      continue;
    }
    stagedAudioByFileName.set(name, {
      samples: new Float32Array(pcmBuf),
      sampleRate: sr,
    });
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
      stagedAudioByFileName,
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

ipcMain.handle("embedding:indexConversation", async (event, raw: unknown) => {
  try {
    const sender = event.sender;
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const conversationId =
      typeof o.conversationId === "string" && o.conversationId.trim()
        ? o.conversationId.trim()
        : "default";
    const sessionLabel = typeof o.sessionLabel === "string" ? o.sessionLabel : undefined;
    let rows: ChatHistoryRow[];
    if (Array.isArray(o.rows)) {
      rows = o.rows
        .map((x) => parseChatHistoryRowLossless(x))
        .filter((x): x is ChatHistoryRow => x !== null);
    } else {
      rows = readChatHistoryLossless();
    }
    const n = rows.length;
    safeSendEmbeddingIndexProgress(sender, {
      phase: "index_conversation",
      step: 0,
      total: Math.max(1, n),
      label: sessionLabel ?? conversationId,
    });
    return await indexChatHistoryRows(rows, {
      conversationId,
      sessionLabel,
      onProgress: (e) => {
        safeSendEmbeddingIndexProgress(sender, {
          phase: "index_conversation",
          step: e.step,
          total: Math.max(1, e.total),
          label: e.label ? `${sessionLabel ?? conversationId} · ${e.label}` : sessionLabel ?? conversationId,
        });
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("embedding:indexConversation", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("embedding:indexDev", async (event, raw: unknown) => {
  try {
    const sender = event.sender;
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const text = typeof o.text === "string" ? o.text : "";
    const imagePath = typeof o.imagePath === "string" && o.imagePath.trim() ? o.imagePath.trim() : undefined;
    const conversationId =
      typeof o.conversationId === "string" && o.conversationId.trim() ? o.conversationId.trim() : "dev";
    safeSendEmbeddingIndexProgress(sender, {
      phase: "dev_index",
      step: 0,
      total: 1,
      label: conversationId,
    });
    return await indexDevEmbeddingPayload({
      text,
      imagePath,
      conversationId,
      onProgress: (e) => {
        safeSendEmbeddingIndexProgress(sender, { phase: "dev_index", ...e });
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("embedding:indexDev", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("embedding:search", async (_e, raw: unknown) => {
  try {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const queryText = typeof o.queryText === "string" ? o.queryText : "";
    const imagePath =
      typeof o.imagePath === "string" && o.imagePath.trim() ? o.imagePath.trim() : undefined;
    let topK = 8;
    if (o.topK !== undefined && typeof o.topK === "number" && Number.isFinite(o.topK)) {
      topK = Math.min(100, Math.max(1, Math.floor(o.topK)));
    }
    return await searchEmbeddingCorpus({ queryText, imagePath, topK });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("embedding:search", msg);
    return { ok: false as const, error: msg };
  }
});

/** Context-engine–style: enhanced vec retrieval + curated LLM answer (`document-chat` + `/ollama-embeddings/search` pattern). */
ipcMain.handle("knowledge:searchAnswer", async (_e, raw: unknown) => {
  try {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const queryText = typeof o.queryText === "string" ? o.queryText.trim() : "";
    if (!queryText) return { ok: false as const, error: "Empty query." };

    let topK = 5;
    if (o.topK !== undefined && typeof o.topK === "number" && Number.isFinite(o.topK)) {
      topK = Math.min(100, Math.max(1, Math.floor(o.topK)));
    }
    const enhanced = o.enhanced !== false;

    const sr = await searchKnowledgeEnhanced({ queryText, topK, enhanced });
    if (!sr.ok) return sr;

    const contexts = sr.hits.map(hitToContextString);
    if (!contexts.length) {
      return {
        ok: true as const,
        answer:
          "No matching embedded passages found. Index conversations (History / Embeddings tab) or import ChatGPT export first.",
        contexts: [] as string[],
        hits: sr.hits.map((h) => ({ rowid: h.rowid, body: h.body, distance: h.distance })),
        queryVariations: sr.queryVariations,
        searchMetadata: sr.searchMetadata,
      };
    }

    const systemPrompt = buildKnowledgeCuratorSystemPrompt(queryText, contexts);
    const answer = await chatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: queryText },
      ],
    });

    return {
      ok: true as const,
      answer,
      contexts,
      hits: sr.hits.map((h) => ({ rowid: h.rowid, body: h.body, distance: h.distance })),
      queryVariations: sr.queryVariations,
      searchMetadata: sr.searchMetadata,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("knowledge:searchAnswer", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("embedding:list", (_e, raw: unknown) => {
  try {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    let lim = 100;
    if (o.limit !== undefined && typeof o.limit === "number" && Number.isFinite(o.limit)) {
      lim = Math.min(10_000, Math.max(1, Math.floor(o.limit)));
    }
    return { ok: true as const, rows: listEmbeddingBodies(lim) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("embedding:list", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("embedding:importChatgpt", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) {
      return { ok: false as const, error: "No window for file dialog." };
    }
    const pickedPath = await pickChatExportJsonPath(win, {
      title: "Import ChatGPT export JSON",
      macMessage: "Choose conversations.json or conversations-000.json — not user.json or message_feedback.json.",
    });
    if (!pickedPath) {
      return { ok: false as const, error: "Canceled." };
    }
    const jsonPaths = resolveChatgptExportJsonPaths(pickedPath);
    const merged: ParsedChatgptConversation[] = [];
    for (const fp of jsonPaths) {
      let text = fs.readFileSync(fp, "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const raw: unknown = JSON.parse(text);
      merged.push(...parseChatgptExport(raw));
    }
    const parsed = dedupeParsedImports(merged);
    const itemsWithRows = parsed.filter((x) => x.rows.length > 0);
    mergeImportedChatSessions(itemsWithRows, "chatgpt");
    const totalMsgs = itemsWithRows.reduce((acc, x) => acc + x.rows.length, 0);
    safeSendEmbeddingIndexProgress(event.sender, {
      phase: "chatgpt_import",
      step: 0,
      total: Math.max(1, totalMsgs),
      label: `${itemsWithRows.length} chat(s) · ${totalMsgs} message(s)`,
    });
    let indexed = 0;
    const errors: string[] = [];
    let conversationsIndexed = 0;
    let msgsDoneBase = 0;
    for (const item of itemsWithRows) {
      conversationsIndexed += 1;
      const r = await indexChatHistoryRows(item.rows, {
        conversationId: item.conversationId,
        sessionLabel: item.sessionLabel,
        onProgress: (e) => {
          safeSendEmbeddingIndexProgress(event.sender, {
            phase: "chatgpt_import",
            step: msgsDoneBase + e.step,
            total: Math.max(1, totalMsgs),
            label: item.sessionLabel,
          });
        },
      });
      if (!r.ok) {
        errors.push(`${item.sessionLabel}: ${r.error}`);
        msgsDoneBase += item.rows.length;
        continue;
      }
      indexed += r.indexed;
      msgsDoneBase += item.rows.length;
      for (const er of r.errors) {
        errors.push(`${item.sessionLabel}: ${er}`);
      }
    }
    return {
      ok: true as const,
      indexed,
      conversations: parsed.length,
      conversationsIndexed,
      errors,
      sourceFiles: jsonPaths.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("embedding:importChatgpt", msg);
    return { ok: false as const, error: msg };
  }
});

ipcMain.handle("embedding:importClaude", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    if (!win) {
      return { ok: false as const, error: "No window for file dialog." };
    }
    const pickedPath = await pickChatExportJsonPath(win, {
      title: "Import Claude export JSON",
      macMessage: "Choose conversations.json — not memories.json, projects.json, or users.json.",
    });
    if (!pickedPath) {
      return { ok: false as const, error: "Canceled." };
    }
    let text = fs.readFileSync(pickedPath, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rawJson: unknown = JSON.parse(text);
    const merged = parseClaudeExport(rawJson);
    const parsed = dedupeParsedImports<ParsedClaudeConversation>(merged);
    const itemsWithRows = parsed.filter((x) => x.rows.length > 0);
    mergeImportedChatSessions(itemsWithRows, "claude");
    const totalMsgs = itemsWithRows.reduce((acc, x) => acc + x.rows.length, 0);
    safeSendEmbeddingIndexProgress(event.sender, {
      phase: "claude_import",
      step: 0,
      total: Math.max(1, totalMsgs),
      label: `${itemsWithRows.length} chat(s) · ${totalMsgs} message(s)`,
    });
    let indexed = 0;
    const errors: string[] = [];
    let conversationsIndexed = 0;
    let msgsDoneBase = 0;
    for (const item of itemsWithRows) {
      conversationsIndexed += 1;
      const r = await indexChatHistoryRows(item.rows, {
        conversationId: item.conversationId,
        sessionLabel: item.sessionLabel,
        onProgress: (e) => {
          safeSendEmbeddingIndexProgress(event.sender, {
            phase: "claude_import",
            step: msgsDoneBase + e.step,
            total: Math.max(1, totalMsgs),
            label: item.sessionLabel,
          });
        },
      });
      if (!r.ok) {
        errors.push(`${item.sessionLabel}: ${r.error}`);
        msgsDoneBase += item.rows.length;
        continue;
      }
      indexed += r.indexed;
      msgsDoneBase += item.rows.length;
      for (const er of r.errors) {
        errors.push(`${item.sessionLabel}: ${er}`);
      }
    }
    return {
      ok: true as const,
      indexed,
      conversations: parsed.length,
      conversationsIndexed,
      errors,
      sourceFiles: 1,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("embedding:importClaude", msg);
    return { ok: false as const, error: msg };
  }
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
  const deliverDesktop = typeof o.deliverDesktop === "boolean" ? o.deliverDesktop : undefined;
  const deliverTelegram = typeof o.deliverTelegram === "boolean" ? o.deliverTelegram : undefined;
  let telegramChatId: number | undefined;
  if (o.telegramChatId !== undefined && o.telegramChatId !== null) {
    const tc = Number(o.telegramChatId);
    if (Number.isFinite(tc)) {
      telegramChatId = Math.floor(tc);
    }
  }
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
  return {
    prompt,
    title,
    enabled,
    notify,
    deliverDesktop,
    deliverTelegram,
    ...(telegramChatId !== undefined ? { telegramChatId } : {}),
    schedule,
  };
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
  if (typeof o.deliverDesktop === "boolean") {
    patch.deliverDesktop = o.deliverDesktop;
  }
  if (typeof o.deliverTelegram === "boolean") {
    patch.deliverTelegram = o.deliverTelegram;
  }
  if (Object.prototype.hasOwnProperty.call(o, "telegramChatId")) {
    if (o.telegramChatId === null) {
      patch.telegramChatId = null;
    } else {
      const tc = Number(o.telegramChatId);
      if (Number.isFinite(tc)) {
        patch.telegramChatId = Math.floor(tc);
      }
    }
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
    if (typeof l.vision === "boolean") {
      llm.vision = l.vision;
    }
    if (Object.keys(llm).length) out.llm = llm as UserLlm;
  }

  if ("logging" in o && o.logging && typeof o.logging === "object") {
    const g = o.logging as Record<string, unknown>;
    const logging: Partial<UserLogging> = {};
    if (typeof g.logToFile === "boolean") logging.logToFile = g.logToFile;
    if (typeof g.logToConsole === "boolean") logging.logToConsole = g.logToConsole;
    if (typeof g.logTools === "boolean") logging.logTools = g.logTools;
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

  if ("whisper" in o && o.whisper && typeof o.whisper === "object") {
    const w = o.whisper as Record<string, unknown>;
    const whisper: Partial<UserWhisper> = {};
    if (typeof w.modelSize === "string") {
      whisper.modelSize = w.modelSize.trim() as UserWhisper["modelSize"];
    }
    if (typeof w.quantized === "boolean") {
      whisper.quantized = w.quantized;
    }
    if (typeof w.multilingual === "boolean") {
      whisper.multilingual = w.multilingual;
    }
    if (Object.keys(whisper).length) {
      out.whisper = whisper as UserWhisper;
    }
  }

  if ("telegram" in o && o.telegram && typeof o.telegram === "object") {
    const tg = o.telegram as Record<string, unknown>;
    const telegram: Partial<UserTelegram> = {};
    if (typeof tg.usePolling === "boolean") telegram.usePolling = tg.usePolling;
    if (tg.webhookPort !== undefined) {
      const p = Number(tg.webhookPort);
      if (Number.isFinite(p)) telegram.webhookPort = Math.floor(p);
    }
    if (Object.prototype.hasOwnProperty.call(tg, "schedulerDefaultChatId")) {
      if (tg.schedulerDefaultChatId === null) {
        telegram.schedulerDefaultChatId = null;
      } else if (tg.schedulerDefaultChatId !== undefined) {
        const c = Number(tg.schedulerDefaultChatId);
        if (Number.isFinite(c)) {
          telegram.schedulerDefaultChatId = Math.floor(c);
        }
      }
    }
    if (Object.keys(telegram).length) {
      out.telegram = telegram as UserTelegram;
    }
  }

  if ("chat" in o && o.chat && typeof o.chat === "object") {
    const ch = o.chat as Record<string, unknown>;
    const chat: Partial<UserChat> = {};
    if (typeof ch.showTelegramMirror === "boolean") {
      chat.showTelegramMirror = ch.showTelegramMirror;
    }
    if (Object.keys(chat).length) {
      out.chat = chat as UserChat;
    }
  }

  if ("embedding" in o && o.embedding && typeof o.embedding === "object") {
    const em = o.embedding as Record<string, unknown>;
    const embedding: Partial<UserEmbedding> = {};
    if (typeof em.model === "string") embedding.model = em.model.trim();
    if (em.vecDimension !== undefined) {
      const d = Number(em.vecDimension);
      if (Number.isFinite(d)) {
        const n = Math.floor(d);
        if (n >= 8 && n <= 16_384) embedding.vecDimension = n;
      }
    }
    if (Object.keys(embedding).length) out.embedding = embedding as UserEmbedding;
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
  initializeImportedChatSessionsStore({ userDataDir: ud });
  initializeEmbeddingVectorStore({ userDataDir: ud });
  if (!isEmbeddingVectorStoreReady()) {
    log.error("embedding vector store disabled — embeddings tab / knowledge_search need sqlite + sqlite-vec", {
      detail: getEmbeddingVectorStoreInitError(),
    });
  }
  initializeTelegramHistoryStore({ userDataDir: ud });
  initializeSchedulerStore({ userDataDir: ud });
  configureTelegramUserDataDir(ud);
  configureTelegramAppIconPath(telegramProfileAssetPath());
  setWhisperCacheDir(path.join(ud, "whisper-models"));
  setTtsCacheDir(path.join(ud, "tts-models"));
  log.info("userData", ud);
  log.info("settings file", getSettingsFilePath());
  log.info("scheduler jobs file", getSchedulerJobsFilePath());
  startSchedulerEngine();
  telegramHandles = startTelegramIntegration();

  if (process.platform === "darwin") {
    app.dock.setIcon(appIconPath());
  }

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (e) => {
  if (!telegramHandles) {
    return;
  }
  e.preventDefault();
  const h = telegramHandles;
  telegramHandles = null;
  void stopTelegramIntegration(h).then(() => app.quit());
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
