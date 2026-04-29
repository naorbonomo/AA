/** Telegram ingress: long-poll + optional webhook; agent replies via `runChatWithWebSearchTool`. */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import {
  TELEGRAM_API_BASE,
  TELEGRAM_DEDUPE_MAX_IDS,
  TELEGRAM_GETUPDATES_ERROR_RETRY_MS,
  TELEGRAM_GETUPDATES_HTTP_TIMEOUT_MS,
  TELEGRAM_GETUPDATES_TIMEOUT_SEC,
  TELEGRAM_MAX_MESSAGE_CHARS,
} from "../config/telegram_config.js";
import { getLogger } from "../utils/logger.js";
import { getResolvedSettings } from "./settings-store.js";
import { getSecrets } from "./secrets-store.js";
import { runChatWithWebSearchTool, type AgentStepPayload } from "./agent-runner.js";
import { appendTelegramMessages, readTelegramChatMessages } from "./telegram-history-store.js";
import {
  decodeAudioFileTo16kMonoFloat,
  downloadTelegramFileBytes,
  ffmpegAvailable,
  safeUnlink,
  telegramGetFilePath,
  tempTelegramVoicePath,
  wavBytesToOggOpus,
} from "./telegram-voice.js";
import { transcribePcm } from "./whisper-transformers.js";

const log = getLogger("telegram-channel");

let telegramUserDataDir: string | null = null;
let telegramAppIconPngPath: string | null = null;

/** Call from Electron `whenReady` before `startTelegramIntegration` (dedupe file + parity with history dir). */
export function configureTelegramUserDataDir(dir: string): void {
  telegramUserDataDir = dir.trim() ? dir : null;
}

/** Absolute path to bundled Telegram profile image (e.g. `resources/telegram-bot-profile.jpg`). */
export function configureTelegramAppIconPath(absPath: string): void {
  const t = absPath.trim();
  telegramAppIconPngPath = t.length ? t : null;
}

function appIconPathResolved(): string | null {
  return telegramAppIconPngPath;
}

function dedupePath(): string {
  if (telegramUserDataDir) {
    return path.join(telegramUserDataDir, "aa-telegram-seen-updates.json");
  }
  return path.join(process.cwd(), "aa-telegram-seen-updates.json");
}

function loadSeenIds(): Set<number> {
  try {
    const raw = JSON.parse(fs.readFileSync(dedupePath(), "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      return new Set();
    }
    const s = new Set<number>();
    for (const x of raw) {
      if (typeof x === "number" && Number.isInteger(x)) {
        s.add(x);
      }
    }
    return s;
  } catch {
    return new Set();
  }
}

function persistSeenIds(ids: Set<number>): void {
  const arr = [...ids].sort((a, b) => a - b);
  const trimmed = arr.length > TELEGRAM_DEDUPE_MAX_IDS ? arr.slice(-TELEGRAM_DEDUPE_MAX_IDS) : arr;
  const p = dedupePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(trimmed)}\n`, "utf8");
}

/** Webhook: first delivery true; duplicate false. Polling does not call this (Telegram offset dedupes). */
export function webhookTryClaimUpdate(update: Record<string, unknown>): boolean {
  const uid = update.update_id;
  if (typeof uid !== "number" || !Number.isInteger(uid)) {
    return true;
  }
  const seen = loadSeenIds();
  if (seen.has(uid)) {
    return false;
  }
  seen.add(uid);
  persistSeenIds(seen);
  return true;
}

async function apiSendDocument(
  token: string,
  chatId: number,
  filePath: string,
  caption: string | undefined,
  replyToMessageId: number | undefined,
): Promise<void> {
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath) || "telegram-bot-profile.jpg";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) {
    form.append("caption", caption);
  }
  if (replyToMessageId !== undefined) {
    form.append("reply_to_message_id", String(replyToMessageId));
  }
  form.append("document", new Blob([buf]), name);
  const r = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    log.error("sendDocument failed", { status: r.status, errText: errText.slice(0, 500) });
    throw new Error(`Telegram sendDocument ${r.status}`);
  }
}

/** Bot API `setMyProfilePhoto` — static photo via multipart (`InputProfilePhotoStatic`). */
async function apiSetMyProfilePhoto(token: string, imagePath: string): Promise<void> {
  const buf = fs.readFileSync(imagePath);
  const attachName = "icon";
  const photoJson = JSON.stringify({
    type: "static",
    photo: `attach://${attachName}`,
  });
  const form = new FormData();
  form.append("photo", photoJson);
  form.append(attachName, new Blob([buf]), path.basename(imagePath));
  const r = await fetch(`${TELEGRAM_API_BASE}/bot${token}/setMyProfilePhoto`, {
    method: "POST",
    body: form,
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    log.error("setMyProfilePhoto failed", { status: r.status, errText: text.slice(0, 500) });
    throw new Error(`Telegram setMyProfilePhoto ${r.status}: ${text.slice(0, 200)}`);
  }
  let data: { ok?: unknown; description?: string };
  try {
    data = JSON.parse(text) as { ok?: unknown; description?: string };
  } catch {
    throw new Error("setMyProfilePhoto: bad JSON");
  }
  if (data.ok !== true) {
    throw new Error(data.description || "setMyProfilePhoto failed");
  }
}

/** Fire-and-forget: sync bot profile from bundled JPG (e.g. on `/start`). Logs errors only; no chat message. */
function scheduleSyncBundledProfilePhoto(token: string): void {
  const iconPath = appIconPathResolved();
  if (!iconPath || !fs.existsSync(iconPath)) {
    log.warn("telegram profile asset missing; skip auto setMyProfilePhoto");
    return;
  }
  void apiSetMyProfilePhoto(token, iconPath).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("setMyProfilePhoto auto", msg);
  });
}

function telegramCommandName(firstToken: string): string {
  return (firstToken.split("@")[0] ?? firstToken).toLowerCase();
}

function telegramToken(): string | undefined {
  const t = getSecrets().telegram_bot_token;
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

async function apiSendMessage(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_MESSAGE_CHARS) {
    chunks.push(text.slice(i, i + TELEGRAM_MAX_MESSAGE_CHARS));
  }
  if (chunks.length === 0) {
    chunks.push("");
  }
  let firstReplyId = replyToMessageId;
  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      ...(firstReplyId !== undefined ? { reply_to_message_id: firstReplyId } : {}),
    };
    const r = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      log.error("sendMessage failed", { status: r.status, errText: errText.slice(0, 500) });
      throw new Error(`Telegram sendMessage ${r.status}`);
    }
    firstReplyId = undefined;
  }
}

function wavBufferFromDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:audio\/wav;base64,([^,]+)/i.exec(dataUrl.trim());
  if (!m?.[1]) {
    return null;
  }
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}

async function apiSendVoiceOgg(token: string, chatId: number, ogg: Buffer, filename: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const name = filename.endsWith(".ogg") ? filename : "voice.ogg";
  form.append("voice", new Blob([new Uint8Array(ogg)]), name);
  const r = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendVoice`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    log.error("sendVoice failed", { status: r.status, errText: errText.slice(0, 500) });
    throw new Error(`Telegram sendVoice ${r.status}`);
  }
}

async function apiSendDocumentBuffer(
  token: string,
  chatId: number,
  buf: Buffer,
  filename: string,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([new Uint8Array(buf)]), filename);
  const r = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    log.error("sendDocument (tts fallback) failed", { status: r.status, errText: errText.slice(0, 500) });
    throw new Error(`Telegram sendDocument ${r.status}`);
  }
}

/** Smith-style: `sendVoice` (OGG Opus) when ffmpeg converts WAV; else `sendDocument` with WAV. */
async function apiSendTtsWavAsVoiceOrDocument(
  token: string,
  chatId: number,
  wav: Buffer,
  baseName: string,
): Promise<void> {
  const ogg = wavBytesToOggOpus(wav);
  if (ogg && ogg.length > 0) {
    await apiSendVoiceOgg(token, chatId, ogg, `${baseName}.ogg`);
    return;
  }
  await apiSendDocumentBuffer(token, chatId, wav, `${baseName}.wav`);
}

const chainByChat = new Map<number, Promise<void>>();

function enqueueChatWork(chatId: number, fn: () => Promise<void>): void {
  const prev = chainByChat.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("telegram chat work", { chatId, msg });
    })
    .finally(() => {
      if (chainByChat.get(chatId) === next) {
        chainByChat.delete(chatId);
      }
    });
  chainByChat.set(chatId, next);
}

async function runAgentAndReply(
  token: string,
  chatId: number,
  userText: string,
  replyToMessageId?: number,
): Promise<void> {
  const settings = getResolvedSettings();
  appendTelegramMessages(chatId, [{ role: "user", content: userText }]);
  const historyWithUser = readTelegramChatMessages(chatId);

  let out: string;
  const ttsDataUrls: string[] = [];
  try {
    const r = await runChatWithWebSearchTool({
      history: historyWithUser,
      maxToolRounds: settings.agent.maxToolRounds,
      onStreamDelta: undefined,
      onStep: (p: AgentStepPayload) => {
        if (p.kind === "tts" && p.status === "done" && p.ok && p.dataUrl) {
          ttsDataUrls.push(p.dataUrl);
        }
      },
    });
    out = r.text?.trim() ? r.text.trim() : "(empty reply)";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    out = `Error: ${msg}`;
    log.error("agent telegram", { chatId, msg });
  }

  appendTelegramMessages(chatId, [{ role: "assistant", content: out }]);
  await apiSendMessage(token, chatId, out, replyToMessageId);
  for (let i = 0; i < ttsDataUrls.length; i += 1) {
    const raw = ttsDataUrls[i];
    if (!raw) continue;
    const buf = wavBufferFromDataUrl(raw);
    if (!buf?.length) {
      log.warn("telegram tts bad dataUrl", { index: i });
      continue;
    }
    try {
      await apiSendTtsWavAsVoiceOrDocument(token, chatId, buf, `aa-tts-${i + 1}`);
    } catch (e: unknown) {
      log.warn("telegram tts voice/document", { index: i, msg: e instanceof Error ? e.message : String(e) });
    }
  }
}

function extractUserText(message: Record<string, unknown>): { userText: string | null; replyToId?: number } {
  const mid = message.message_id;
  const replyToId = typeof mid === "number" ? mid : undefined;

  const text = message.text;
  if (typeof text === "string") {
    const body = text.trim();
    if (!body) {
      return { userText: null, replyToId };
    }
    return { userText: body, replyToId };
  }

  const cap = message.caption;
  if (typeof cap === "string" && cap.trim()) {
    return { userText: cap.trim(), replyToId };
  }

  return { userText: null, replyToId };
}

async function processTelegramVoiceMessage(opts: {
  token: string;
  chatId: number;
  fileId: string;
  replyToMessageId: number | undefined;
  caption: string;
  messageId: number;
}): Promise<void> {
  const { token, chatId, fileId, replyToMessageId, caption, messageId } = opts;
  if (!ffmpegAvailable()) {
    await apiSendMessage(
      token,
      chatId,
      "Voice needs ffmpeg on PATH (https://ffmpeg.org/). Install, restart AA, send again.",
      replyToMessageId,
    );
    return;
  }
  const settings = getResolvedSettings();
  let localPath = "";
  try {
    const relPath = await telegramGetFilePath(token, fileId);
    const buf = await downloadTelegramFileBytes(token, relPath);
    const ext = path.extname(relPath) || ".oga";
    localPath = tempTelegramVoicePath(chatId, messageId, ext);
    fs.writeFileSync(localPath, buf);
    const pcm = decodeAudioFileTo16kMonoFloat(localPath);
    if (!pcm) {
      await apiSendMessage(
        token,
        chatId,
        "Could not decode voice with ffmpeg.",
        replyToMessageId,
      );
      return;
    }
    const tr = await transcribePcm({
      samples: pcm.samples,
      sampleRate: pcm.sampleRate,
      whisper: settings.whisper,
    });
    if (!tr.ok) {
      await apiSendMessage(
        token,
        chatId,
        `Transcription failed: ${tr.error.slice(0, 500)}`,
        replyToMessageId,
      );
      return;
    }
    const raw = tr.text.trim();
    if (!raw) {
      await apiSendMessage(token, chatId, "(empty transcription)", replyToMessageId);
      return;
    }
    const cap = caption.trim();
    const inner = cap ? `${cap}\n${raw}` : raw;
    const userText = `<voice_message transcribed="true">${inner}</voice_message>`;
    await runAgentAndReply(token, chatId, userText, replyToMessageId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("telegram voice", msg);
    await apiSendMessage(token, chatId, `Voice error: ${msg.slice(0, 400)}`, replyToMessageId).catch(
      () => {},
    );
  } finally {
    if (localPath) {
      safeUnlink(localPath);
    }
  }
}

function scheduleTelegramAgentReply(
  token: string,
  chatId: number,
  userText: string,
  replyToMessageId?: number,
): void {
  enqueueChatWork(chatId, () => runAgentAndReply(token, chatId, userText, replyToMessageId));
}

/**
 * One Update → enqueue agent reply (or quick / start reply).
 * Webhook should return after scheduling; use `void handleTelegramUpdate(...)`.
 */
export async function handleTelegramUpdate(update: Record<string, unknown>): Promise<void> {
  const messageRaw = update.message ?? update.edited_message;
  if (!messageRaw || typeof messageRaw !== "object") {
    return;
  }
  const message = messageRaw as Record<string, unknown>;
  const chat = message.chat;
  if (!chat || typeof chat !== "object") {
    return;
  }
  const chatId = (chat as { id?: unknown }).id;
  if (typeof chatId !== "number" || !Number.isInteger(chatId)) {
    return;
  }

  const token = telegramToken();
  if (!token) {
    log.warn("TELEGRAM_BOT_TOKEN missing; skip update");
    return;
  }

  const voice = message.voice ?? message.audio;
  if (voice && typeof voice === "object" && (voice as { file_id?: string }).file_id) {
    const fid = String((voice as { file_id: string }).file_id);
    const replyId = typeof message.message_id === "number" ? message.message_id : undefined;
    const mid =
      typeof message.message_id === "number" && Number.isInteger(message.message_id)
        ? message.message_id
        : Date.now();
    const cap = typeof message.caption === "string" ? message.caption : "";
    enqueueChatWork(chatId, () =>
      processTelegramVoiceMessage({
        token,
        chatId,
        fileId: fid,
        replyToMessageId: replyId,
        caption: cap,
        messageId: mid,
      }),
    );
    return;
  }

  const textRaw = message.text;
  if (typeof textRaw === "string" && textRaw.trim()) {
    const firstTok = textRaw.trim().split(/\s/, 1)[0] ?? "";
    const cmd = telegramCommandName(firstTok);
    const replyId = typeof message.message_id === "number" ? message.message_id : undefined;

    if (cmd === "/start") {
      scheduleSyncBundledProfilePhoto(token);
      void apiSendMessage(
        token,
        chatId,
        "AA bot — same agent + tools as desktop. Per-chat history on this machine.",
        replyId,
      ).catch(() => {});
      return;
    }

    if (cmd === "/icon" || cmd === "/app_icon") {
      void (async () => {
        const iconPath = appIconPathResolved();
        if (!iconPath || !fs.existsSync(iconPath)) {
          await apiSendMessage(
            token,
            chatId,
            "Bundled Telegram profile image missing (resources/telegram-bot-profile.jpg).",
            replyId,
          );
          return;
        }
        try {
          await apiSendDocument(
            token,
            chatId,
            iconPath,
            "AA Telegram profile (bundled JPG) — @BotFather /setuserpic or /set_bot_icon",
            replyId,
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          await apiSendMessage(token, chatId, `Could not send file: ${msg}`, replyId).catch(() => {});
        }
      })();
      return;
    }

    if (cmd === "/set_bot_icon" || cmd === "/sync_bot_icon") {
      void (async () => {
        const iconPath = appIconPathResolved();
        if (!iconPath || !fs.existsSync(iconPath)) {
          await apiSendMessage(
            token,
            chatId,
            "Bundled Telegram profile image missing (resources/telegram-bot-profile.jpg).",
            replyId,
          );
          return;
        }
        try {
          await apiSetMyProfilePhoto(token, iconPath);
          await apiSendMessage(token, chatId, "Bot profile photo updated.", replyId);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          await apiSendMessage(
            token,
            chatId,
            `Could not set photo via API (${msg}). Try /icon or BotFather /setuserpic.`,
            replyId,
          ).catch(() => {});
        }
      })();
      return;
    }
  }

  const { userText, replyToId } = extractUserText(message);
  if (!userText) {
    return;
  }

  log.info("telegram enqueue", { chatId, len: userText.length });
  scheduleTelegramAgentReply(token, chatId, userText, replyToId);
}

async function apiGetUpdates(
  token: string,
  offset: number | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    timeout: String(TELEGRAM_GETUPDATES_TIMEOUT_SEC),
  });
  if (offset !== undefined) {
    params.set("offset", String(offset));
  }
  const url = `${TELEGRAM_API_BASE}/bot${token}/getUpdates?${params.toString()}`;
  const ac = new AbortController();
  const t = setTimeout(() => {
    signal.removeEventListener("abort", onParent);
    ac.abort();
  }, TELEGRAM_GETUPDATES_HTTP_TIMEOUT_MS);
  const onParent = (): void => {
    clearTimeout(t);
    ac.abort();
  };
  if (signal.aborted) {
    clearTimeout(t);
    ac.abort();
  } else {
    signal.addEventListener("abort", onParent, { once: true });
  }
  let r: Response;
  try {
    r = await fetch(url, { method: "GET", signal: ac.signal });
  } finally {
    clearTimeout(t);
    signal.removeEventListener("abort", onParent);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`getUpdates ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = (await r.json()) as { ok?: unknown; result?: unknown };
  if (data.ok !== true || !Array.isArray(data.result)) {
    return [];
  }
  return data.result as Record<string, unknown>[];
}

export async function runTelegramPollingLoop(signal: AbortSignal): Promise<void> {
  const token = telegramToken();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN not set");
  }
  log.info("telegram polling start");
  let offset: number | undefined;

  while (!signal.aborted) {
    try {
      const updates = await apiGetUpdates(token, offset, signal);
      for (const u of updates) {
        const uid = u.update_id;
        if (typeof uid === "number") {
          offset = uid + 1;
        }
        try {
          await handleTelegramUpdate(u);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error("telegram update", { msg, update_id: uid });
        }
      }
    } catch (e: unknown) {
      if (signal.aborted) {
        break;
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.error("getUpdates", msg);
      await new Promise((r) => setTimeout(r, TELEGRAM_GETUPDATES_ERROR_RETRY_MS));
    }
  }
  log.info("telegram polling stop");
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({});
          return;
        }
        const o = JSON.parse(raw) as unknown;
        resolve(typeof o === "object" && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function startTelegramWebhookServer(
  token: string,
  port: number,
  host = "127.0.0.1",
): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url?.split("?")[0] !== "/telegram/webhook") {
        res.writeHead(404).end();
        return;
      }
      try {
        const update = await readJsonBody(req);
        if (!webhookTryClaimUpdate(update)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, duplicate: true }));
          return;
        }
        void handleTelegramUpdate(update);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e: unknown) {
        log.error("webhook", e instanceof Error ? e.message : String(e));
        res.writeHead(500).end();
      }
    })();
  });
  server.listen(port, host, () => {
    log.info("telegram webhook listening", { host, port, path: "/telegram/webhook" });
  });
  return server;
}

export type TelegramIntegrationHandles = {
  pollingTask: Promise<void> | null;
  pollAbort: AbortController | null;
  server: http.Server | null;
};

/** After `configureTelegramUserDataDir` + secrets init; respects `getResolvedSettings().telegram`. */
export function startTelegramIntegration(): TelegramIntegrationHandles {
  const token = telegramToken();
  const handles: TelegramIntegrationHandles = {
    pollingTask: null,
    pollAbort: null,
    server: null,
  };
  if (!token) {
    return handles;
  }

  const { telegram } = getResolvedSettings();

  if (telegram.webhookPort > 0) {
    handles.server = startTelegramWebhookServer(token, telegram.webhookPort);
  }

  if (telegram.usePolling) {
    const ac = new AbortController();
    handles.pollAbort = ac;
    handles.pollingTask = runTelegramPollingLoop(ac.signal);
  }

  return handles;
}

export async function stopTelegramIntegration(handles: TelegramIntegrationHandles | null): Promise<void> {
  if (!handles) {
    return;
  }
  handles.pollAbort?.abort();
  if (handles.pollingTask) {
    await handles.pollingTask.catch(() => {});
  }
  const srv = handles.server;
  if (srv) {
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }
}
