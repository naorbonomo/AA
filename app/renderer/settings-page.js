(function () {
  const aa = window.aaDesktop;
  if (!aa) {
    document.body.innerHTML =
      '<p style="color:#fca5a5;padding:16px;font-family:system-ui">Preload failed — aaDesktop unavailable.</p>';
    return;
  }

  const elPath = document.getElementById("settings-path");
  const elPathUser = document.getElementById("path-user-settings");
  const elPathSecrets = document.getElementById("path-secrets");
  const elLlBase = document.getElementById("set-llm-base");
  const elLlModel = document.getElementById("set-llm-model");
  const elLlTemp = document.getElementById("set-llm-temp");
  const elLlTo = document.getElementById("set-llm-timeout");
  const elLogFile = document.getElementById("set-log-file");
  const elLogCon = document.getElementById("set-log-console");
  const elAgentR = document.getElementById("set-agent-rounds");
  const elAgentL = document.getElementById("set-agent-label");
  const elAgentPrompt = document.getElementById("set-agent-prompt");
  const elAgentSystem = document.getElementById("set-agent-system");
  const elSecTavily = document.getElementById("sec-tavily");
  const elSecTel = document.getElementById("sec-telegram");
  const elSecOpen = document.getElementById("sec-openai");
  const elMasked = document.getElementById("sec-masked");
  const elSecretsPathInline = document.getElementById("path-secrets-inline");
  const elStatus = document.getElementById("settings-status");
  const elAppClock = document.getElementById("app-clock-live");
  const elAppClockRegion = document.getElementById("app-clock-region");
  const elAppClockDevice = document.getElementById("app-clock-device");
  const elAppTzPreset = document.getElementById("app-tz-preset");
  const elAppTzCustomRow = document.getElementById("app-tz-custom-row");
  const elAppTzCustom = document.getElementById("app-tz-custom");
  const elAppRegionLabel = document.getElementById("app-region-label");

  /** @type {{ appTime: { timeZone: string, regionLabel: string, deviceTimeZone: string } } | null} */
  let lastResolvedSnap = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let clockTimer = null;

  function syncAppTzCustomRow() {
    if (!(elAppTzPreset instanceof HTMLSelectElement) || !elAppTzCustomRow) return;
    elAppTzCustomRow.hidden = elAppTzPreset.value !== "__custom__";
  }

  /** @param {unknown[]} presets @param {unknown} user @param {unknown} resolved */
  function rebuildTimeZonePresetSelect(presets, user, resolved) {
    if (!(elAppTzPreset instanceof HTMLSelectElement)) return;
    const sel = elAppTzPreset;
    sel.innerHTML = "";
    const optDev = document.createElement("option");
    optDev.value = "";
    const r0 =
      resolved && typeof resolved === "object"
        ? /** @type {{ appTime?: { deviceTimeZone?: string } }} */ (resolved).appTime
        : null;
    const devTz = r0 && typeof r0.deviceTimeZone === "string" ? r0.deviceTimeZone : "";
    optDev.textContent = "Device — " + (devTz || "…");
    sel.appendChild(optDev);

    const ids = new Set();
    for (const p of presets) {
      if (!p || typeof p !== "object") continue;
      const po = /** @type {{ id?: string, label?: string }} */ (p);
      const id = typeof po.id === "string" ? po.id : "";
      const label = typeof po.label === "string" ? po.label : id;
      if (!id || ids.has(id)) continue;
      ids.add(id);
      const o = document.createElement("option");
      o.value = id;
      o.textContent = label + " (" + id + ")";
      sel.appendChild(o);
    }
    const optC = document.createElement("option");
    optC.value = "__custom__";
    optC.textContent = "Custom IANA…";
    sel.appendChild(optC);

    const uat =
      user && typeof user === "object"
        ? /** @type {{ appTime?: { timeZone?: string, regionLabel?: string } }} */ (user).appTime
        : null;
    const stored = uat && typeof uat.timeZone === "string" ? uat.timeZone.trim() : "";
    if (!stored) {
      sel.value = "";
    } else if (ids.has(stored)) {
      sel.value = stored;
    } else {
      sel.value = "__custom__";
      if (elAppTzCustom instanceof HTMLInputElement) elAppTzCustom.value = stored;
    }
    const ur = uat && typeof uat.regionLabel === "string" ? uat.regionLabel : "";
    if (elAppRegionLabel instanceof HTMLInputElement) {
      elAppRegionLabel.value = ur;
    }
    syncAppTzCustomRow();
  }

  function updateAppClock() {
    if (!lastResolvedSnap || !lastResolvedSnap.appTime) return;
    const tz = lastResolvedSnap.appTime.timeZone;
    try {
      if (elAppClock) {
        elAppClock.textContent = new Intl.DateTimeFormat(undefined, {
          dateStyle: "full",
          timeStyle: "medium",
          timeZone: tz,
        }).format(new Date());
      }
      if (elAppClockRegion) {
        elAppClockRegion.textContent = lastResolvedSnap.appTime.regionLabel;
      }
      if (elAppClockDevice) {
        const d = lastResolvedSnap.appTime.deviceTimeZone;
        const same = d === tz;
        elAppClockDevice.textContent = same
          ? "Device timezone matches app clock."
          : "Device timezone: " + d + " (app clock uses " + tz + ").";
      }
    } catch (_) {}
  }

  function startAppClock() {
    if (clockTimer) clearInterval(clockTimer);
    updateAppClock();
    clockTimer = setInterval(updateAppClock, 1000);
  }

  /** @param {HTMLElement | null} el @param {boolean} has */
  function setSecretBadge(el, has, label) {
    if (!el) return;
    el.textContent = label;
    el.classList.toggle("secret-key-indicator--yes", has);
    el.classList.toggle("secret-key-indicator--no", !has);
    el.setAttribute("data-stored", has ? "true" : "false");
  }

  async function loadAll() {
    elStatus.textContent = "";
    let meta = { prompts: [] };
    try {
      if (typeof aa.promptsList === "function") {
        meta = await aa.promptsList();
      }
    } catch (_) {}
    const prompts = meta && Array.isArray(meta.prompts) ? meta.prompts : [];

    const snap = await aa.settingsGet();
    elPath.textContent = "Overrides: " + snap.filePath;
    elPathUser.textContent = snap.filePath;

    const r = snap.resolved;
    lastResolvedSnap = r;
    elLlBase.value = r.llm.baseUrl;
    elLlModel.value = r.llm.model;
    elLlTemp.value = String(r.llm.temperature);
    elLlTo.value = String(r.llm.httpTimeoutMs);
    elLogFile.checked = !!r.logging.logToFile;
    elLogCon.checked = !!r.logging.logToConsole;
    elAgentR.value = String(r.agent.maxToolRounds);
    elAgentL.value = r.agent.sessionLabel || "";
    if (elAgentPrompt instanceof HTMLSelectElement) {
      elAgentPrompt.innerHTML = "";
      const curPk = typeof r.agent.promptKey === "string" ? r.agent.promptKey : "";
      const keysSeen = {};
      for (const p of prompts) {
        if (!p || typeof p !== "object") continue;
        const k = typeof p.key === "string" ? p.key : "";
        if (!k || keysSeen[k]) continue;
        keysSeen[k] = true;
        const opt = document.createElement("option");
        opt.value = k;
        const desc = typeof p.description === "string" ? p.description : "";
        opt.textContent = desc ? k + " — " + desc : k;
        elAgentPrompt.appendChild(opt);
      }
      if (curPk && !keysSeen[curPk]) {
        const opt = document.createElement("option");
        opt.value = curPk;
        opt.textContent = curPk + " (stored)";
        elAgentPrompt.appendChild(opt);
      }
      elAgentPrompt.value = curPk || (elAgentPrompt.options[0] ? elAgentPrompt.options[0].value : "");
    }
    if (elAgentSystem instanceof HTMLTextAreaElement) {
      elAgentSystem.value = typeof r.agent.systemPrompt === "string" ? r.agent.systemPrompt : "";
    }

    const presets = Array.isArray(snap.timeZonePresets) ? snap.timeZonePresets : [];
    const uSnap = snap.user && typeof snap.user === "object" ? snap.user : {};
    rebuildTimeZonePresetSelect(presets, uSnap, r);
    startAppClock();

    if (elSecTavily) elSecTavily.value = "";
    elSecTel.value = "";
    elSecOpen.value = "";

    const sec = await aa.secretsGet();
    elPathSecrets.textContent = sec.filePath;
    if (elSecretsPathInline) {
      elSecretsPathInline.textContent = sec.filePath;
    }
    setSecretBadge(
      document.getElementById("sec-badge-tavily"),
      !!sec.hasTavily,
      sec.hasTavily ? "stored · " + sec.masked.tavily_api_key : "not set",
    );
    setSecretBadge(
      document.getElementById("sec-badge-telegram"),
      !!sec.hasTelegram,
      sec.hasTelegram ? "stored · " + sec.masked.telegram_bot_token : "not set",
    );
    setSecretBadge(
      document.getElementById("sec-badge-openai"),
      !!sec.hasOpenAi,
      sec.hasOpenAi ? "stored · " + sec.masked.openai_api_key : "not set",
    );
    if (elMasked) {
      elMasked.textContent =
        "Full secrets are never shown in this form; stored keys show last chars only (masked) next to each field.";
    }
  }

  document.getElementById("btn-settings-save").addEventListener("click", async () => {
    elStatus.textContent = "Saving…";
    await aa.settingsSave({
      llm: {
        baseUrl: elLlBase.value.trim(),
        model: elLlModel.value.trim(),
        temperature: Number(elLlTemp.value),
        httpTimeoutMs: Number(elLlTo.value),
      },
      logging: {
        logToFile: elLogFile.checked,
        logToConsole: elLogCon.checked,
      },
      agent: {
        maxToolRounds: Number(elAgentR.value),
        sessionLabel: elAgentL.value.trim(),
        ...(elAgentPrompt instanceof HTMLSelectElement
          ? { promptKey: elAgentPrompt.value.trim() }
          : {}),
        ...(elAgentSystem instanceof HTMLTextAreaElement
          ? { systemPrompt: elAgentSystem.value }
          : {}),
      },
      appTime: (function () {
        /** @type {{ timeZone: string, regionLabel: string }} */
        const o = { timeZone: "", regionLabel: "" };
        if (elAppTzPreset instanceof HTMLSelectElement) {
          const v = elAppTzPreset.value;
          if (v === "__custom__") {
            o.timeZone = elAppTzCustom instanceof HTMLInputElement ? elAppTzCustom.value.trim() : "";
          } else if (v !== "") {
            o.timeZone = v;
          }
        }
        if (elAppRegionLabel instanceof HTMLInputElement) {
          o.regionLabel = elAppRegionLabel.value.trim();
        }
        return o;
      })(),
    });

    const pt = {};
    if (elSecTavily && elSecTavily.value.trim()) pt.tavily_api_key = elSecTavily.value.trim();
    if (elSecTel.value.trim()) pt.telegram_bot_token = elSecTel.value.trim();
    if (elSecOpen.value.trim()) pt.openai_api_key = elSecOpen.value.trim();
    if (Object.keys(pt).length) {
      await aa.secretsSave(pt);
    }

    await loadAll();
    elStatus.textContent = "Saved.";
  });

  document.getElementById("btn-settings-reset").addEventListener("click", async () => {
    elStatus.textContent = "Resetting overrides…";
    await aa.settingsReset();
    await loadAll();
    elStatus.textContent = "Non-secret overrides cleared — defaults from config files apply.";
  });

  document.getElementById("btn-clear-secrets-tavily").addEventListener("click", async () => {
    elStatus.textContent = "Removing Tavily key…";
    await aa.secretsSave({ tavily_api_key: "" });
    await loadAll();
    elStatus.textContent = "Removed.";
  });

  document.getElementById("btn-clear-secrets-tg").addEventListener("click", async () => {
    elStatus.textContent = "Removing Telegram token…";
    await aa.secretsSave({ telegram_bot_token: "" });
    await loadAll();
    elStatus.textContent = "Removed.";
  });

  document.getElementById("btn-clear-secrets-key").addEventListener("click", async () => {
    elStatus.textContent = "Removing API key…";
    await aa.secretsSave({ openai_api_key: "" });
    await loadAll();
    elStatus.textContent = "Removed.";
  });

  document.getElementById("btn-settings-reload").addEventListener("click", async () => {
    elStatus.textContent = "Reloading…";
    await aa.settingsReload();
    await loadAll();
    elStatus.textContent = "Reloaded from disk.";
  });

  if (elAppTzPreset) {
    elAppTzPreset.addEventListener("change", () => {
      syncAppTzCustomRow();
    });
  }

  loadAll();
})();
