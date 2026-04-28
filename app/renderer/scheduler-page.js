(function () {
  const aa = window.aaDesktop;
  if (!aa) {
    document.body.innerHTML =
      '<p style="color:#fca5a5;padding:16px;font-family:system-ui">Preload failed — aaDesktop unavailable.</p>';
    return;
  }

  const elStatus = document.getElementById("scheduler-status");
  const elSchedList = document.getElementById("scheduler-list");
  const elSchedPath = document.getElementById("scheduler-path-hint");
  const elSchedNotifyHint = document.getElementById("scheduler-notify-hint");
  const elAppClockHint = document.getElementById("scheduler-app-clock-hint");
  const elSchedTitle = document.getElementById("sched-title");
  const elSchedPrompt = document.getElementById("sched-prompt");
  const elSchedKind = document.getElementById("sched-kind");
  const elSchedInterval = document.getElementById("sched-interval");
  const elSchedOnce = document.getElementById("sched-once");
  const elSchedNotify = document.getElementById("sched-notify");
  const elSchedRowOnce = document.getElementById("sched-row-once");
  const elSchedRowInterval = document.getElementById("sched-row-interval");

  /** @type {{ appTime: { timeZone: string, regionLabel: string, deviceTimeZone: string } } | null} */
  let lastResolvedSnap = null;

  function syncSchedKindRows() {
    const once = elSchedKind && elSchedKind.value === "once";
    if (elSchedRowOnce) elSchedRowOnce.hidden = !once;
    if (elSchedRowInterval) elSchedRowInterval.hidden = !!once;
  }

  /** @param {number} ms @param {string} tz */
  function formatInstantInZone(ms, tz) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: tz || "UTC",
      }).format(new Date(ms));
    } catch (_) {
      return String(ms);
    }
  }

  function updateAppClockHint() {
    if (!elAppClockHint) return;
    if (!lastResolvedSnap || !lastResolvedSnap.appTime) {
      elAppClockHint.textContent = "";
      return;
    }
    const a = lastResolvedSnap.appTime;
    elAppClockHint.textContent =
      "App clock: " + a.regionLabel + " (" + a.timeZone + ") · device: " + a.deviceTimeZone;
  }

  /** @param {unknown} j */
  function formatScheduleLine(j) {
    if (!j || typeof j !== "object") return "";
    const o = /** @type {Record<string, unknown>} */ (j);
    const sch = o.schedule && typeof o.schedule === "object" ? /** @type {Record<string, unknown>} */ (o.schedule) : null;
    if (!sch) return "";
    if (sch.kind === "once" && typeof sch.runAtIso === "string") {
      const ms = Date.parse(sch.runAtIso);
      const tz = lastResolvedSnap && lastResolvedSnap.appTime ? lastResolvedSnap.appTime.timeZone : "UTC";
      let t = sch.runAtIso;
      if (Number.isFinite(ms)) {
        t = formatInstantInZone(ms, tz);
      }
      return "Once · " + t + " (app clock)";
    }
    const n = Number(sch.intervalMinutes);
    const mins = Number.isFinite(n) ? n : "?";
    return "Every " + mins + " min";
  }

  /** @param {unknown[]} jobs */
  function renderSchedulerList(jobs) {
    if (!elSchedList) return;
    elSchedList.innerHTML = "";
    if (!jobs.length) {
      const p = document.createElement("p");
      p.className = "settings-card__meta";
      p.textContent = "No scheduled jobs yet. Add one below or use schedule_job from Chat.";
      elSchedList.appendChild(p);
      return;
    }
    for (const raw of jobs) {
      if (!raw || typeof raw !== "object") continue;
      const j = /** @type {Record<string, unknown>} */ (raw);
      const id = typeof j.id === "string" ? j.id : "";
      if (!id) continue;
      const title = typeof j.title === "string" ? j.title : "Job";
      const enabled = j.enabled !== false;
      const notify = j.notify !== false;
      const nextMs = typeof j.nextRunAtMs === "number" && Number.isFinite(j.nextRunAtMs) ? j.nextRunAtMs : null;
      const tz = lastResolvedSnap && lastResolvedSnap.appTime ? lastResolvedSnap.appTime.timeZone : "UTC";
      let nextStr = "—";
      if (nextMs !== null) {
        nextStr = formatInstantInZone(nextMs, tz);
      }
      const lastErr = typeof j.lastError === "string" && j.lastError.length ? j.lastError : "";

      const box = document.createElement("div");
      box.className = "scheduler-job";
      const h = document.createElement("div");
      h.className = "scheduler-job__title";
      h.textContent = title + (enabled ? "" : " (off)");
      box.appendChild(h);

      const r1 = document.createElement("div");
      r1.className = "scheduler-job__row";
      r1.textContent = formatScheduleLine(j);
      box.appendChild(r1);

      const r2 = document.createElement("div");
      r2.className = "scheduler-job__row";
      r2.textContent = "Next run: " + nextStr + (notify ? " · notifications on" : " · notifications off");
      box.appendChild(r2);

      if (lastErr) {
        const rE = document.createElement("div");
        rE.className = "scheduler-job__row";
        rE.style.color = "#fca5a5";
        rE.textContent = "Last error: " + lastErr.slice(0, 280) + (lastErr.length > 280 ? "…" : "");
        box.appendChild(rE);
      }

      const act = document.createElement("div");
      act.className = "scheduler-job__actions";

      const bRun = document.createElement("button");
      bRun.type = "button";
      bRun.textContent = "Run now";
      bRun.addEventListener("click", async () => {
        if (elStatus) elStatus.textContent = "Running job…";
        const res = await aa.schedulerRunNow(id);
        if (res && res.ok === true) {
          if (elStatus) elStatus.textContent = "Job started (watch chat / notification).";
        } else {
          const err = res && typeof res.error === "string" ? res.error : "failed";
          if (elStatus) elStatus.textContent = err;
        }
        await refreshScheduler();
      });

      const bDel = document.createElement("button");
      bDel.type = "button";
      bDel.textContent = "Delete";
      bDel.addEventListener("click", async () => {
        if (elStatus) elStatus.textContent = "Deleting…";
        await aa.schedulerDelete(id);
        if (elStatus) elStatus.textContent = "Deleted.";
        await refreshScheduler();
      });

      const bToggle = document.createElement("button");
      bToggle.type = "button";
      bToggle.textContent = enabled ? "Disable" : "Enable";
      bToggle.addEventListener("click", async () => {
        await aa.schedulerUpdate({ id, patch: { enabled: !enabled } });
        await refreshScheduler();
      });

      const bNotify = document.createElement("button");
      bNotify.type = "button";
      bNotify.textContent = notify ? "Notify off" : "Notify on";
      bNotify.addEventListener("click", async () => {
        await aa.schedulerUpdate({ id, patch: { notify: !notify } });
        await refreshScheduler();
      });

      act.appendChild(bRun);
      act.appendChild(bToggle);
      act.appendChild(bNotify);
      act.appendChild(bDel);
      box.appendChild(act);
      elSchedList.appendChild(box);
    }
  }

  async function refreshScheduler() {
    if (typeof aa.schedulerList !== "function" || !elSchedList) return;
    try {
      const r = await aa.schedulerList();
      if (!r || r.ok !== true) return;
      if (elSchedPath && typeof r.filePath === "string") {
        elSchedPath.textContent = "Jobs file: " + r.filePath;
      }
      if (elSchedNotifyHint) {
        elSchedNotifyHint.textContent =
          r.notifySupported === true
            ? "OS notifications: supported (enable for this app in system settings if prompts are blocked)."
            : "OS notifications: not reported as supported; in-app chat still receives results when open.";
      }
      renderSchedulerList(Array.isArray(r.jobs) ? r.jobs : []);
    } catch (_) {}
  }

  async function seedSchedOnceIfEmpty() {
    if (!(elSchedOnce instanceof HTMLInputElement) || elSchedOnce.value) return;
    const tz = lastResolvedSnap && lastResolvedSnap.appTime ? lastResolvedSnap.appTime.timeZone : "UTC";
    if (typeof aa.appTimeUtcToWall !== "function") return;
    const r = await aa.appTimeUtcToWall({ ms: Date.now() + 60 * 60 * 1000, timeZone: tz });
    if (r && r.ok === true && typeof r.wall === "string") {
      elSchedOnce.value = r.wall;
    }
  }

  async function loadPage() {
    if (elStatus) elStatus.textContent = "";
    try {
      const snap = await aa.settingsGet();
      lastResolvedSnap = snap.resolved;
      updateAppClockHint();
    } catch (_) {
      lastResolvedSnap = null;
    }
    await seedSchedOnceIfEmpty();
    await refreshScheduler();
  }

  if (elSchedKind) {
    elSchedKind.addEventListener("change", () => {
      syncSchedKindRows();
    });
    syncSchedKindRows();
  }

  const btnSchedAdd = document.getElementById("btn-scheduler-add");
  if (btnSchedAdd) {
    btnSchedAdd.addEventListener("click", async () => {
      const title = elSchedTitle && elSchedTitle.value.trim() ? elSchedTitle.value.trim() : "Scheduled task";
      const prompt = elSchedPrompt && elSchedPrompt.value.trim() ? elSchedPrompt.value.trim() : "";
      if (!prompt) {
        if (elStatus) elStatus.textContent = "Enter a prompt for the job.";
        return;
      }
      /** @type {{ kind: string, runAtIso?: string, intervalMinutes?: number }} */
      let schedule;
      if (elSchedKind && elSchedKind.value === "once") {
        const v = elSchedOnce && elSchedOnce.value ? elSchedOnce.value : "";
        if (!v) {
          if (elStatus) elStatus.textContent = "Pick date/time for one-shot job.";
          return;
        }
        const tz = lastResolvedSnap && lastResolvedSnap.appTime ? lastResolvedSnap.appTime.timeZone : "UTC";
        if (typeof aa.appTimeWallToUtcIso !== "function") {
          if (elStatus) elStatus.textContent = "Preload missing appTimeWallToUtcIso — rebuild.";
          return;
        }
        const conv = await aa.appTimeWallToUtcIso({ wall: v, timeZone: tz });
        if (!conv || conv.ok !== true) {
          if (elStatus) elStatus.textContent = (conv && conv.error) || "time conversion failed";
          return;
        }
        schedule = { kind: "once", runAtIso: conv.iso };
      } else {
        const n = elSchedInterval ? parseInt(String(elSchedInterval.value), 10) : 60;
        schedule = { kind: "interval", intervalMinutes: Number.isFinite(n) && n > 0 ? n : 60 };
      }
      if (elStatus) elStatus.textContent = "Adding job…";
      const res = await aa.schedulerCreate({
        title,
        prompt,
        notify: !!(elSchedNotify && elSchedNotify.checked),
        schedule,
      });
      if (res && res.ok === true) {
        if (elStatus) elStatus.textContent = "Scheduled job added.";
        if (elSchedPrompt) elSchedPrompt.value = "";
      } else {
        const err = res && typeof res.error === "string" ? res.error : "create failed";
        if (elStatus) elStatus.textContent = err;
      }
      await refreshScheduler();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void loadPage();
    }
  });

  void loadPage();
})();
