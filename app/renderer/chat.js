(function () {
  /** @typedef {{ ok: boolean, text?: string, error?: string }} ChatIPCResult */
  /**
   * @typedef {{
   *   wallMs: number,
   *   total_tokens: number|null,
   *   prompt_tokens: number|null,
   *   completion_tokens: number|null,
   *   reasoning_tokens?: number,
   *   msPerToken: number|null,
   *   system_fingerprint?: string
   * }} UsageMeta
   * msPerToken = wallMs / completion_tokens when known (footer tok/s); else wallMs / total_tokens.
   */
  /** @typedef {{ name: string, kind: "image"|"audio"|"file", previewUrl?: string, thumbnailDataUrl?: string }} RowAttachment */
  /** @typedef {{ role: string, content: string, atMs?: number, reasoning?: string, usageMeta?: UsageMeta, agentTrace?: string, agentToolCount?: number, agentTtsClips?: { dataUrl: string }[], source?: "app" | "telegram" | "scheduler", telegramChatId?: number, errReply?: boolean, images?: { fileName: string, mediaType: string, base64: string }[], displayAttachments?: RowAttachment[] }} Row */

  const aa = window.aaDesktop;

  /** True while agent request running — hides Retry on orphan user bubble. */
  let agentBusy = false;
  let mirrorRefreshQueued = false;
  if (!aa) {
    document.body.innerHTML =
      '<p style="color:#fca5a5;padding:1.2vmin;font-family:system-ui">Preload failed — aaDesktop unavailable.</p>';
    return;
  }

  /** @type {Row[]} */
  const history = [];

  /** False until disk history applied — avoids wiping scheduler rows appended during `await chatHistoryGet()`. */
  let historyHydrated = false;
  /** @type {unknown[]} */
  const schedulerPending = [];

  const elMsgs = document.getElementById("messages");
  const elForm = document.getElementById("compose");
  const elInput = document.getElementById("input");
  const elSend = document.getElementById("btn-send");
  const elAttachFiles = document.getElementById("attach-files");
  const elBtnAttach = document.getElementById("btn-attach");
  const elAttachList = document.getElementById("attach-list");

  const THINK_TIER_KEY = "aa.thinkingPanelTier";

  /** @type {{ name: string, type: string, ab: ArrayBuffer, previewUrl?: string }[]} */
  const pendingAttachments = [];

  /**
   * Float32 PCM per `File.name` for agent `stt`. Kept for Retry until assistant succeeds.
   * @type {Array<{ name: string, sampleRate: number, pcm: ArrayBuffer }> | null}
   */
  let lastTurnStagedAudio = null;

  /** @param {string} name @param {string} type */
  function isProbablyAudio(name, type) {
    if (typeof type === "string" && type.startsWith("audio/")) {
      return true;
    }
    return /\.(wav|mp3|m4a|aac|ogg|opus|webm|flac|mp4)$/i.test(name);
  }

  function renderAttachList() {
    if (!(elAttachList instanceof HTMLElement)) {
      return;
    }
    if (!pendingAttachments.length) {
      elAttachList.textContent = "";
      return;
    }
    elAttachList.textContent = pendingAttachments.map((p) => p.name).join(" · ");
  }

  /** @param {string} name @param {string} type */
  function isProbablyImage(name, type) {
    if (typeof type === "string" && type.startsWith("image/")) {
      return true;
    }
    return /\.(jpe?g|png|gif|webp|bmp|svg|heic|avif)$/i.test(name);
  }

  /** @param {string} name @param {string} type */
  function guessImageMediaType(name, type) {
    if (typeof type === "string" && type.startsWith("image/")) {
      const t = type.split(";")[0].trim();
      return t || "image/png";
    }
    const n = name.toLowerCase();
    if (n.endsWith(".png")) {
      return "image/png";
    }
    if (n.endsWith(".gif")) {
      return "image/gif";
    }
    if (n.endsWith(".webp")) {
      return "image/webp";
    }
    if (n.endsWith(".bmp")) {
      return "image/bmp";
    }
    if (n.endsWith(".svg")) {
      return "image/svg+xml";
    }
    if (n.endsWith(".heic")) {
      return "image/heic";
    }
    if (n.endsWith(".avif")) {
      return "image/avif";
    }
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    return "image/png";
  }

  /**
   * Small JPEG for disk + reload (`data:` URL). Skips SVG/other decode failures.
   * @param {ArrayBuffer} ab
   * @param {string} mimeType
   * @param {number} [maxSide]
   * @returns {Promise<string>}
   */
  async function makeThumbnailDataUrl(ab, mimeType, maxSide) {
    const max = typeof maxSide === "number" && maxSide > 32 ? maxSide : 320;
    const mime = (mimeType || "image/jpeg").split(";")[0].trim().toLowerCase();
    if (mime === "image/svg+xml") {
      return "";
    }
    try {
      const blob = new Blob([ab], { type: mime || "image/jpeg" });
      const bmp = await createImageBitmap(blob);
      const w = bmp.width;
      const h = bmp.height;
      if (!(w > 0 && h > 0)) {
        bmp.close();
        return "";
      }
      const scale = Math.min(1, max / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const c = document.createElement("canvas");
      c.width = tw;
      c.height = th;
      const ctx = c.getContext("2d");
      if (!ctx) {
        bmp.close();
        return "";
      }
      ctx.drawImage(bmp, 0, 0, tw, th);
      bmp.close();
      return c.toDataURL("image/jpeg", 0.85);
    } catch (_) {
      return "";
    }
  }

  /**
   * Recover attachment chips for older saves (no `displayAttachments`), from `content` tail.
   * @param {string} content
   * @returns {RowAttachment[] | null}
   */
  function hydrateAttachmentsFromContent(content) {
    if (typeof content !== "string") {
      return null;
    }
    const key = "---\nAttached files";
    const idx = content.lastIndexOf(key);
    if (idx === -1) {
      return null;
    }
    let tail = content.slice(idx + key.length);
    const nl0 = tail.indexOf("\n");
    if (nl0 !== -1) {
      tail = tail.slice(nl0 + 1);
    }
    /** @type {RowAttachment[]} */
    const out = [];
    for (const line of tail.split("\n")) {
      const mm = /^- (.+) \(([^)]+)\)\s*$/.exec(line.trim());
      if (!mm) {
        continue;
      }
      const name = mm[1];
      const mime = mm[2];
      let kind = "file";
      if (mime.startsWith("image/") || isProbablyImage(name, mime)) {
        kind = "image";
      } else if (mime.startsWith("audio/") || isProbablyAudio(name, mime)) {
        kind = "audio";
      }
      out.push({ name, kind });
    }
    return out.length ? out : null;
  }

  /** @param {ArrayBuffer} ab */
  function arrayBufferToBase64(ab) {
    const bytes = new Uint8Array(ab);
    const chunk = 0x8000;
    let bin = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /** @param {string} text
   * @returns {Promise<{ userContent: string, staged: { name: string, sampleRate: number, pcm: ArrayBuffer }[], images: { fileName: string, mediaType: string, base64: string }[], displayAttachments: RowAttachment[] }>}
   */
  async function buildUserMessageAndStaged(text) {
    let vision = false;
    try {
      if (typeof aa.settingsGet === "function") {
        const snap = await aa.settingsGet();
        if (snap && snap.resolved && snap.resolved.llm) {
          vision = !!snap.resolved.llm.vision;
        }
      }
    } catch (_) {}

    const base = typeof text === "string" ? text.trim() : "";
    const lines = [];
    /** @type {{ name: string, sampleRate: number, pcm: ArrayBuffer }[]} */
    const staged = [];
    /** @type {{ fileName: string, mediaType: string, base64: string }[]} */
    const images = [];
    const dec = globalThis.aaWhisperDecode;
    let anyImage = false;
    /** @type {RowAttachment[]} */
    const displayAttachments = [];
    for (const p of pendingAttachments) {
      lines.push("- " + p.name + " (" + p.type + ")");
      if (isProbablyImage(p.name, p.type)) {
        anyImage = true;
        const mime = guessImageMediaType(p.name, p.type);
        const thumb = await makeThumbnailDataUrl(p.ab, mime);
        /** @type {RowAttachment} */
        const chip = { name: p.name, kind: "image" };
        if (p.previewUrl) {
          chip.previewUrl = p.previewUrl;
        }
        if (thumb) {
          chip.thumbnailDataUrl = thumb;
        }
        displayAttachments.push(chip);
      } else if (isProbablyAudio(p.name, p.type)) {
        displayAttachments.push({ name: p.name, kind: "audio" });
      } else {
        displayAttachments.push({ name: p.name, kind: "file" });
      }
      if (isProbablyAudio(p.name, p.type) && dec && typeof dec.decodeToMonoF32 === "function") {
        try {
          const { samples, sampleRate } = await dec.decodeToMonoF32(p.ab);
          const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
          staged.push({ name: p.name, sampleRate, pcm });
        } catch (_) {
          /* listed but not staged — tool may error */
        }
      }
      if (vision && isProbablyImage(p.name, p.type)) {
        try {
          const mediaType = guessImageMediaType(p.name, p.type);
          const base64 = arrayBufferToBase64(p.ab);
          if (base64.length) {
            images.push({ fileName: p.name, mediaType, base64 });
          }
        } catch (_) {
          /* skip image */
        }
      }
    }
    pendingAttachments.length = 0;
    renderAttachList();
    let head =
      lines.length && !base
        ? "User attached files (see list below — use stt with exact file_name to transcribe audio to text)."
        : base;
    if (anyImage && !vision) {
      head +=
        (head ? "\n\n" : "") +
        "[Vision (image input) is off in Settings → LLM — model only sees file names above, not pixels.]";
    }
    const block =
      "\n\n---\nAttached files (full names — call stt with file_name matching one line for audio):\n" +
      lines.join("\n");
    const userContent = lines.length ? head + block : head;
    return { userContent, staged, images, displayAttachments };
  }

  /** @param {number} tier 1..3 */
  function thinkModeButtonInner(tier) {
    let h = '<span class="msg-stream__think-dots" aria-hidden="true">';
    for (let i = 1; i <= 3; i += 1) {
      h += '<span class="msg-stream__think-dot' + (i <= tier ? " is-on" : "") + '"></span>';
    }
    return h + "</span>";
  }

  /** @param {number} tier */
  function thinkModeAriaLabel(tier) {
    const names = ["", "Minimal (label only)", "Compact panel", "Expanded panel"];
    return "Thinking size: " + names[tier] + ". Click to cycle.";
  }

  /** @param {number} tier */
  function thinkModeTitle(tier) {
    const names = ["", "Minimal", "Compact", "Expanded"];
    return names[tier] + " — click to change";
  }

  function getThinkTier() {
    try {
      const v = localStorage.getItem(THINK_TIER_KEY);
      const n = parseInt(v || "2", 10);
      if (n === 1 || n === 2 || n === 3) return n;
    } catch (_) {}
    return 2;
  }

  /** Apply tier to every thinking panel + persist. @param {number} tier */
  function syncThinkPanelsToTier(tier) {
    const t = tier >= 1 && tier <= 3 ? tier : 2;
    try {
      localStorage.setItem(THINK_TIER_KEY, String(t));
    } catch (_) {}

    document.querySelectorAll(".msg-stream__think").forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      node.classList.remove("think-tier--1", "think-tier--2", "think-tier--3");
      node.classList.add("think-tier--" + t);
      const btn = node.querySelector(".msg-stream__think-mode");
      const label = node.querySelector(".msg-stream__label");
      if (btn) {
        btn.innerHTML = thinkModeButtonInner(t);
        btn.setAttribute("aria-label", thinkModeAriaLabel(t));
        btn.title = thinkModeTitle(t);
      }
      if (label) {
        label.textContent = t === 1 ? "thinking …" : "thinking";
      }
    });
  }

  /**
   * @param {{ wallMs?: number, usage?: object | null, system_fingerprint?: string | null }} done
   * @returns {UsageMeta|undefined}
   */
  function buildUsageMeta(done) {
    const wallMs = typeof done.wallMs === "number" ? done.wallMs : 0;
    const u = done.usage && typeof done.usage === "object" ? /** @type {Record<string, unknown>} */ (done.usage) : null;
    const hasUsage =
      u !== null &&
      (typeof u.prompt_tokens === "number" ||
        typeof u.completion_tokens === "number" ||
        typeof u.total_tokens === "number");
    if (!hasUsage && wallMs <= 0) return undefined;
    const prompt = typeof u?.prompt_tokens === "number" ? u.prompt_tokens : null;
    const completion = typeof u?.completion_tokens === "number" ? u.completion_tokens : null;
    /** @type {number | null} */
    let total = null;
    if (typeof u?.total_tokens === "number") {
      total = u.total_tokens;
    } else if (typeof u?.prompt_tokens === "number" && typeof u?.completion_tokens === "number") {
      total = u.prompt_tokens + u.completion_tokens;
    }
    const rawDetails = u?.completion_tokens_details;
    let reasoning_tokens;
    if (rawDetails && typeof rawDetails.reasoning_tokens === "number") {
      reasoning_tokens = rawDetails.reasoning_tokens;
    }
    let msPerToken = null;
    if (wallMs > 0) {
      if (completion !== null && completion > 0) msPerToken = wallMs / completion;
      else if (total !== null && total > 0) msPerToken = wallMs / total;
    }
    /** @type {UsageMeta} */
    const meta = {
      wallMs,
      total_tokens: total,
      prompt_tokens: prompt,
      completion_tokens: completion,
      reasoning_tokens,
      msPerToken,
    };
    if (typeof done.system_fingerprint === "string" && done.system_fingerprint.length) {
      meta.system_fingerprint = done.system_fingerprint;
    }
    return meta;
  }

  /** @param {UsageMeta} meta @param {number|undefined} agentToolCount */
  function usageFooterEl(meta, agentToolCount) {
    const el = document.createElement("div");
    el.className = "msg-usage";
    el.setAttribute("aria-label", "Generation stats");
    const parts = [];
    if (meta.wallMs > 0) {
      parts.push((meta.wallMs / 1000).toFixed(1) + " s round-trip");
    }
    if (meta.total_tokens !== null) {
      parts.push(meta.total_tokens + " tok total");
    }
    if (meta.prompt_tokens !== null) {
      parts.push("prompt " + meta.prompt_tokens);
    }
    if (meta.completion_tokens !== null) {
      parts.push("completion " + meta.completion_tokens);
    }
    if (typeof meta.reasoning_tokens === "number") {
      parts.push("reasoning " + meta.reasoning_tokens);
    }
    // if (meta.msPerToken !== null && Number.isFinite(meta.msPerToken) && meta.msPerToken > 0) {
    //   const tps = 1000 / meta.msPerToken;
    //   parts.push(tps.toFixed(2) + " tok/s");
    // }
    if (typeof agentToolCount === "number" && Number.isFinite(agentToolCount) && agentToolCount >= 0) {
      parts.push(agentToolCount + " tool" + (agentToolCount === 1 ? "" : "s"));
    }
    el.textContent = parts.join(" · ");
    if (meta.system_fingerprint) {
      const fp = meta.system_fingerprint.length > 64 ? meta.system_fingerprint.slice(0, 64) + "…" : meta.system_fingerprint;
      const sub = document.createElement("div");
      sub.className = "msg-usage__fp";
      sub.textContent = fp;
      el.appendChild(sub);
    }
    return el;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Strip attachment manifest + vision hint from bubble; full `content` stays for model. */
  function userDisplayBody(content, hasManifest) {
    if (!hasManifest || typeof content !== "string") {
      return content;
    }
    let t = content.replace(/\r\n/g, "\n");
    t = t.replace(/\n\n---\nAttached files[\s\S]*$/m, "");
    t = t.replace(/\n\n\[Vision \(image input\) is off[^\]]+\]/, "");
    t = t.trim();
    t = t
      .replace(
        /^User attached files \(see list below — use stt with exact file_name to transcribe audio to text\)\.\s*/m,
        "",
      )
      .trim();
    return t;
  }

  /** Static SVG — speaker bars. @returns {SVGElement} */
  function audioAttachIcon() {
    const tpl = document.createElement("template");
    tpl.innerHTML =
      '<svg class="msg-attach-chip__svg" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M8 9v6M16 7v10M4 10v4M20 8v8"/></svg>';
    const n = tpl.content.firstChild;
    return /** @type {SVGElement} */ (n);
  }

  /** @returns {SVGElement} */
  function fileAttachIcon() {
    const tpl = document.createElement("template");
    tpl.innerHTML =
      '<svg class="msg-attach-chip__svg" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>';
    const n = tpl.content.firstChild;
    return /** @type {SVGElement} */ (n);
  }

  /** @param {string} roleLower user|assistant|system @param {number|undefined} atMs @param {string|undefined} source */
  function roleHeadHtml(roleLower, atMs, source) {
    const label =
      source === "telegram"
        ? '<span class="msg__role-name">' +
          esc(roleLower) +
          '</span><span class="msg__channel-tag" title="Telegram thread">TG</span>'
        : esc(roleLower);
    let timeHtml = "";
    if (typeof atMs === "number" && Number.isFinite(atMs)) {
      const d = new Date(atMs);
      let iso = "";
      try {
        iso = d.toISOString();
      } catch {
        iso = "";
      }
      let disp = "";
      try {
        disp = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      } catch {
        disp = iso || String(atMs);
      }
      if (disp) {
        timeHtml =
          '<time class="msg__time"' +
          (iso ? ' datetime="' + esc(iso) + '"' : "") +
          ">" +
          esc(disp) +
          "</time>";
      }
    }
    return (
      '<div class="role-h">' +
      '<span class="role-h__label">' +
      label +
      "</span>" +
      timeHtml +
      "</div>"
    );
  }

  /** #messages only scroll surface — flush layout then pin end (streaming + tool steps). */
  function scrollMsgsToBottom() {
    requestAnimationFrame(() => {
      elMsgs.scrollTop = elMsgs.scrollHeight;
      requestAnimationFrame(() => {
        elMsgs.scrollTop = elMsgs.scrollHeight;
      });
    });
  }

  /** Serialize rows for userData JSON (Electron `aa-chat-history.json`). */
  function rowsForPersist() {
    return history
      .filter((m) => m.source !== "telegram")
      .map((m) => {
      /** @type {Record<string, unknown>} */
      const o = { role: m.role, content: m.content };
      if (typeof m.atMs === "number" && Number.isFinite(m.atMs)) o.atMs = m.atMs;
      if (typeof m.reasoning === "string" && m.reasoning.length) o.reasoning = m.reasoning;
      if (typeof m.agentTrace === "string" && m.agentTrace.length) o.agentTrace = m.agentTrace;
      if (m.usageMeta && typeof m.usageMeta === "object") o.usageMeta = m.usageMeta;
      if (m.source === "app" || m.source === "telegram" || m.source === "scheduler") o.source = m.source;
      if (m.errReply === true) o.errReply = true;
      if (m.displayAttachments && m.displayAttachments.length) {
        o.displayAttachments = m.displayAttachments.map((a) => {
          /** @type {Record<string, unknown>} */
          const x = { name: a.name, kind: a.kind };
          if (
            a.kind === "image" &&
            typeof a.thumbnailDataUrl === "string" &&
            a.thumbnailDataUrl.startsWith("data:")
          ) {
            x.thumbnailDataUrl = a.thumbnailDataUrl;
          }
          return x;
        });
      }
      if (m.agentTtsClips && m.agentTtsClips.length) {
        const maxClips = 8;
        const maxLen = 6000000;
        /** @type {{ dataUrl: string }[]} */
        const clips = [];
        for (const c of m.agentTtsClips) {
          if (clips.length >= maxClips) {
            break;
          }
          if (typeof c.dataUrl !== "string" || !c.dataUrl.startsWith("data:audio/")) {
            continue;
          }
          if (c.dataUrl.length > maxLen) {
            continue;
          }
          clips.push({ dataUrl: c.dataUrl });
        }
        if (clips.length) {
          o.agentTtsClips = clips;
        }
      }
      if (typeof m.agentToolCount === "number" && Number.isFinite(m.agentToolCount) && m.agentToolCount >= 0) {
        o.agentToolCount = m.agentToolCount;
      }
      return o;
    });
  }

  /** Apply server-side transcript (includes Telegram mirror rows when Settings flag on). */
  function applyRowsFromServer(rawRows) {
    if (!Array.isArray(rawRows)) {
      return;
    }
    history.length = 0;
    for (const raw of rawRows) {
      const row = normalizeHistoryRow(raw);
      if (row) history.push(row);
    }
    render();
    syncThinkPanelsToTier(getThinkTier());
  }

  async function pullHistoryFromMain() {
    if (typeof aa.chatHistoryGet !== "function" || !historyHydrated) {
      return;
    }
    if (agentBusy) {
      mirrorRefreshQueued = true;
      return;
    }
    try {
      const res = await aa.chatHistoryGet();
      if (res && res.ok === true && Array.isArray(res.rows)) {
        applyRowsFromServer(res.rows);
      }
    } catch (_) {}
  }

  /** Serialize disk writes so rapid scheduler (or any) turns cannot reorder IPC — stale save must not overwrite newer history. */
  let persistChain = Promise.resolve();

  function persistHistory() {
    if (typeof aa.chatHistorySave !== "function") return;
    persistChain = persistChain.then(() =>
      aa.chatHistorySave(rowsForPersist()).catch(() => {}),
    );
  }

  /** @param {unknown} r */
  function normalizeHistoryRow(r) {
    if (!r || typeof r !== "object") return null;
    const o = /** @type {Record<string, unknown>} */ (r);
    const role = typeof o.role === "string" ? o.role.trim().toLowerCase() : "";
    if (role !== "user" && role !== "assistant" && role !== "system") return null;
    /** @type {typeof history[number]} */
    const row = { role, content: typeof o.content === "string" ? o.content : "" };
    if (o.source === "app" || o.source === "telegram" || o.source === "scheduler") {
      row.source = o.source;
    } else if (
      row.content &&
      /^\[Scheduled:[^\]]+\]\n\n/.test(row.content)
    ) {
      row.source = "scheduler";
    }
    if (typeof o.reasoning === "string" && o.reasoning.length) row.reasoning = o.reasoning;
    if (typeof o.atMs === "number" && Number.isFinite(o.atMs)) row.atMs = o.atMs;
    else if (typeof o.at === "string" && o.at.length) {
      const parsed = Date.parse(o.at);
      if (!Number.isNaN(parsed)) row.atMs = parsed;
    }
    if (typeof o.agentTrace === "string" && o.agentTrace.length) row.agentTrace = o.agentTrace;
    if (typeof o.agentToolCount === "number" && Number.isFinite(o.agentToolCount) && o.agentToolCount >= 0) {
      row.agentToolCount = o.agentToolCount;
    }
    const um = o.usageMeta;
    if (um && typeof um === "object") {
      const u = /** @type {Record<string, unknown>} */ (um);
      row.usageMeta = {
        wallMs: typeof u.wallMs === "number" ? u.wallMs : 0,
        total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
        prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
        completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
        msPerToken: typeof u.msPerToken === "number" ? u.msPerToken : null,
      };
      if (typeof u.reasoning_tokens === "number") row.usageMeta.reasoning_tokens = u.reasoning_tokens;
      if (typeof u.system_fingerprint === "string") row.usageMeta.system_fingerprint = u.system_fingerprint;
    }
    if (o.errReply === true) row.errReply = true;
    if (typeof o.telegramChatId === "number" && Number.isFinite(o.telegramChatId)) {
      row.telegramChatId = Math.floor(o.telegramChatId);
    }
    if (Array.isArray(o.displayAttachments)) {
      /** @type {RowAttachment[]} */
      const list = [];
      for (const raw of o.displayAttachments) {
        if (!raw || typeof raw !== "object") {
          continue;
        }
        const x = /** @type {Record<string, unknown>} */ (raw);
        const name = typeof x.name === "string" ? x.name : "";
        const k = x.kind;
        const kind = k === "audio" ? "audio" : k === "file" ? "file" : "image";
        if (!name) {
          continue;
        }
        /** @type {RowAttachment} */
        const a = { name, kind };
        if (
          kind === "image" &&
          typeof x.thumbnailDataUrl === "string" &&
          x.thumbnailDataUrl.startsWith("data:")
        ) {
          a.thumbnailDataUrl = x.thumbnailDataUrl;
        }
        list.push(a);
      }
      if (list.length) {
        row.displayAttachments = list;
      }
    }
    if (Array.isArray(o.agentTtsClips)) {
      const maxClips = 8;
      const maxLen = 6000000;
      /** @type {{ dataUrl: string }[]} */
      const clips = [];
      for (const raw of o.agentTtsClips) {
        if (clips.length >= maxClips) {
          break;
        }
        if (!raw || typeof raw !== "object") {
          continue;
        }
        const x = /** @type {Record<string, unknown>} */ (raw);
        const du = typeof x.dataUrl === "string" ? x.dataUrl : "";
        if (!du.startsWith("data:audio/") || du.length > maxLen) {
          continue;
        }
        clips.push({ dataUrl: du });
      }
      if (clips.length) {
        row.agentTtsClips = clips;
      }
    }
    if (!(row.displayAttachments && row.displayAttachments.length)) {
      const hydrated = hydrateAttachmentsFromContent(row.content);
      if (hydrated) {
        row.displayAttachments = hydrated;
      }
    }
    return row;
  }

  /** Last row is user and no agent turn running — needs Retry (persisted crash/skip or fresh fail before assistant row). */
  function orphanUserNeedsRetry() {
    if (agentBusy) return false;
    if (!history.length) return false;
    const last = history[history.length - 1];
    return last.role === "user" && last.source !== "telegram";
  }

  /** @param {number} index */
  function deleteMessageAt(index) {
    if (agentBusy) return;
    if (!(typeof index === "number" && index >= 0 && index < history.length)) return;
    if (history[index].source === "telegram") return;
    history.splice(index, 1);
    const last = history.length ? history[history.length - 1] : null;
    if (!last || last.role !== "user") {
      lastTurnStagedAudio = null;
    }
    render();
  }

  function render() {
    if (!history.length) {
      elMsgs.innerHTML = '<div class="empty">Send a message to talk to the local model.</div>';
      persistHistory();
      return;
    }
    elMsgs.innerHTML = "";
    for (let i = 0; i < history.length; i += 1) {
      elMsgs.appendChild(msgElFromRow(history[i], i));
    }
    scrollMsgsToBottom();
    persistHistory();
  }

  function msgElFromRow(m, index) {
    const r = (m.role || "user").toLowerCase();
    const div = document.createElement("div");
    div.className =
      "msg role-" +
      r +
      (m.source === "scheduler" ? " msg--scheduler-push" : "") +
      (m.source === "telegram" ? " msg--telegram" : "") +
      (r === "assistant" && m.errReply ? " error" : "");
    const head = roleHeadHtml(r, m.atMs, m.source);
    if (r === "assistant" && m.reasoning) {
      const tr = getThinkTier();
      const lbl = tr === 1 ? "thinking …" : "thinking";
      div.innerHTML =
        head +
        '<div class="msg-stream">' +
        '<aside class="msg-stream__think think-tier--' +
        tr +
        '">' +
        '<div class="msg-stream__think-head">' +
        '<span class="msg-stream__label">' +
        esc(lbl) +
        "</span>" +
        '<button type="button" class="msg-stream__think-mode" aria-label="' +
        esc(thinkModeAriaLabel(tr)) +
        '" title="' +
        esc(thinkModeTitle(tr)) +
        '">' +
        thinkModeButtonInner(tr) +
        "</button></div>" +
        '<div class="msg-stream__think-body"><pre class="msg-stream__think-text">' +
        esc(m.reasoning) +
        "</pre></div></aside>" +
        '<div class="msg-stream__answer">' +
        esc(m.content) +
        "</div></div>";
    } else if (r === "user" && m.displayAttachments && m.displayAttachments.length) {
      div.insertAdjacentHTML("afterbegin", roleHeadHtml(r, m.atMs, m.source));
      const bodyWrap = document.createElement("div");
      bodyWrap.className = "body body--with-attach";
      const strip = document.createElement("div");
      strip.className = "msg-attach-strip";
      strip.setAttribute("aria-label", "Attached files");
      for (const a of m.displayAttachments) {
        const chip = document.createElement("div");
        chip.className = "msg-attach-chip msg-attach-chip--" + a.kind;
        chip.title = a.name;
        if (a.kind === "image") {
          const src = a.thumbnailDataUrl || a.previewUrl;
          if (src) {
            const img = document.createElement("img");
            img.className = "msg-attach-chip__img";
            img.src = src;
            img.alt = "";
            img.loading = "lazy";
            chip.appendChild(img);
          } else {
            const hi = document.createElement("div");
            hi.className = "msg-attach-chip__ico-wrap";
            hi.appendChild(fileAttachIcon());
            chip.appendChild(hi);
          }
        } else if (a.kind === "audio") {
          const hi = document.createElement("div");
          hi.className = "msg-attach-chip__ico-wrap";
          hi.appendChild(audioAttachIcon());
          chip.appendChild(hi);
        } else {
          const hi = document.createElement("div");
          hi.className = "msg-attach-chip__ico-wrap";
          hi.appendChild(fileAttachIcon());
          chip.appendChild(hi);
        }
        const nm = document.createElement("span");
        nm.className = "msg-attach-chip__name";
        nm.textContent = a.name;
        chip.appendChild(nm);
        strip.appendChild(chip);
      }
      bodyWrap.appendChild(strip);
      const textPart = userDisplayBody(m.content, true);
      if (textPart) {
        const p = document.createElement("div");
        p.className = "msg-attach-text";
        p.textContent = textPart;
        bodyWrap.appendChild(p);
      }
      div.appendChild(bodyWrap);
      if (
        orphanUserNeedsRetry() &&
        typeof index === "number" &&
        index === history.length - 1
      ) {
        const row = document.createElement("div");
        row.className = "msg-user-actions";
        const rb = document.createElement("button");
        rb.type = "button";
        rb.className = "btn-msg-retry";
        rb.textContent = "Retry";
        rb.setAttribute("aria-label", "Retry sending this message");
        rb.addEventListener("click", () => {
          void executeAgentChatTurn();
        });
        row.appendChild(rb);
        div.appendChild(row);
      }
    } else {
      div.innerHTML = roleHeadHtml(r, m.atMs, m.source) + '<div class="body">' + esc(m.content) + "</div>";
      if (
        r === "user" &&
        orphanUserNeedsRetry() &&
        typeof index === "number" &&
        index === history.length - 1
      ) {
        const row = document.createElement("div");
        row.className = "msg-user-actions";
        const rb = document.createElement("button");
        rb.type = "button";
        rb.className = "btn-msg-retry";
        rb.textContent = "Retry";
        rb.setAttribute("aria-label", "Retry sending this message");
        rb.addEventListener("click", () => {
          void executeAgentChatTurn();
        });
        row.appendChild(rb);
        div.appendChild(row);
      }
    }
    if (r === "assistant" && m.agentTrace) {
      const tr = document.createElement("div");
      tr.className = "agent-tool-trace";
      tr.textContent = m.agentTrace;
      div.appendChild(tr);
    }
    if (r === "assistant" && m.agentTtsClips && m.agentTtsClips.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-tts-clips";
      for (const c of m.agentTtsClips) {
        if (typeof c.dataUrl !== "string" || !c.dataUrl.startsWith("data:")) {
          continue;
        }
        const aud = document.createElement("audio");
        aud.controls = true;
        aud.preload = "none";
        aud.src = c.dataUrl;
        aud.setAttribute("aria-label", "Agent text-to-speech");
        wrap.appendChild(aud);
      }
      if (wrap.childElementCount) {
        div.appendChild(wrap);
      }
    }
    if (r === "assistant" && m.usageMeta) {
      div.appendChild(usageFooterEl(m.usageMeta, m.agentToolCount));
    }
    if (typeof index === "number" && m.source !== "telegram") {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "msg-delete";
      del.textContent = "×";
      del.setAttribute("aria-label", "Delete message");
      del.title = "Remove from history";
      if (agentBusy) {
        del.disabled = true;
      }
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        deleteMessageAt(index);
      });
      div.appendChild(del);
    }
    return div;
  }

  /** Pending agent turn — same layout as streamed thinking + answer (not plain "Working…"). */
  function pendingAssistAgent() {
    const pendingAt = Date.now();
    const tr = getThinkTier();
    const lbl = tr === 1 ? "thinking …" : "thinking";
    const wrap = document.createElement("div");
    wrap.className = "msg role-assistant pending";
    wrap.innerHTML =
      roleHeadHtml("assistant", pendingAt, undefined) +
      '<div class="msg-stream">' +
      '<aside class="msg-stream__think think-tier--' +
      tr +
      ' msg-stream__think--live">' +
      '<div class="msg-stream__think-head">' +
      '<span class="msg-stream__label">' +
      esc(lbl) +
      "</span>" +
      '<button type="button" class="msg-stream__think-mode" aria-label="' +
      esc(thinkModeAriaLabel(tr)) +
      '" title="' +
      esc(thinkModeTitle(tr)) +
      '">' +
      thinkModeButtonInner(tr) +
      "</button></div>" +
      '<div class="msg-stream__think-body"><pre class="msg-stream__think-text"></pre></div></aside>' +
      '<div class="msg-stream__answer msg-stream__answer--live"></div></div>';
    const ans = wrap.querySelector(".msg-stream__answer");
    const thinkPre = wrap.querySelector(".msg-stream__think-text");
    const thinkBody = wrap.querySelector(".msg-stream__think-body");
    let answerShowsSearchBanner = false;
    return {
      el: wrap,
      setAnswerSearchBanner(t) {
        answerShowsSearchBanner = true;
        if (ans) ans.textContent = typeof t === "string" ? t : "";
      },
      appendThink(t) {
        if (!(thinkPre instanceof HTMLElement)) return;
        thinkPre.textContent += typeof t === "string" ? t : "";
        if (thinkBody instanceof HTMLElement) {
          requestAnimationFrame(() => {
            thinkBody.scrollTop = thinkBody.scrollHeight;
          });
        }
      },
      appendAnswer(t) {
        if (!ans) return;
        if (answerShowsSearchBanner) {
          ans.textContent = "";
          answerShowsSearchBanner = false;
        }
        ans.textContent += typeof t === "string" ? t : "";
      },
      remove() {
        wrap.remove();
      },
    };
  }

  /**
   * @param {unknown} ply scheduler IPC payload
   * @param {boolean} [silent] if true, skip `render()` (batch flush calls `render` once)
   */
  function applySchedulerFinished(ply, silent) {
    if (!ply || typeof ply !== "object") return;
    const po = /** @type {Record<string, unknown>} */ (ply);
    const title = typeof po.title === "string" ? po.title : "Scheduled";
    const ok = po.ok === true;
    let body = "";
    if (ok && typeof po.text === "string") body = po.text;
    else if (typeof po.error === "string") body = po.error;
    else body = ok ? "" : "error";
    const content = "[Scheduled: " + title + "]\n\n" + body;
    /** Main may append same completion to disk before history loads — skip duplicate IPC row */
    if (history.some((r) => r.role === "assistant" && r.content === content)) return;
    const trace = formatAgentSteps(po.steps);
    const usageRaw =
      po.usage !== null && po.usage !== undefined && typeof po.usage === "object"
        ? /** @type {Record<string, unknown>} */ (po.usage)
        : null;
    const usageMeta = usageRaw
      ? buildUsageMeta({
          wallMs: 0,
          usage: usageRaw,
        })
      : undefined;
    const ttsClips = collectAgentTtsClips(po.steps);
    const agentToolCount = countAgentToolRuns(po.steps);
    history.push({
      role: "assistant",
      source: "scheduler",
      atMs: Date.now(),
      content,
      ...(trace ? { agentTrace: trace } : {}),
      ...(ttsClips.length ? { agentTtsClips: ttsClips } : {}),
      ...(usageMeta ? { usageMeta } : {}),
      agentToolCount,
    });
    if (!silent) render();
  }

  function countAgentToolRuns(steps) {
    if (!Array.isArray(steps)) return 0;
    let n = 0;
    for (const s of steps) {
      if (!s || typeof s !== "object") continue;
      if (s.status !== "done") continue;
      const k = s.kind;
      if (k === "web_search" || k === "schedule_job" || k === "stt" || k === "tts") {
        n += 1;
      }
    }
    return n;
  }

  function collectAgentTtsClips(steps) {
    /** @type {{ dataUrl: string }[]} */
    const out = [];
    if (!Array.isArray(steps)) return out;
    for (const s of steps) {
      if (
        s &&
        typeof s === "object" &&
        s.kind === "tts" &&
        s.status === "done" &&
        typeof s.dataUrl === "string" &&
        s.dataUrl.startsWith("data:audio/")
      ) {
        out.push({ dataUrl: s.dataUrl });
      }
    }
    return out;
  }

  /** @param {unknown} steps */
  function formatAgentSteps(steps) {
    if (!Array.isArray(steps)) return "";
    const bits = [];
    for (const s of steps) {
      if (s && typeof s === "object" && s.kind === "schedule_job" && s.status === "done") {
        const act = typeof s.action === "string" ? s.action : "?";
        const ok = s.ok !== false;
        const sum = typeof s.summary === "string" ? s.summary : "";
        bits.push("schedule_job " + act + (ok ? " ✓" : " ✗") + (sum ? " · " + sum : ""));
        continue;
      }
      if (
        s &&
        typeof s === "object" &&
        s.kind === "stt" &&
        s.status === "done"
      ) {
        const fn = typeof s.file_name === "string" ? s.file_name : "?";
        const ok = /** @type {{ ok?: boolean }} */ (s).ok !== false;
        const pv = typeof s.preview === "string" ? s.preview : "";
        const err = typeof s.error === "string" ? s.error : "";
        let line = 'stt "' + (fn.length > 48 ? fn.slice(0, 48) + "…" : fn) + '"' + (ok ? " ✓" : " ✗");
        if (ok && pv) {
          line += "\n  " + pv;
        } else if (!ok && err) {
          line += "\n  " + err;
        }
        bits.push(line);
        continue;
      }
      if (s && typeof s === "object" && s.kind === "tts" && s.status === "done") {
        const ok = /** @type {{ ok?: boolean }} */ (s).ok !== false;
        const sec = typeof s.duration_seconds === "number" ? s.duration_seconds : null;
        const err = typeof s.error === "string" ? s.error : "";
        let line = "tts" + (ok ? " ✓" : " ✗");
        if (ok && sec != null) line += " · " + sec + "s";
        else if (!ok && err) line += "\n  " + err;
        bits.push(line);
        continue;
      }
      if (
        s &&
        typeof s === "object" &&
        s.kind === "web_search" &&
        s.status === "done"
      ) {
        const q = typeof s.query === "string" ? s.query : "?";
        const n = typeof s.hitCount === "number" ? s.hitCount : 0;
        const ok = /** @type {{ ok?: boolean }} */ (s).ok !== false;
        const pv = typeof s.previewSummary === "string" ? s.previewSummary : "";
        const prov =
          typeof s.provider === "string"
            ? s.provider +
              (typeof s.scrapeBackend === "string" && s.scrapeBackend.length
                ? "/" + s.scrapeBackend
                : "")
            : "";
        let line =
          'web_search "' +
          (q.length > 56 ? q.slice(0, 56) + "…" : q) +
          '" → ' +
          n +
          " hit" +
          (n === 1 ? "" : "s") +
          (ok ? "" : " (fail)");
        if (prov) line += " · " + prov;
        bits.push(line + (pv ? "\n  " + pv : ""));
      }
    }
    return bits.join("\n\n");
  }

  /** Re-run agent for current transcript when last row is `user` (new send or Retry). */
  async function executeAgentChatTurn() {
    if (agentBusy) return;
    if (!history.length || history[history.length - 1].role !== "user") return;
    if (history[history.length - 1].source === "telegram") return;

    agentBusy = true;
    elSend.disabled = true;
    render();

    const pend = pendingAssistAgent();
    elMsgs.appendChild(pend.el);
    scrollMsgsToBottom();

    const payloads = history
      .filter((h) => h.source !== "telegram")
      .map((h) => {
      /** @type {Record<string, unknown>} */
      const o = {
        role: h.role === "assistant" ? "assistant" : h.role === "system" ? "system" : "user",
        content: h.content,
      };
      if (h.role === "user" && h.images && h.images.length) {
        o.images = h.images;
      }
      return o;
    });

    const t0 = Date.now();
    let streamedReasoningAcc = "";

    try {
      if (!aa.agentChat) {
        throw new Error("aaDesktop.agentChat missing — rebuild preload/main");
      }

      /** @type {{ ok?: boolean, text?: string, error?: string, steps?: unknown, usage?: unknown }} */
      const res = await aa.agentChat(
        payloads,
        (step) => {
          if (
            step &&
            typeof step === "object" &&
            step.kind === "stt" &&
            step.status === "start" &&
            typeof step.file_name === "string"
          ) {
            pend.setAnswerSearchBanner("stt (transcribing): " + step.file_name);
          }
          if (
            step &&
            typeof step === "object" &&
            step.kind === "tts" &&
            step.status === "start"
          ) {
            const pv = typeof step.preview === "string" ? step.preview : "";
            pend.setAnswerSearchBanner(
              "tts: " + (pv.length > 100 ? pv.slice(0, 100) + "…" : pv || "synthesizing…"),
            );
          }
          if (
            step &&
            typeof step === "object" &&
            step.kind === "web_search" &&
            step.status === "start" &&
            typeof step.query === "string"
          ) {
            pend.setAnswerSearchBanner(
              "Searching web: " + step.query.slice(0, 120) + (step.query.length > 120 ? "…" : ""),
            );
          }
          scrollMsgsToBottom();
        },
        (d) => {
          if (d && typeof d === "object") {
            if (typeof d.reasoning === "string" && d.reasoning.length) {
              streamedReasoningAcc += d.reasoning;
              pend.appendThink(d.reasoning);
            }
            if (typeof d.content === "string" && d.content.length) {
              pend.appendAnswer(d.content);
            }
          }
          scrollMsgsToBottom();
        },
        lastTurnStagedAudio && lastTurnStagedAudio.length ? lastTurnStagedAudio : [],
      );

      const wallMs = Date.now() - t0;

      if (!res || res.ok !== true) {
        /** @type {string} */
        let msg = "agent failed";
        if (res && typeof res === "object" && "error" in res && typeof res.error === "string") {
          msg = res.error;
        }
        throw new Error(msg);
      }

      pend.remove();

      const trace = formatAgentSteps(res.steps);
      const ttsClips = collectAgentTtsClips(res.steps);
      const agentToolCount = countAgentToolRuns(res.steps);

      /** @type {Record<string, unknown>|null} */
      const usageForMeta =
        res.usage !== null && res.usage !== undefined && typeof res.usage === "object"
          ? /** @type {Record<string, unknown>} */ (res.usage)
          : null;

      const usageMeta =
        usageForMeta || wallMs > 0
          ? buildUsageMeta({
              wallMs,
              usage: usageForMeta,
            })
          : undefined;

      history.push({
        role: "assistant",
        atMs: Date.now(),
        content: res.text || "",
        source: "app",
        ...(streamedReasoningAcc.trim() ? { reasoning: streamedReasoningAcc } : {}),
        ...(trace ? { agentTrace: trace } : {}),
        ...(ttsClips.length ? { agentTtsClips: ttsClips } : {}),
        ...(usageMeta ? { usageMeta } : {}),
        agentToolCount,
      });
      lastTurnStagedAudio = null;
    } catch (err) {
      pend.remove();
      const errText = err instanceof Error ? err.message : String(err);
      history.push({ role: "assistant", atMs: Date.now(), content: errText, errReply: true, source: "app" });
    } finally {
      agentBusy = false;
      elSend.disabled = false;
      render();
      if (mirrorRefreshQueued) {
        mirrorRefreshQueued = false;
        void pullHistoryFromMain();
      }
      elInput.focus();
    }
  }

  async function onSend() {
    const text = elInput.value.trim();
    if (!text && !pendingAttachments.length) {
      return;
    }

    elInput.value = "";
    const { userContent, staged, images, displayAttachments } = await buildUserMessageAndStaged(text);
    lastTurnStagedAudio = staged.length ? staged : null;
    /** @type {typeof history[number]} */
    const urow = { role: "user", content: userContent, atMs: Date.now(), source: "app" };
    if (images.length) {
      urow.images = images;
    }
    if (displayAttachments.length) {
      urow.displayAttachments = displayAttachments;
    }
    history.push(urow);
    await executeAgentChatTurn();
  }

  elMsgs.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement | null} */ (e.target && "closest" in e.target ? e.target.closest(".msg-stream__think-mode") : null);
    if (!btn || !elMsgs.contains(btn)) return;
    e.preventDefault();
    const cur = getThinkTier();
    const next = cur >= 3 ? 1 : cur + 1;
    syncThinkPanelsToTier(next);
  });

  elForm.addEventListener("submit", (e) => {
    e.preventDefault();
    onSend();
  });
  elInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (elInput.value.trim() || pendingAttachments.length) {
        void onSend();
      }
    }
  });

  if (elBtnAttach instanceof HTMLButtonElement && elAttachFiles instanceof HTMLInputElement) {
    elBtnAttach.addEventListener("click", () => {
      elAttachFiles.click();
    });
    elAttachFiles.addEventListener("change", () => {
      const picked =
        elAttachFiles.files && elAttachFiles.files.length ? Array.from(elAttachFiles.files) : [];
      elAttachFiles.value = "";
      if (!picked.length) {
        return;
      }
      void (async () => {
        for (const f of picked) {
          try {
            const previewUrl =
              isProbablyImage(f.name, f.type || "") ? URL.createObjectURL(f) : undefined;
            const ab = await f.arrayBuffer();
            pendingAttachments.push({
              name: f.name,
              type: f.type || "application/octet-stream",
              ab,
              ...(previewUrl ? { previewUrl } : {}),
            });
          } catch (_) {
            /* skip */
          }
        }
        renderAttachList();
      })();
    });
  }

  if (typeof aa.onSchedulerJobFinished === "function") {
    aa.onSchedulerJobFinished((ply) => {
      if (!historyHydrated) {
        schedulerPending.push(ply);
        return;
      }
      applySchedulerFinished(ply);
    });
  }

  if (typeof aa.onChatMirrorRefresh === "function") {
    aa.onChatMirrorRefresh(() => {
      void pullHistoryFromMain();
    });
  }

  void (async function loadHistoryAndRender() {
    if (typeof aa.chatHistoryGet === "function") {
      try {
        const res = await aa.chatHistoryGet();
        if (res && res.ok === true && Array.isArray(res.rows)) {
          history.length = 0;
          for (const raw of res.rows) {
            const row = normalizeHistoryRow(raw);
            if (row) history.push(row);
          }
        }
      } catch (_) {}
    }
    historyHydrated = true;
    for (const p of schedulerPending) {
      applySchedulerFinished(p, true);
    }
    schedulerPending.length = 0;
    render();
    syncThinkPanelsToTier(getThinkTier());
    elInput.focus();
  })();
})();
