(() => {
  /** @type {typeof window.aaDesktop | undefined} */
  const aa = window.aaDesktop;
  const tbody = document.getElementById("mem-tbody");
  const statusEl = document.getElementById("mem-status");
  const btnRefresh = document.getElementById("mem-refresh");
  const btnWriteMd = document.getElementById("mem-write-md");
  const btnExportMd = document.getElementById("mem-export-md");
  const btnClear = document.getElementById("mem-clear");
  const btnHarvest = document.getElementById("mem-harvest");
  const btnHarvestStop = document.getElementById("mem-harvest-stop");
  const chkHarvestLive = document.getElementById("mem-harvest-live");
  /** @type {HTMLSelectElement | null} */
  const selHarvestConc = document.getElementById("mem-harvest-concurrency");
  const resumeHintEl = document.getElementById("mem-harvest-resume-hint");
  const mdPreviewCard = document.getElementById("mem-md-preview-card");
  const mdPreviewStatus = document.getElementById("mem-md-preview-status");
  const mdPreviewBody = document.getElementById("mem-md-preview-body");

  const RESUME_KEY = "aa-memory-harvest-resume-v1";

  const CATEGORIES = ["identity", "preference", "behavior", "goal", "relationship", "context"];

  let harvestRunning = false;
  let mdWriteBusy = false;
  let harvestCur = { step: 0, total: 0 };
  let factsReloadTimer = null;
  /** @type {string[]} */
  let mdChunkSlots = [];
  let mdChunkTotal = 0;
  /** @type {"idle"|"chunks"|"merge"|"done"} */
  let mdSynthPhase = "idle";

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function fmtTime(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
    try {
      return new Date(ms).toLocaleString();
    } catch (_) {
      return String(ms);
    }
  }

  /** @returns {{ includeLiveHistory: boolean; startPairIndex: number } | null} */
  function getStoredResume() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (typeof j.startPairIndex !== "number") return null;
      if (typeof j.includeLiveHistory !== "boolean") return null;
      const startPairIndex = Math.max(0, Math.floor(j.startPairIndex));
      return { includeLiveHistory: j.includeLiveHistory, startPairIndex };
    } catch (_) {
      return null;
    }
  }

  function setStoredResume(payload) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify(payload));
    } catch (_) {
      /* ignore */
    }
    renderResumeHint();
  }

  function clearStoredResume() {
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch (_) {
      /* ignore */
    }
    renderResumeHint();
  }

  /** @returns {number} start index compatible with checkbox or 0 */
  function startIndexForHarvest(includeLive) {
    const s = getStoredResume();
    if (!s || s.includeLiveHistory !== includeLive) return 0;
    return s.startPairIndex;
  }

  function renderResumeHint() {
    if (!(resumeHintEl instanceof HTMLElement)) return;
    const chk = chkHarvestLive instanceof HTMLInputElement ? chkHarvestLive : null;
    const wantLive = chk === null ? false : chk.checked;
    const pending = getStoredResume();
    if (!pending) {
      resumeHintEl.hidden = true;
      resumeHintEl.textContent = "";
      return;
    }
    resumeHintEl.hidden = false;
    const mode = pending.includeLiveHistory ? "imports + live" : "imports only";
    if (pending.includeLiveHistory !== wantLive) {
      resumeHintEl.textContent = `Paused checkpoint (${mode}, resume from pair index ${pending.startPairIndex}). Match “Include live” checkbox or start from 0.`;
      return;
    }
    resumeHintEl.textContent =
      pending.startPairIndex > 0
        ? `Next Harvest continues from pair index ${pending.startPairIndex} (${mode}).`
        : `Checkpoint at start (${mode}); next run begins from pair 0.`;
  }

  function scheduleFactsReload() {
    if (factsReloadTimer !== null) {
      window.clearTimeout(factsReloadTimer);
    }
    factsReloadTimer = window.setTimeout(() => {
      factsReloadTimer = null;
      void reload({ duringHarvest: harvestRunning });
    }, 450);
  }

  /** Harvest + markdown export mutually exclude (same LLM). */
  function syncMemoryLlmutex() {
    const lock = harvestRunning || mdWriteBusy;
    if (btnHarvest instanceof HTMLButtonElement) btnHarvest.disabled = lock;
    if (btnHarvestStop instanceof HTMLButtonElement) btnHarvestStop.disabled = !harvestRunning;
    if (chkHarvestLive instanceof HTMLInputElement) chkHarvestLive.disabled = harvestRunning;
    if (selHarvestConc instanceof HTMLSelectElement) selHarvestConc.disabled = harvestRunning;
    if (btnWriteMd instanceof HTMLButtonElement) btnWriteMd.disabled = lock;
  }

  function setHarvestBusy(isBusy) {
    harvestRunning = isBusy;
    syncMemoryLlmutex();
  }

  function setMdWriteBusy(b) {
    mdWriteBusy = b;
    syncMemoryLlmutex();
  }

  /** @param {unknown[]} slots @param {number} total */
  function draftMarkdownFromChunkSlots(slots, total) {
    let done = 0;
    const parts = [];
    for (let i = 0; i < total; i += 1) {
      const f = slots[i];
      if (typeof f === "string" && f.length) done += 1;
      parts.push(`### Draft fragment ${i + 1} / ${total}\n\n${typeof f === "string" && f.length ? f : "…"}`);
    }
    return `# User memory (draft — ${done} / ${total} fact batches)\n\n${parts.join("\n\n---\n\n")}`;
  }

  /** @param {unknown} p */
  function handleMemoryWriteProgress(p) {
    if (!p || typeof p !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (p);
    const phase = typeof o.phase === "string" ? o.phase : "";
    if (phase === "start") {
      mdSynthPhase = "chunks";
      const c = o.chunkCount;
      mdChunkTotal = typeof c === "number" && c > 0 ? Math.floor(c) : 1;
      mdChunkSlots = new Array(mdChunkTotal);
      if (mdPreviewCard instanceof HTMLElement) mdPreviewCard.hidden = false;
      if (mdPreviewStatus) mdPreviewStatus.textContent = `${o.factCount ?? "?"} facts → ${mdChunkTotal} LLM batch(es)…`;
      if (mdPreviewBody) mdPreviewBody.textContent = "…";
      return;
    }
    if (phase === "chunk_done") {
      const ix = o.index;
      const tot = o.total;
      const frag = o.fragment;
      if (typeof tot === "number" && tot > 0) mdChunkTotal = Math.floor(tot);
      if (!Array.isArray(mdChunkSlots) || mdChunkSlots.length !== mdChunkTotal) {
        mdChunkSlots = new Array(mdChunkTotal);
      }
      if (typeof ix === "number" && ix >= 0 && ix < mdChunkTotal && typeof frag === "string") {
        mdChunkSlots[ix] = frag;
      }
      if (mdSynthPhase === "chunks" && mdPreviewBody) {
        mdPreviewBody.textContent = draftMarkdownFromChunkSlots(mdChunkSlots, mdChunkTotal);
        let done = 0;
        for (let i = 0; i < mdChunkTotal; i += 1) {
          if (typeof mdChunkSlots[i] === "string" && mdChunkSlots[i].length) done += 1;
        }
        if (mdPreviewStatus)
          mdPreviewStatus.textContent =
            mdChunkTotal > 1
              ? `Chunk LLM: ${done} / ${mdChunkTotal} — then merge`
              : `Single batch — finalizing`;
      }
      return;
    }
    if (phase === "merge_round") {
      mdSynthPhase = "merge";
      const r = o.round;
      const rem = o.partsRemaining;
      const md = o.previewMarkdown;
      if (mdPreviewStatus) {
        const bits = [];
        if (typeof r === "number") bits.push(`merge round ${r}`);
        if (typeof rem === "number") bits.push(`${rem} part(s) left`);
        mdPreviewStatus.textContent = bits.length ? bits.join(" · ") : "Merging…";
      }
      if (mdPreviewBody && typeof md === "string") mdPreviewBody.textContent = md;
      return;
    }
    if (phase === "complete") {
      mdSynthPhase = "done";
      const md = o.markdown;
      if (mdPreviewBody && typeof md === "string") mdPreviewBody.textContent = md;
      if (mdPreviewStatus) mdPreviewStatus.textContent = "Final body (HTML comment header added on disk).";
    }
  }

  function renderFacts(facts) {
    if (!tbody) return;
    tbody.replaceChildren();
    if (!facts.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = harvestRunning ? "(no facts rows yet)" : "No facts stored.";
      td.className = "memory-empty";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const f of facts) {
      const tr = document.createElement("tr");
      tr.dataset.id = String(f.id);

      const tdKey = document.createElement("td");
      const inpKey = document.createElement("input");
      inpKey.type = "text";
      inpKey.value = f.key;
      inpKey.spellcheck = false;
      inpKey.autocomplete = "off";
      tdKey.appendChild(inpKey);

      const tdVal = document.createElement("td");
      const taVal = document.createElement("textarea");
      taVal.rows = 2;
      taVal.value = f.value;
      tdVal.appendChild(taVal);

      const tdConf = document.createElement("td");
      const inpConf = document.createElement("input");
      inpConf.type = "number";
      inpConf.min = "0";
      inpConf.max = "1";
      inpConf.step = "0.05";
      inpConf.value = String(f.confidence);
      tdConf.appendChild(inpConf);

      const tdCat = document.createElement("td");
      const sel = document.createElement("select");
      for (const c of CATEGORIES) {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        if (c === f.category) opt.selected = true;
        sel.appendChild(opt);
      }
      tdCat.appendChild(sel);

      const tdUp = document.createElement("td");
      tdUp.textContent = fmtTime(f.updated_at_ms);
      tdUp.className = "memory-ts";

      const tdSrc = document.createElement("td");
      tdSrc.textContent = f.source_turn_id.length > 48 ? `${f.source_turn_id.slice(0, 48)}…` : f.source_turn_id;
      tdSrc.title = f.source_turn_id;

      const tdAct = document.createElement("td");
      tdAct.className = "memory-actions-cell";
      const btnApply = document.createElement("button");
      btnApply.type = "button";
      btnApply.textContent = "Save row";
      btnApply.addEventListener("click", async () => {
        if (!aa || typeof aa.memoryPatchFact !== "function") return;
        const id = Number(tr.dataset.id);
        const patch = {
          id,
          key: inpKey.value,
          value: taVal.value,
          confidence: Number(inpConf.value),
          category: sel.value,
        };
        setStatus("Saving…");
        try {
          const r = /** @type {{ ok?: boolean, error?: string }} */ (await aa.memoryPatchFact(patch));
          if (!r || r.ok !== true) {
            setStatus(r && r.error ? r.error : "Save failed");
            return;
          }
          await reload({});
          setStatus("Saved.");
        } catch (e) {
          setStatus(e instanceof Error ? e.message : String(e));
        }
      });
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.textContent = "Delete";
      btnDel.className = "danger";
      btnDel.addEventListener("click", async () => {
        if (!aa || typeof aa.memoryDeleteFact !== "function") return;
        const id = Number(tr.dataset.id);
        setStatus("Deleting…");
        try {
          const r = /** @type {{ ok?: boolean, error?: string }} */ (await aa.memoryDeleteFact(id));
          if (!r || r.ok !== true) {
            setStatus(r && r.error ? r.error : "Delete failed");
            return;
          }
          await reload({});
          setStatus("Deleted.");
        } catch (e) {
          setStatus(e instanceof Error ? e.message : String(e));
        }
      });
      tdAct.appendChild(btnApply);
      tdAct.appendChild(btnDel);

      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      tr.appendChild(tdConf);
      tr.appendChild(tdCat);
      tr.appendChild(tdUp);
      tr.appendChild(tdSrc);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
  }

  async function reload(opts) {
    const duringHarvest = opts && opts.duringHarvest === true;
    if (!aa || typeof aa.memoryListFacts !== "function") {
      setStatus("aaDesktop.memoryListFacts missing — rebuild preload/main.");
      return;
    }
    if (!duringHarvest) setStatus("Loading…");
    try {
      const pack = /** @type {{ ok?: boolean, facts?: unknown[], error?: string }} */ (
        await aa.memoryListFacts()
      );
      if (!pack || pack.ok !== true || !Array.isArray(pack.facts)) {
        setStatus(pack && pack.error ? pack.error : "Failed to load facts");
        renderFacts([]);
        return;
      }
      renderFacts(pack.facts);
      const n = pack.facts.length;
      if (harvestRunning) {
        const { step, total } = harvestCur;
        setStatus(`Harvest: ${step}/${total} · ${n} fact row(s) in DB (many exchanges yield zero new facts)`);
      } else if (!duringHarvest) {
        setStatus(`${n} fact(s).`);
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      renderFacts([]);
    }
  }

  if (!aa) {
    setStatus("Preload failed — aaDesktop unavailable.");
  } else {
    chkHarvestLive?.addEventListener("change", () => renderResumeHint());
    btnRefresh?.addEventListener("click", () => void reload({}));

    btnWriteMd?.addEventListener("click", async () => {
      if (!aa || typeof aa.memoryWriteMd !== "function") return;
      if (harvestRunning) {
        setStatus("Wait for harvest to finish.");
        return;
      }
      setMdWriteBusy(true);
      setStatus("Writing memory.md via LLM…");
      mdSynthPhase = "idle";
      mdChunkSlots = [];
      mdChunkTotal = 0;
      if (mdPreviewCard instanceof HTMLElement) mdPreviewCard.hidden = true;
      if (mdPreviewStatus) mdPreviewStatus.textContent = "";
      if (mdPreviewBody) mdPreviewBody.textContent = "";
      /** @type {() => void} */
      let unsub = () => {};
      if (typeof aa.onMemoryWriteMdProgress === "function") {
        unsub = aa.onMemoryWriteMdProgress(handleMemoryWriteProgress);
      }
      try {
        const r = /** @type {{ ok?: boolean, path?: string, factCount?: number, error?: string }} */ (
          await aa.memoryWriteMd()
        );
        if (!r || r.ok !== true) {
          setStatus(r && r.error ? r.error : "memory.md write failed");
          return;
        }
        setStatus(
          `Wrote memory.md (${r.factCount ?? "?"} facts) · ${typeof r.path === "string" ? r.path : "?"}`,
        );
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        unsub();
        setMdWriteBusy(false);
      }
    });

    btnExportMd?.addEventListener("click", async () => {
      if (!aa || typeof aa.memoryExportMdAs !== "function") return;
      setStatus("Choose where to save…");
      try {
        const r = /** @type {{ ok?: boolean, canceled?: boolean, path?: string, error?: string }} */ (
          await aa.memoryExportMdAs()
        );
        if (!r || r.ok !== true) {
          setStatus(r && r.error ? r.error : "Export failed");
          return;
        }
        if (r.canceled === true) {
          setStatus("Export canceled.");
          return;
        }
        setStatus(typeof r.path === "string" ? `Exported to ${r.path}` : "Exported.");
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    });

    btnClear?.addEventListener("click", async () => {
      if (!confirm("Delete all stored user facts?")) return;
      if (typeof aa.memoryClearAll !== "function") return;
      setStatus("Clearing…");
      try {
        const r = /** @type {{ ok?: boolean, error?: string }} */ (await aa.memoryClearAll());
        if (!r || r.ok !== true) {
          setStatus(r && r.error ? r.error : "Clear failed");
          return;
        }
        await reload({});
        clearStoredResume();
        setStatus("All facts cleared.");
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
    });

    btnHarvestStop?.addEventListener("click", async () => {
      if (!aa || typeof aa.memoryHarvestStop !== "function") return;
      try {
        await aa.memoryHarvestStop();
        setStatus("Stop requested — waits for in-flight calls, then pauses.");
      } catch (_) {
        /* ignore */
      }
    });

    btnHarvest?.addEventListener("click", async () => {
      if (typeof aa.memoryHarvest !== "function") return;
      const includeLive = chkHarvestLive instanceof HTMLInputElement && chkHarvestLive.checked === true;
      const startPairIndex = startIndexForHarvest(includeLive);
      let maxConcurrency = 4;
      if (selHarvestConc instanceof HTMLSelectElement) {
        const n = Number(selHarvestConc.value);
        if (Number.isFinite(n)) maxConcurrency = Math.min(32, Math.max(1, Math.floor(n)));
      }

      /** @type {(() => void) | null} */
      let unsub = null;
      if (typeof aa.onMemoryHarvestProgress === "function") {
        unsub = aa.onMemoryHarvestProgress((p) => {
          if (p && typeof p === "object") {
            const step = typeof p.step === "number" ? p.step : 0;
            const total = typeof p.total === "number" ? p.total : 0;
            harvestCur = { step, total };
            setStatus(`Harvest: ${step}/${total} …`);
            if (p.factsTick === true) {
              scheduleFactsReload();
            }
          }
        });
      }

      setHarvestBusy(true);
      harvestCur = { step: startPairIndex, total: 0 };
      setStatus(startPairIndex > 0 ? `Harvest resuming from pair ${startPairIndex}…` : `Harvest starting…`);

      try {
        const r = /** @type {{ ok?: boolean, pairsTotal?: number, pairsProcessed?: number, aborted?: boolean, nextPairIndex?: number, error?: string }} */ (
          await aa.memoryHarvest({
            includeLiveHistory: includeLive,
            startPairIndex,
            maxConcurrency,
          })
        );
        if (typeof unsub === "function") unsub();

        if (!r || r.ok !== true) {
          setStatus(r && r.error ? r.error : "Harvest failed");
          return;
        }

        harvestCur = { step: r.pairsTotal ?? 0, total: r.pairsTotal ?? 0 };

        if (r.aborted === true && typeof r.nextPairIndex === "number") {
          setStoredResume({ includeLiveHistory: includeLive, startPairIndex: r.nextPairIndex });
          await reload({});
          setStatus(`Paused · next index ${r.nextPairIndex}/${r.pairsTotal ?? "?"} (${r.pairsProcessed ?? "?"} pairs done this run)`);
        } else {
          clearStoredResume();
          await reload({});
          setStatus(`Harvest done · processed ${r.pairsProcessed ?? 0}/${r.pairsTotal ?? 0} nonempty pair(s).`);
        }
      } catch (e) {
        if (typeof unsub === "function") unsub();
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setHarvestBusy(false);
      }
    });

    renderResumeHint();
    syncMemoryLlmutex();
    void reload({});
  }
})();
