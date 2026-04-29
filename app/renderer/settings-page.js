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
  const elLlProvider = document.getElementById("set-llm-provider");
  const elLlBase = document.getElementById("set-llm-base");
  const elLlModelSelect = document.getElementById("set-llm-model-select");
  const elLlModel = document.getElementById("set-llm-model");
  const elLlTemp = document.getElementById("set-llm-temp");
  const elLlTo = document.getElementById("set-llm-timeout");
  const elLlVision = document.getElementById("set-llm-vision");
  const elLogFile = document.getElementById("set-log-file");
  const elLogCon = document.getElementById("set-log-console");
  const elLogTools = document.getElementById("set-log-tools");
  const elAgentR = document.getElementById("set-agent-rounds");
  const elAgentL = document.getElementById("set-agent-label");
  const elAgentPrompt = document.getElementById("set-agent-prompt");
  const elAgentSystem = document.getElementById("set-agent-system");
  const elLlSecretWarn = document.getElementById("llm-secret-warning");
  const elBtnLlmFetchModels = document.getElementById("btn-llm-fetch-models");
  const elLlFetchModelsStatus = document.getElementById("llm-fetch-models-status");
  const elSecTavily = document.getElementById("sec-tavily");
  const elSecTel = document.getElementById("sec-telegram");
  const elSecOpen = document.getElementById("sec-openai");
  const elSecGroq = document.getElementById("sec-groq");
  const elSecCerebras = document.getElementById("sec-cerebras");
  const elSecAnthropic = document.getElementById("sec-anthropic");
  const elSecOpenrouter = document.getElementById("sec-openrouter");
  const elMasked = document.getElementById("sec-masked");
  const elSecretsPathInline = document.getElementById("path-secrets-inline");
  const elStatus = document.getElementById("settings-status");
  const elWhisperSize = document.getElementById("set-whisper-size");
  const elWhisperQuant = document.getElementById("set-whisper-quantized");
  const elWhisperMulti = document.getElementById("set-whisper-multilingual");
  const elAppClock = document.getElementById("app-clock-live");
  const elAppClockRegion = document.getElementById("app-clock-region");
  const elAppClockDevice = document.getElementById("app-clock-device");
  const elAppTzPreset = document.getElementById("app-tz-preset");
  const elAppTzCustomRow = document.getElementById("app-tz-custom-row");
  const elAppTzCustom = document.getElementById("app-tz-custom");
  const elAppRegionLabel = document.getElementById("app-region-label");
  const elChatTgMirror = document.getElementById("set-chat-tg-mirror");
  const elTgSchedChatId = document.getElementById("set-tg-scheduler-chat-id");

  /** @type {Record<string, unknown>} */
  let lastUserSnap = {};

  /** @type {Array<{ id: string, label: string, defaultBaseUrl: string, models: string[], defaultModel: string }>} */
  let cachedLlmProviders = [];

  /** Last successful GET /v1/models for `cachedApiModelsPid` — replaces static preset list until provider changes. */
  let cachedApiModels = /** @type {string[] | null} */ (null);
  let cachedApiModelsPid = "";

  /** @type {Record<string, boolean>} */
  let lastLlmAuthOk = {};

  function refreshLlmSecretWarning() {
    if (!(elLlSecretWarn instanceof HTMLElement)) return;
    if (!(elLlProvider instanceof HTMLSelectElement)) return;
    const pid = elLlProvider.value;
    const ok = lastLlmAuthOk[pid] !== false;
    if (ok) {
      elLlSecretWarn.hidden = true;
      elLlSecretWarn.textContent = "";
    } else {
      elLlSecretWarn.hidden = false;
      elLlSecretWarn.textContent =
        "No API token for this provider — open Secrets below and add the matching row (dedicated env name), or use OPENAI_API_KEY as fallback when listed.";
    }
  }

  /** @param {string} id */
  function llmPresetById(id) {
    return cachedLlmProviders.find((p) => p.id === id) ?? cachedLlmProviders[0];
  }

  /** @param {{ id?: string, models?: string[] }} preset @param {string} model */
  function syncLlmModelRow(preset, model) {
    const cur = typeof model === "string" ? model.trim() : "";
    const pid = elLlProvider instanceof HTMLSelectElement ? elLlProvider.value : "";
    let models = Array.isArray(preset.models) ? preset.models : [];
    if (
      cachedApiModels &&
      cachedApiModels.length &&
      pid &&
      preset.id === pid &&
      pid === cachedApiModelsPid
    ) {
      models = cachedApiModels;
    }
    if (!(elLlModelSelect instanceof HTMLSelectElement) || !(elLlModel instanceof HTMLInputElement)) {
      return;
    }
    const sel = elLlModelSelect;
    const inp = elLlModel;
    sel.innerHTML = "";
    if (models.length === 0) {
      sel.hidden = true;
      inp.value = cur;
      inp.style.display = "";
      return;
    }
    sel.hidden = false;
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
    const oOther = document.createElement("option");
    oOther.value = "__other__";
    oOther.textContent = "Other…";
    sel.appendChild(oOther);
    if (models.includes(cur)) {
      sel.value = cur;
      inp.style.display = "none";
      inp.value = cur;
    } else {
      sel.value = "__other__";
      inp.style.display = "";
      inp.value = cur;
    }
  }

  /** @param {unknown[]} providers */
  function rebuildLlmProviderSelect(providers) {
    cachedLlmProviders = [];
    for (const p of providers) {
      if (!p || typeof p !== "object") continue;
      const po = /** @type {{ id?: string, label?: string, defaultBaseUrl?: string, models?: unknown, defaultModel?: string }} */ (p);
      const id = typeof po.id === "string" ? po.id : "";
      if (!id) continue;
      const models = Array.isArray(po.models)
        ? po.models.filter((x) => typeof x === "string").map((x) => /** @type {string} */ (x))
        : [];
      cachedLlmProviders.push({
        id,
        label: typeof po.label === "string" ? po.label : id,
        defaultBaseUrl: typeof po.defaultBaseUrl === "string" ? po.defaultBaseUrl : "",
        models,
        defaultModel: typeof po.defaultModel === "string" ? po.defaultModel : "",
      });
    }
    if (!(elLlProvider instanceof HTMLSelectElement)) return;
    elLlProvider.innerHTML = "";
    for (const p of cachedLlmProviders) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.label;
      elLlProvider.appendChild(o);
    }
  }

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
    const provList = Array.isArray(snap.llmProviders) ? snap.llmProviders : [];
    rebuildLlmProviderSelect(provList);

    const uLlm =
      snap.user && typeof snap.user === "object"
        ? /** @type {{ llm?: { provider?: string } }} */ (snap.user).llm
        : null;
    const storedPid = uLlm && typeof uLlm.provider === "string" ? uLlm.provider.trim() : "";
    const pid =
      storedPid && cachedLlmProviders.some((p) => p.id === storedPid)
        ? storedPid
        : typeof r.llm.provider === "string"
          ? r.llm.provider
          : cachedLlmProviders[0]?.id ?? "lm_studio";
    if (elLlProvider instanceof HTMLSelectElement) {
      elLlProvider.value = pid;
    }
    elLlBase.value = r.llm.baseUrl;
    syncLlmModelRow(llmPresetById(pid), r.llm.model);
    elLlTemp.value = String(r.llm.temperature);
    elLlTo.value = String(r.llm.httpTimeoutMs);
    if (elLlVision instanceof HTMLInputElement) {
      elLlVision.checked = !!r.llm.vision;
    }
    elLogFile.checked = !!r.logging.logToFile;
    elLogCon.checked = !!r.logging.logToConsole;
    if (elLogTools instanceof HTMLInputElement) {
      elLogTools.checked = !!r.logging.logTools;
    }
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

    lastUserSnap =
      snap.user && typeof snap.user === "object" ? /** @type {Record<string, unknown>} */ (snap.user) : {};

    if (elChatTgMirror instanceof HTMLInputElement) {
      elChatTgMirror.checked = !!r.chat?.showTelegramMirror;
    }
    if (elTgSchedChatId instanceof HTMLInputElement) {
      const rtg = r.telegram && typeof r.telegram === "object" ? r.telegram : {};
      const d = /** @type {{ schedulerDefaultChatId?: number }} */ (rtg).schedulerDefaultChatId;
      elTgSchedChatId.value =
        typeof d === "number" && Number.isFinite(d) ? String(Math.floor(d)) : "";
    }

    const sizes = new Set(["tiny", "small", "base", "medium"]);
    const ws = typeof r.whisper?.modelSize === "string" && sizes.has(r.whisper.modelSize) ? r.whisper.modelSize : "base";
    if (elWhisperSize instanceof HTMLSelectElement) {
      elWhisperSize.value = ws;
    }
    if (elWhisperQuant instanceof HTMLInputElement) {
      elWhisperQuant.checked = !!r.whisper?.quantized;
    }
    if (elWhisperMulti instanceof HTMLInputElement) {
      elWhisperMulti.checked = !!r.whisper?.multilingual;
    }

    const presets = Array.isArray(snap.timeZonePresets) ? snap.timeZonePresets : [];
    const uSnap = snap.user && typeof snap.user === "object" ? snap.user : {};
    rebuildTimeZonePresetSelect(presets, uSnap, r);
    startAppClock();

    if (elSecTavily) elSecTavily.value = "";
    elSecTel.value = "";
    elSecOpen.value = "";
    if (elSecGroq instanceof HTMLInputElement) elSecGroq.value = "";
    if (elSecCerebras instanceof HTMLInputElement) elSecCerebras.value = "";
    if (elSecAnthropic instanceof HTMLInputElement) elSecAnthropic.value = "";
    if (elSecOpenrouter instanceof HTMLInputElement) elSecOpenrouter.value = "";

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
    setSecretBadge(
      document.getElementById("sec-badge-groq"),
      !!sec.hasGroq,
      sec.hasGroq ? "stored · " + (sec.masked.groq_api_key ?? "") : "not set",
    );
    setSecretBadge(
      document.getElementById("sec-badge-cerebras"),
      !!sec.hasCerebras,
      sec.hasCerebras ? "stored · " + (sec.masked.cerebras_api_key ?? "") : "not set",
    );
    setSecretBadge(
      document.getElementById("sec-badge-anthropic"),
      !!sec.hasAnthropic,
      sec.hasAnthropic ? "stored · " + (sec.masked.anthropic_api_key ?? "") : "not set",
    );
    setSecretBadge(
      document.getElementById("sec-badge-openrouter"),
      !!sec.hasOpenRouter,
      sec.hasOpenRouter ? "stored · " + (sec.masked.openrouter_api_key ?? "") : "not set",
    );
    lastLlmAuthOk =
      sec.llmProviderAuthOk && typeof sec.llmProviderAuthOk === "object" ? sec.llmProviderAuthOk : {};
    refreshLlmSecretWarning();
    if (elMasked) {
      elMasked.textContent =
        "Full secrets are never shown in this form; stored keys show last chars only (masked) next to each field.";
    }
  }

  document.getElementById("btn-settings-save").addEventListener("click", async () => {
    elStatus.textContent = "Saving…";
    await aa.settingsSave({
      llm: {
        ...(elLlProvider instanceof HTMLSelectElement
          ? { provider: elLlProvider.value.trim() }
          : {}),
        baseUrl: elLlBase.value.trim(),
        model: (function () {
          if (elLlModelSelect instanceof HTMLSelectElement && !elLlModelSelect.hidden) {
            const v = elLlModelSelect.value;
            if (v === "__other__" && elLlModel instanceof HTMLInputElement) {
              return elLlModel.value.trim();
            }
            return typeof v === "string" ? v.trim() : "";
          }
          return elLlModel instanceof HTMLInputElement ? elLlModel.value.trim() : "";
        })(),
        temperature: Number(elLlTemp.value),
        httpTimeoutMs: Number(elLlTo.value),
        ...(elLlVision instanceof HTMLInputElement ? { vision: elLlVision.checked } : {}),
      },
      logging: {
        logToFile: elLogFile.checked,
        logToConsole: elLogCon.checked,
        logTools: elLogTools instanceof HTMLInputElement ? elLogTools.checked : false,
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
      whisper: {
        modelSize: elWhisperSize instanceof HTMLSelectElement ? elWhisperSize.value : "base",
        quantized: elWhisperQuant instanceof HTMLInputElement ? elWhisperQuant.checked : true,
        multilingual: elWhisperMulti instanceof HTMLInputElement ? elWhisperMulti.checked : true,
      },
      telegram: (function () {
        const prev =
          lastUserSnap.telegram && typeof lastUserSnap.telegram === "object"
            ? { .../** @type {Record<string, unknown>} */ (lastUserSnap.telegram) }
            : {};
        const raw = elTgSchedChatId instanceof HTMLInputElement ? elTgSchedChatId.value.trim() : "";
        if (raw === "") {
          prev.schedulerDefaultChatId = null;
        } else {
          const n = parseInt(raw, 10);
          if (Number.isFinite(n)) {
            prev.schedulerDefaultChatId = n;
          }
        }
        return /** @type {Record<string, unknown>} */ (prev);
      })(),
      chat: {
        ...(lastUserSnap.chat && typeof lastUserSnap.chat === "object"
          ? { .../** @type {Record<string, unknown>} */ (lastUserSnap.chat) }
          : {}),
        showTelegramMirror: elChatTgMirror instanceof HTMLInputElement ? elChatTgMirror.checked : false,
      },
    });

    const pt = {};
    if (elSecTavily && elSecTavily.value.trim()) pt.tavily_api_key = elSecTavily.value.trim();
    if (elSecTel.value.trim()) pt.telegram_bot_token = elSecTel.value.trim();
    if (elSecOpen.value.trim()) pt.openai_api_key = elSecOpen.value.trim();
    if (elSecGroq instanceof HTMLInputElement && elSecGroq.value.trim()) pt.groq_api_key = elSecGroq.value.trim();
    if (elSecCerebras instanceof HTMLInputElement && elSecCerebras.value.trim()) {
      pt.cerebras_api_key = elSecCerebras.value.trim();
    }
    if (elSecAnthropic instanceof HTMLInputElement && elSecAnthropic.value.trim()) {
      pt.anthropic_api_key = elSecAnthropic.value.trim();
    }
    if (elSecOpenrouter instanceof HTMLInputElement && elSecOpenrouter.value.trim()) {
      pt.openrouter_api_key = elSecOpenrouter.value.trim();
    }
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

  document.getElementById("btn-clear-secrets-openai").addEventListener("click", async () => {
    elStatus.textContent = "Removing OpenAI key…";
    await aa.secretsSave({ openai_api_key: "" });
    await loadAll();
    elStatus.textContent = "Removed.";
  });

  document.getElementById("btn-clear-secrets-groq").addEventListener("click", async () => {
    elStatus.textContent = "Removing Groq key…";
    await aa.secretsSave({ groq_api_key: "" });
    await loadAll();
    elStatus.textContent = "Removed.";
  });

  document.getElementById("btn-clear-secrets-cerebras").addEventListener("click", async () => {
    elStatus.textContent = "Removing Cerebras key…";
    await aa.secretsSave({ cerebras_api_key: "" });
    await loadAll();
    elStatus.textContent = "Removed.";
  });

  document.getElementById("btn-clear-secrets-anthropic").addEventListener("click", async () => {
    elStatus.textContent = "Removing Anthropic key…";
    await aa.secretsSave({ anthropic_api_key: "" });
    await loadAll();
    elStatus.textContent = "Removed.";
  });

  document.getElementById("btn-clear-secrets-openrouter").addEventListener("click", async () => {
    elStatus.textContent = "Removing OpenRouter key…";
    await aa.secretsSave({ openrouter_api_key: "" });
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

  if (elLlProvider instanceof HTMLSelectElement) {
    elLlProvider.addEventListener("change", () => {
      cachedApiModels = null;
      cachedApiModelsPid = "";
      if (elLlFetchModelsStatus) elLlFetchModelsStatus.textContent = "";
      const preset = llmPresetById(elLlProvider.value);
      if (elLlBase instanceof HTMLInputElement) {
        elLlBase.value = preset.defaultBaseUrl || "";
      }
      syncLlmModelRow(preset, preset.defaultModel || "");
      refreshLlmSecretWarning();
    });
  }

  if (elBtnLlmFetchModels instanceof HTMLButtonElement && typeof aa.llmListModels === "function") {
    elBtnLlmFetchModels.addEventListener("click", async () => {
      if (!(elLlProvider instanceof HTMLSelectElement)) return;
      elBtnLlmFetchModels.disabled = true;
      if (elLlFetchModelsStatus) elLlFetchModelsStatus.textContent = "Fetching…";
      try {
        /** @type {{ ok?: boolean, ids?: string[], error?: string }} */
        const r = await aa.llmListModels();
        if (r && r.ok === true && Array.isArray(r.ids)) {
          cachedApiModels = r.ids.filter((x) => typeof x === "string" && x.length);
          cachedApiModelsPid = elLlProvider.value;
          const preset = llmPresetById(elLlProvider.value);
          const cur =
            elLlModel instanceof HTMLInputElement && elLlModel.value.trim().length
              ? elLlModel.value.trim()
              : preset.defaultModel || "";
          syncLlmModelRow(preset, cur);
          if (elLlFetchModelsStatus) {
            elLlFetchModelsStatus.textContent =
              cachedApiModels.length === 0
                ? "API returned no models."
                : `${cachedApiModels.length} id(s) loaded — pick one above.`;
          }
        } else {
          cachedApiModels = null;
          cachedApiModelsPid = "";
          const err = r && typeof r.error === "string" ? r.error : "failed";
          if (elLlFetchModelsStatus) elLlFetchModelsStatus.textContent = err;
        }
      } catch (e) {
        cachedApiModels = null;
        cachedApiModelsPid = "";
        const msg = e instanceof Error ? e.message : String(e);
        if (elLlFetchModelsStatus) elLlFetchModelsStatus.textContent = msg;
      } finally {
        elBtnLlmFetchModels.disabled = false;
      }
    });
  }

  if (elLlModelSelect instanceof HTMLSelectElement) {
    elLlModelSelect.addEventListener("change", () => {
      if (!(elLlModel instanceof HTMLInputElement)) return;
      const v = elLlModelSelect.value;
      if (v === "__other__") {
        elLlModel.style.display = "";
      } else {
        elLlModel.style.display = "none";
        elLlModel.value = v;
      }
    });
  }

  loadAll();
})();
