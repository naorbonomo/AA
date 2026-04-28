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
  /** Agent with `web_search` tool; `onStep({ kind, status, ... })`, optional `onStreamDelta({ reasoning?, content? })`. */
  agentChat(messages, onStep, onStreamDelta) {
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
      ipcRenderer
        .invoke("agent:chat", messages)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          ipcRenderer.removeListener("agent:step", onAgentStep);
          ipcRenderer.removeListener("agent:stream-delta", onTok);
        });
    });
  },
});
