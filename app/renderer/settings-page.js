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
  const elSecTavily = document.getElementById("sec-tavily");
  const elSecTel = document.getElementById("sec-telegram");
  const elSecOpen = document.getElementById("sec-openai");
  const elMasked = document.getElementById("sec-masked");
  const elSecretsPathInline = document.getElementById("path-secrets-inline");
  const elStatus = document.getElementById("settings-status");

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
    const snap = await aa.settingsGet();
    elPath.textContent = "Overrides: " + snap.filePath;
    elPathUser.textContent = snap.filePath;

    const r = snap.resolved;
    elLlBase.value = r.llm.baseUrl;
    elLlModel.value = r.llm.model;
    elLlTemp.value = String(r.llm.temperature);
    elLlTo.value = String(r.llm.httpTimeoutMs);
    elLogFile.checked = !!r.logging.logToFile;
    elLogCon.checked = !!r.logging.logToConsole;
    elAgentR.value = String(r.agent.maxToolRounds);
    elAgentL.value = r.agent.sessionLabel || "";

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
      },
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

  loadAll();
})();
