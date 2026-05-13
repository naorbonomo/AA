/**
 * MUST stay CommonJS — Electron preload does not reliably load compiled ESM;
 * silent failure → window.aaDesktop missing.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aaDesktop", {
  chatHistoryGet() {
    return ipcRenderer.invoke("chat-history:get");
  },
  chatHistorySave(rows) {
    return ipcRenderer.invoke("chat-history:save", rows);
  },
  chat(messages) {
    return ipcRenderer.invoke("lm:chat", messages);
  },
  /** Streams tokens via callbacks; resolves with `{ wallMs, usage }` when stream completes. */
  chatStream(messages, handlers) {
    const onDelta =
      handlers && typeof handlers.onDelta === "function" ? handlers.onDelta.bind(handlers) : null;
    return new Promise((resolve, reject) => {
      const onPiece = (_e, d) => {
        if (onDelta) onDelta(d);
      };
      const onDone = (_e, payload) => {
        cleanup();
        resolve(payload !== undefined ? payload : { wallMs: 0, usage: null });
      };
      const onErr = (_e, payload) => {
        cleanup();
        const m = payload && typeof payload.message === "string" ? payload.message : "stream error";
        reject(new Error(m));
      };
      function cleanup() {
        ipcRenderer.removeListener("lm:chat-stream-delta", onPiece);
        ipcRenderer.removeListener("lm:chat-stream-done", onDone);
        ipcRenderer.removeListener("lm:chat-stream-error", onErr);
      }
      ipcRenderer.on("lm:chat-stream-delta", onPiece);
      ipcRenderer.once("lm:chat-stream-done", onDone);
      ipcRenderer.once("lm:chat-stream-error", onErr);
      ipcRenderer.send("lm:chat-stream", messages);
    });
  },
  settingsGet() {
    return ipcRenderer.invoke("settings:get");
  },
  settingsSave(patch) {
    return ipcRenderer.invoke("settings:save", patch);
  },
  settingsReset() {
    return ipcRenderer.invoke("settings:reset");
  },
  settingsReload() {
    return ipcRenderer.invoke("settings:reload");
  },
  /** `{ ok, ids?, error? }` — GET `/v1/models` for current LLM base URL + token. */
  llmListModels() {
    return ipcRenderer.invoke("llm:listModels");
  },
  promptsList() {
    return ipcRenderer.invoke("prompts:list");
  },
  secretsGet() {
    return ipcRenderer.invoke("secrets:get");
  },
  secretsSave(patch) {
    return ipcRenderer.invoke("secrets:save", patch);
  },
  /** `{ query, maxResults? }` → `webSearch` JSON result `{ ok, ... }`. */
  webSearch(payload) {
    return ipcRenderer.invoke("tools:webSearch", payload);
  },
  /** Agent loop (web_search, schedule_job, stt, tts, youtube_transcribe); `onStep({ kind, status, ... })`, optional `onStreamDelta({ reasoning?, content? })`. */
  schedulerList() {
    return ipcRenderer.invoke("scheduler:list");
  },
  schedulerCreate(payload) {
    return ipcRenderer.invoke("scheduler:create", payload);
  },
  schedulerUpdate(payload) {
    return ipcRenderer.invoke("scheduler:update", payload);
  },
  schedulerDelete(id) {
    return ipcRenderer.invoke("scheduler:delete", id);
  },
  schedulerRunNow(id) {
    return ipcRenderer.invoke("scheduler:runNow", id);
  },
  /** `{ wall: 'YYYY-MM-DDTHH:mm', timeZone? }` → `{ ok, iso }` UTC instant for scheduler storage. */
  appTimeWallToUtcIso(payload) {
    return ipcRenderer.invoke("app-time:wall-to-utc-iso", payload);
  },
  /** `{ ms, timeZone? }` → `{ ok, wall }` for datetime-local in app zone. */
  appTimeUtcToWall(payload) {
    return ipcRenderer.invoke("app-time:utc-to-wall", payload);
  },
  /** @param {(p: unknown) => void} handler @returns {() => void} unsubscribe */
  onSchedulerJobFinished(handler) {
    const wrapped = (_e, p) => {
      if (typeof handler === "function") {
        try {
          handler(p);
        } catch (_) {
          /* ignore */
        }
      }
    };
    ipcRenderer.on("scheduler:job-finished", wrapped);
    return () => ipcRenderer.removeListener("scheduler:job-finished", wrapped);
  },
  /** Desktop Chat: Telegram history changed — re-invoke `chatHistoryGet` when mirror enabled. */
  onChatMirrorRefresh(handler) {
    const wrapped = () => {
      if (typeof handler === "function") {
        try {
          handler();
        } catch (_) {
          /* ignore */
        }
      }
    };
    ipcRenderer.on("chat:mirror-refresh", wrapped);
    return () => ipcRenderer.removeListener("chat:mirror-refresh", wrapped);
  },
  /** `{ fileName: string, data: ArrayBuffer }` → `{ ok, path }` — copy under userData/chat-attachments. */
  chatAttachmentSave(payload) {
    return ipcRenderer.invoke("chat-attachment:save", payload);
  },
  /** `{ pcm: ArrayBuffer, sampleRate, language?, task? }` → `{ ok, text? } | { ok: false, error }`. Uses Whisper settings from disk. */
  whisperTranscribe(payload) {
    return ipcRenderer.invoke("whisper:transcribe", payload);
  },
  /** `{ fileName: string, data: ArrayBuffer }` → `{ ok, sampleRate, pcm }` (16k mono f32) or `{ ok: false, error }` — ffmpeg when Web Audio fails (e.g. WhatsApp Opus). */
  audioDecodeAttachment(payload) {
    return ipcRenderer.invoke("audio:decodeAttachment", payload);
  },
  /** @param {(p: unknown) => void} handler @returns {() => void} unsubscribe */
  onWhisperProgress(handler) {
    const wrapped = (_e, p) => {
      if (typeof handler === "function") {
        try {
          handler(p);
        } catch (_) {
          /* ignore */
        }
      }
    };
    ipcRenderer.on("whisper:progress", wrapped);
    return () => ipcRenderer.removeListener("whisper:progress", wrapped);
  },
  /**
   * @param {{ role: string, content: string }[]} messages
   * @param {((p: unknown) => void)|undefined} onStep
   * @param {((d: unknown) => void)|undefined} onStreamDelta
   * @param {{ name: string, sampleRate: number, pcm: ArrayBuffer }[]|undefined} stagedAudio — float32 PCM per attached file name
   */
  agentChat(messages, onStep, onStreamDelta, stagedAudio) {
    return new Promise((resolve, reject) => {
      const onAgentStep = (_e, payload) => {
        if (typeof onStep === "function") {
          try {
            onStep(payload);
          } catch (_) {
            /* ignore */
          }
        }
      };
      const onTok = (_e, d) => {
        if (typeof onStreamDelta === "function") {
          try {
            onStreamDelta(d);
          } catch (_) {
            /* ignore */
          }
        }
      };
      ipcRenderer.on("agent:step", onAgentStep);
      ipcRenderer.on("agent:stream-delta", onTok);
      const payload =
        Array.isArray(stagedAudio) && stagedAudio.length > 0
          ? { messages, stagedAudio }
          : { messages, stagedAudio: [] };
      ipcRenderer
        .invoke("agent:chat", payload)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          ipcRenderer.removeListener("agent:step", onAgentStep);
          ipcRenderer.removeListener("agent:stream-delta", onTok);
        });
    });
  },
});
