(function () {
  const aa = /** @type {Record<string, (...args: unknown[]) => unknown>} */ (window).aaDesktop;
  const elStatus = document.getElementById("emb-status");
  const elResults = document.getElementById("emb-results");
  const elProgWrap = document.getElementById("emb-progress-wrap");
  const elProg = document.getElementById("emb-progress");
  const elProgLab = document.getElementById("emb-progress-label");
  const elCid = document.getElementById("emb-dev-cid");
  const elText = document.getElementById("emb-dev-text");
  const elImgPath = document.getElementById("emb-dev-img-path");
  const elSearchQ = document.getElementById("emb-search-q");
  const elSearchImg = document.getElementById("emb-search-img");
  const elSearchK = document.getElementById("emb-search-k");

  function showEmbProgress(visible) {
    if (elProgWrap) elProgWrap.hidden = !visible;
  }

  /**
   * @param {unknown} p
   */
  function formatEmbProgress(p) {
    if (!p || typeof p !== "object") return "";
    const o = /** @type {{ phase?: string; step?: number; total?: number; label?: string }} */ (p);
    const phaseLab =
      o.phase === "dev_index" ? "Index" : typeof o.phase === "string" ? o.phase : "";
    const step = typeof o.step === "number" ? o.step : 0;
    const total = typeof o.total === "number" ? o.total : 1;
    const lab = typeof o.label === "string" ? o.label : "";
    return [phaseLab, `${Math.min(step, total)}/${total}`, lab].filter(Boolean).join(" · ");
  }

  /**
   * @param {unknown} p
   */
  function applyEmbProgress(p) {
    if (!elProg || !elProgLab) return;
    showEmbProgress(true);
    const o = p && typeof p === "object" ? /** @type {{ step?: number; total?: number }} */ (p) : {};
    const total = typeof o.total === "number" && o.total > 0 ? o.total : 1;
    const step = typeof o.step === "number" ? o.step : 0;
    elProg.max = total;
    elProg.value = Math.min(step, total);
    elProgLab.textContent = formatEmbProgress(p);
  }

  if (typeof aa.onEmbeddingIndexProgress === "function") {
    aa.onEmbeddingIndexProgress((p) => applyEmbProgress(p));
  }

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg;
  }

  function showResults(obj) {
    if (elResults) elResults.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  }

  document.getElementById("btn-emb-index")?.addEventListener("click", async () => {
    setStatus("Indexing…");
    showResults("");
    showEmbProgress(true);
    try {
      if (!aa.embeddingIndexDev) throw new Error("aaDesktop.embeddingIndexDev missing");
      const cid = elCid instanceof HTMLInputElement ? elCid.value.trim() : "dev-playground";
      const text = elText instanceof HTMLTextAreaElement ? elText.value : "";
      const imagePathRaw = elImgPath instanceof HTMLInputElement ? elImgPath.value.trim() : "";
      const imagePath = imagePathRaw.length ? imagePathRaw : undefined;
      /** @type {{ ok?: boolean, indexed?: number, error?: string }} */
      const r = /** @type {*} */ (
        await aa.embeddingIndexDev({
          conversationId: cid || "dev-playground",
          text,
          imagePath,
        })
      );
      if (!r || r.ok !== true) {
        setStatus(r && r.error ? String(r.error) : "Index failed");
        showResults(r ?? {});
        return;
      }
      setStatus(`Indexed ${r.indexed ?? 0} row(s).`);
      showResults(r);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      showEmbProgress(false);
    }
  });

  document.getElementById("btn-emb-search")?.addEventListener("click", async () => {
    setStatus("Searching…");
    showResults("");
    try {
      if (!aa.embeddingSearch) throw new Error("aaDesktop.embeddingSearch missing");
      const queryText = elSearchQ instanceof HTMLTextAreaElement ? elSearchQ.value : "";
      const imagePathRaw = elSearchImg instanceof HTMLInputElement ? elSearchImg.value.trim() : "";
      const imagePath = imagePathRaw.length ? imagePathRaw : undefined;
      let topK = 8;
      if (elSearchK instanceof HTMLInputElement) {
        const n = Number.parseInt(elSearchK.value.trim(), 10);
        if (Number.isFinite(n)) topK = n;
      }
      /** @type {{ ok?: boolean, hits?: unknown[], error?: string }} */
      const r = /** @type {*} */ (await aa.embeddingSearch({ queryText, imagePath, topK }));
      if (!r || r.ok !== true) {
        setStatus(r && r.error ? String(r.error) : "Search failed");
        showResults(r ?? {});
        return;
      }
      const hits = Array.isArray(r.hits) ? r.hits : [];
      setStatus(`${hits.length} hit(s).`);
      showResults(r);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  });

  document.getElementById("btn-emb-list")?.addEventListener("click", async () => {
    setStatus("Listing…");
    try {
      if (!aa.embeddingList) throw new Error("aaDesktop.embeddingList missing");
      /** @type {{ ok?: boolean, rows?: unknown[], error?: string }} */
      const r = /** @type {*} */ (await aa.embeddingList({ limit: 50 }));
      if (!r || r.ok !== true) {
        setStatus(r && r.error ? String(r.error) : "List failed");
        showResults(r ?? {});
        return;
      }
      setStatus(`${(r.rows && r.rows.length) || 0} row(s).`);
      showResults(r.rows ?? []);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  });
})();
