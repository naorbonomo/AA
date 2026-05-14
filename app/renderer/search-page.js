(function () {
  const aa = /** @type {Record<string, (...args: unknown[]) => unknown>} */ (window).aaDesktop;
  const elQ = document.getElementById("search-q");
  const elK = document.getElementById("search-k");
  const elEnhanced = document.getElementById("search-enhanced");
  const elAnswer = document.getElementById("search-answer");
  const elHits = document.getElementById("search-hits");
  const elStatus = document.getElementById("search-status");
  const elMeta = document.getElementById("search-meta");

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.getElementById("btn-search-run")?.addEventListener("click", async () => {
    const queryText = elQ instanceof HTMLTextAreaElement ? elQ.value.trim() : "";
    if (!queryText) {
      setStatus("Enter a query.");
      return;
    }
    let topK = 5;
    if (elK instanceof HTMLInputElement) {
      const n = Number.parseInt(elK.value.trim(), 10);
      if (Number.isFinite(n)) topK = n;
    }
    const enhanced = elEnhanced instanceof HTMLInputElement ? elEnhanced.checked : true;

    setStatus("Searching & calling LLM…");
    if (elAnswer) elAnswer.textContent = "";
    if (elHits) elHits.innerHTML = "";
    if (elMeta) elMeta.textContent = "";

    try {
      if (typeof aa.knowledgeSearchAnswer !== "function") {
        throw new Error("aaDesktop.knowledgeSearchAnswer missing");
      }
      /** @type {{ ok?: boolean, error?: string, answer?: string, contexts?: string[], queryVariations?: string[], searchMetadata?: Record<string, unknown> }} */
      const r = /** @type {*} */ (
        await aa.knowledgeSearchAnswer({ queryText, topK, enhanced })
      );
      if (!r || r.ok !== true) {
        setStatus(r && r.error ? String(r.error) : "Search failed");
        if (elMeta) elMeta.textContent = JSON.stringify(r ?? {}, null, 2);
        return;
      }

      if (elAnswer) elAnswer.textContent = typeof r.answer === "string" ? r.answer : "";

      const contexts = Array.isArray(r.contexts) ? r.contexts : [];
      if (elHits) {
        elHits.innerHTML = contexts
          .map(
            (c, i) =>
              `<article class="search-hit-card"><header class="search-hit-card__head">#${i + 1}</header><pre class="search-hit-card__body">${escapeHtml(c)}</pre></article>`,
          )
          .join("");
      }

      const meta = {
        queryVariations: r.queryVariations,
        searchMetadata: r.searchMetadata,
      };
      if (elMeta) elMeta.textContent = JSON.stringify(meta, null, 2);

      setStatus(`Done · ${contexts.length} excerpt(s).`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  });
})();
