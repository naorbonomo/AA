(function () {
  /** @typedef {{ ok: boolean, text?: string, error?: string }} ChatIPCResult */
  /** @typedef {{ wallMs: number, total_tokens: number|null, prompt_tokens: number|null, completion_tokens: number|null, reasoning_tokens?: number, msPerToken: number|null, system_fingerprint?: string }} UsageMeta */
  /** @typedef {{ role: string, content: string, reasoning?: string, usageMeta?: UsageMeta, agentTrace?: string }} Row */

  const aa = window.aaDesktop;
  if (!aa) {
    document.body.innerHTML =
      '<p style="color:#fca5a5;padding:1.2vmin;font-family:system-ui">Preload failed — aaDesktop unavailable.</p>';
    return;
  }

  /** @type {Row[]} */
  const history = [];

  const elMsgs = document.getElementById("messages");
  const elForm = document.getElementById("compose");
  const elInput = document.getElementById("input");
  const elSend = document.getElementById("btn-send");

  const THINK_TIER_KEY = "aa.thinkingPanelTier";

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
      if (total !== null && total > 0) msPerToken = wallMs / total;
      else if (completion !== null && completion > 0) msPerToken = wallMs / completion;
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

  /** @param {UsageMeta} meta */
  function usageFooterEl(meta) {
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
    if (meta.msPerToken !== null && Number.isFinite(meta.msPerToken)) {
      parts.push(meta.msPerToken.toFixed(2) + " ms/tok");
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
    return history.map((m) => {
      /** @type {Record<string, unknown>} */
      const o = { role: m.role, content: m.content };
      if (typeof m.reasoning === "string" && m.reasoning.length) o.reasoning = m.reasoning;
      if (typeof m.agentTrace === "string" && m.agentTrace.length) o.agentTrace = m.agentTrace;
      if (m.usageMeta && typeof m.usageMeta === "object") o.usageMeta = m.usageMeta;
      return o;
    });
  }

  function persistHistory() {
    if (typeof aa.chatHistorySave !== "function") return;
    void aa.chatHistorySave(rowsForPersist()).catch(() => {});
  }

  /** @param {unknown} r */
  function normalizeHistoryRow(r) {
    if (!r || typeof r !== "object") return null;
    const o = /** @type {Record<string, unknown>} */ (r);
    const role = typeof o.role === "string" ? o.role.trim().toLowerCase() : "";
    if (role !== "user" && role !== "assistant" && role !== "system") return null;
    /** @type {typeof history[number]} */
    const row = { role, content: typeof o.content === "string" ? o.content : "" };
    if (typeof o.reasoning === "string" && o.reasoning.length) row.reasoning = o.reasoning;
    if (typeof o.agentTrace === "string" && o.agentTrace.length) row.agentTrace = o.agentTrace;
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
    return row;
  }

  function render() {
    if (!history.length) {
      elMsgs.innerHTML = '<div class="empty">Send a message to talk to the local model.</div>';
      persistHistory();
      return;
    }
    elMsgs.innerHTML = "";
    for (const m of history) {
      elMsgs.appendChild(msgElFromRow(m));
    }
    scrollMsgsToBottom();
    persistHistory();
  }

  function msgElFromRow(m) {
    const r = (m.role || "user").toLowerCase();
    const div = document.createElement("div");
    div.className = "msg role-" + r;
    const head = '<div class="role-h">' + esc(r) + "</div>";
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
    } else {
      div.innerHTML = head + '<div class="body">' + esc(m.content) + "</div>";
    }
    if (r === "assistant" && m.agentTrace) {
      const tr = document.createElement("div");
      tr.className = "agent-tool-trace";
      tr.textContent = m.agentTrace;
      div.appendChild(tr);
    }
    if (r === "assistant" && m.usageMeta) {
      div.appendChild(usageFooterEl(m.usageMeta));
    }
    return div;
  }

  /** Pending agent turn — same layout as streamed thinking + answer (not plain "Working…"). */
  function pendingAssistAgent() {
    const tr = getThinkTier();
    const lbl = tr === 1 ? "thinking …" : "thinking";
    const wrap = document.createElement("div");
    wrap.className = "msg role-assistant pending";
    wrap.innerHTML =
      '<div class="role-h">assistant</div>' +
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

  /** @param {unknown} steps */
  function formatAgentSteps(steps) {
    if (!Array.isArray(steps)) return "";
    const bits = [];
    for (const s of steps) {
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
    return bits.join(" · ");
  }

  async function onSend() {
    const text = elInput.value.trim();
    if (!text) return;

    elInput.value = "";
    history.push({ role: "user", content: text });
    render();

    const pend = pendingAssistAgent();
    elMsgs.appendChild(pend.el);
    scrollMsgsToBottom();
    elSend.disabled = true;

    const payloads = history.map((h) => ({
      role: h.role === "assistant" ? "assistant" : h.role === "system" ? "system" : "user",
      content: h.content,
    }));

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
        content: res.text || "",
        ...(streamedReasoningAcc.trim() ? { reasoning: streamedReasoningAcc } : {}),
        ...(trace ? { agentTrace: trace } : {}),
        ...(usageMeta ? { usageMeta } : {}),
      });

      render();
    } catch (err) {
      pend.remove();
      const errText = err instanceof Error ? err.message : String(err);
      elMsgs.appendChild(msgElFromRow({ role: "assistant", content: errText }));
      scrollMsgsToBottom();
    }

    elSend.disabled = false;
    elInput.focus();
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
      onSend();
    }
  });

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
    render();
    syncThinkPanelsToTier(getThinkTier());
    elInput.focus();
  })();
})();
