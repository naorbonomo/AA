(function () {
  const aa = /** @type {Record<string, (...args: unknown[]) => unknown>} */ (window).aaDesktop;

  const elList = document.getElementById("hist-session-list");
  const elTranscript = document.getElementById("hist-transcript");
  const elTitle = document.getElementById("hist-session-title");
  const elStatus = document.getElementById("hist-status");
  const elGapMin = document.getElementById("hist-gap-min");
  const elProgWrap = document.getElementById("hist-progress-wrap");
  const elProg = document.getElementById("hist-progress");
  const elProgLab = document.getElementById("hist-progress-label");

  function showHistProgress(visible) {
    if (elProgWrap) elProgWrap.hidden = !visible;
  }

  /**
   * @param {unknown} p
   */
  function formatHistEmbeddingProgress(p) {
    if (!p || typeof p !== "object") return "";
    const o = /** @type {{ phase?: string; step?: number; total?: number; label?: string }} */ (p);
    const phaseLab =
      o.phase === "index_conversation"
        ? "Embed history"
        : o.phase === "chatgpt_import"
          ? "ChatGPT import"
          : o.phase === "dev_index"
            ? "Embed"
            : typeof o.phase === "string"
              ? o.phase
              : "";
    const step = typeof o.step === "number" ? o.step : 0;
    const total = typeof o.total === "number" ? o.total : 1;
    const lab = typeof o.label === "string" ? o.label : "";
    return [phaseLab, `${Math.min(step, total)}/${total}`, lab].filter(Boolean).join(" · ");
  }

  /**
   * @param {unknown} p
   */
  function applyHistProgress(p) {
    if (!elProg || !elProgLab) return;
    showHistProgress(true);
    const o = p && typeof p === "object" ? /** @type {{ step?: number; total?: number }} */ (p) : {};
    const total = typeof o.total === "number" && o.total > 0 ? o.total : 1;
    const step = typeof o.step === "number" ? o.step : 0;
    elProg.max = total;
    elProg.value = Math.min(step, total);
    elProgLab.textContent = formatHistEmbeddingProgress(p);
  }

  if (typeof aa.onEmbeddingIndexProgress === "function") {
    aa.onEmbeddingIndexProgress((p) => applyHistProgress(p));
  }

  /** @type {{ id: string, label: string, rows: Record<string, unknown>[], imported?: boolean }[]} */
  let sessions = [];
  /** @type {number} */
  let selectedIdx = -1;

  function gapMs() {
    const raw = elGapMin instanceof HTMLInputElement ? elGapMin.value.trim() : "60";
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n < 1) return 60 * 60 * 1000;
    return Math.floor(n * 60 * 1000);
  }

  /**
   * @param {Record<string, unknown>[]} rows
   * @param {number} gap
   */
  function splitSessions(rows, gap) {
    /** @type {{ label: string, rows: Record<string, unknown>[] }[]} */
    const out = [];
    /** @type {Record<string, unknown>[] | null} */
    let cur = null;
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const at = typeof r.atMs === "number" && Number.isFinite(r.atMs) ? r.atMs : null;
      if (!cur) {
        cur = [r];
        continue;
      }
      const prev = cur[cur.length - 1];
      const prevAt = typeof prev.atMs === "number" && Number.isFinite(prev.atMs) ? prev.atMs : null;
      if (
        at != null &&
        prevAt != null &&
        at - prevAt > gap &&
        cur.length > 0
      ) {
        out.push(cur);
        cur = [r];
      } else {
        cur.push(r);
      }
    }
    if (cur && cur.length) out.push(cur);
    return out.map((sessRows, idx) => {
      const first = sessRows[0];
      const at0 =
        typeof first.atMs === "number" && Number.isFinite(first.atMs)
          ? first.atMs
          : Date.now();
      const label = new Date(at0).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
      return {
        id: `session-${idx}-${at0}`,
        label: `${label} · ${sessRows.length} msg`,
        rows: sessRows,
      };
    });
  }

  function renderList() {
    if (!elList) return;
    elList.textContent = "";
    sessions.forEach((s, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className =
        "history-session-btn" +
        (s.imported ? " history-session-btn--imported" : "") +
        (idx === selectedIdx ? " is-active" : "");
      b.textContent = s.label;
      b.addEventListener("click", () => {
        selectedIdx = idx;
        renderList();
        renderTranscript();
      });
      elList.appendChild(b);
    });
  }

  function renderTranscript() {
    if (!elTranscript || !elTitle) return;
    elTranscript.textContent = "";
    if (selectedIdx < 0 || selectedIdx >= sessions.length) {
      elTitle.textContent = "Select a session";
      return;
    }
    const s = sessions[selectedIdx];
    elTitle.textContent = s.label;
    for (const r of s.rows) {
      const role = typeof r.role === "string" ? r.role : "?";
      const content = typeof r.content === "string" ? r.content : "";
      const block = document.createElement("div");
      block.className = "history-msg history-msg--" + role;
      const meta = document.createElement("div");
      meta.className = "history-msg__role";
      meta.textContent = role;
      const body = document.createElement("div");
      body.className = "history-msg__body";
      body.textContent = content;
      block.appendChild(meta);
      block.appendChild(body);
      elTranscript.appendChild(block);
    }
  }

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg;
  }

  async function reload() {
    setStatus("Loading…");
    try {
      /** @type {{ id: string, label: string, rows: Record<string, unknown>[], imported?: boolean }[]} */
      const merged = [];

      if (typeof aa.importedChatSessionsGetLossless === "function") {
        /** @type {{ ok?: boolean, sessions?: unknown[], error?: string }} */
        const imp = /** @type {*} */ (await aa.importedChatSessionsGetLossless());
        if (imp && imp.ok === true && Array.isArray(imp.sessions)) {
          for (const raw of imp.sessions) {
            if (!raw || typeof raw !== "object") continue;
            const o = /** @type {Record<string, unknown>} */ (raw);
            const conversationId = typeof o.conversationId === "string" ? o.conversationId : "";
            const sessionLabel = typeof o.sessionLabel === "string" ? o.sessionLabel : "Imported";
            const rows = Array.isArray(o.rows) ? /** @type {Record<string, unknown>[]} */ (o.rows) : [];
            if (!conversationId || !rows.length) continue;
            merged.push({
              id: conversationId,
              label: `[ChatGPT] ${sessionLabel} · ${rows.length} msg`,
              rows,
              imported: true,
            });
          }
        }
      }

      if (!aa.chatHistoryGetLossless) throw new Error("aaDesktop.chatHistoryGetLossless missing");
      /** @type {{ ok?: boolean, rows?: unknown[], error?: string }} */
      const pack = /** @type {*} */ (await aa.chatHistoryGetLossless());
      if (!pack || pack.ok !== true || !Array.isArray(pack.rows)) {
        setStatus(pack && pack.error ? String(pack.error) : "Failed to load history");
        sessions = merged;
        selectedIdx = sessions.length ? 0 : -1;
        renderList();
        renderTranscript();
        return;
      }
      /** @type {Record<string, unknown>[]} */
      const rows = /** @type {*} */ (pack.rows);
      sessions = [...merged, ...splitSessions(rows, gapMs())];
      selectedIdx = sessions.length ? 0 : -1;
      renderList();
      renderTranscript();
      const impN = merged.length;
      const appSess = sessions.length - impN;
      setStatus(`${rows.length} app message(s); ${impN} imported chat(s); ${appSess} app session(s).`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  elGapMin?.addEventListener("change", () => {
    void reload();
  });

  document.getElementById("btn-hist-embed-session")?.addEventListener("click", async () => {
    if (selectedIdx < 0 || selectedIdx >= sessions.length) {
      setStatus("Select a session first.");
      return;
    }
    setStatus("Embedding session…");
    showHistProgress(true);
    const s = sessions[selectedIdx];
    try {
      if (!aa.embeddingIndexConversation) throw new Error("aaDesktop.embeddingIndexConversation missing");
      /** @type {*} */
      const r = await aa.embeddingIndexConversation({
        conversationId: s.id,
        sessionLabel: s.label,
        rows: s.rows,
      });
      if (!r || r.ok !== true) {
        setStatus(r && r.error ? String(r.error) : "Embed failed");
        return;
      }
      const errn = Array.isArray(r.errors) ? r.errors.length : 0;
      setStatus(`Indexed ${r.indexed ?? 0} embedding row(s).${errn ? ` Errors: ${errn}` : ""}`);
      if (errn && Array.isArray(r.errors)) {
        console.warn(r.errors);
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      showHistProgress(false);
    }
  });

  document.getElementById("btn-hist-embed-all")?.addEventListener("click", async () => {
    setStatus("Embedding full history…");
    showHistProgress(true);
    try {
      if (!aa.embeddingIndexConversation) throw new Error("aaDesktop.embeddingIndexConversation missing");
      /** @type {*} */
      const r = await aa.embeddingIndexConversation({
        conversationId: "full-history",
        sessionLabel: "Full transcript",
      });
      if (!r || r.ok !== true) {
        setStatus(r && r.error ? String(r.error) : "Embed failed");
        return;
      }
      const errn = Array.isArray(r.errors) ? r.errors.length : 0;
      setStatus(`Indexed ${r.indexed ?? 0} embedding row(s).${errn ? ` Errors: ${errn}` : ""}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      showHistProgress(false);
    }
  });

  document.getElementById("btn-hist-import-chatgpt")?.addEventListener("click", async () => {
    showHistProgress(true);
    try {
      if (!aa.embeddingImportChatgpt) throw new Error("aaDesktop.embeddingImportChatgpt missing");
      setStatus("Pick conversations.json from ChatGPT data export…");
      /** @type {{ ok?: boolean, error?: string, indexed?: number, conversations?: number, conversationsIndexed?: number, errors?: string[], sourceFiles?: number }} */
      const r = /** @type {*} */ (await aa.embeddingImportChatgpt());
      if (!r || r.ok !== true) {
        setStatus(r && r.error ? String(r.error) : "Import failed.");
        return;
      }
      const errn = Array.isArray(r.errors) ? r.errors.length : 0;
      const shards =
        typeof r.sourceFiles === "number" && r.sourceFiles > 1 ? ` (${r.sourceFiles} JSON files)` : "";
      setStatus(
        `ChatGPT import: ${r.conversationsIndexed ?? 0} conversation(s) indexed (${r.conversations ?? 0} in file), ${r.indexed ?? 0} embedding row(s).${shards}` +
          (errn ? ` ${errn} warning(s) — see console.` : ""),
      );
      if (errn && Array.isArray(r.errors)) console.warn(r.errors);
      void reload();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      showHistProgress(false);
    }
  });

  void reload();
})();
