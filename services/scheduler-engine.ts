/** Timer loop: runs due scheduled jobs via agent + web search, desktop notifications, renderer IPC. */

import { BrowserWindow, Notification } from "electron";

import type { AgentStepPayload } from "./agent-runner.js";
import { runChatWithWebSearchFromSettings } from "./agent-runner.js";
import type { ChatMessage, ChatUsageSnapshot } from "./llm.js";
import type { ScheduledJob } from "./scheduler-store.js";
import { isJobDue, listScheduledJobs, recordJobRun } from "./scheduler-store.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("scheduler-engine");

/** Test hook: replace disk read. */
let jobsReader: () => ScheduledJob[] = listScheduledJobs;

const running = new Set<string>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

export type SchedulerJobFinishedPayload = {
  id: string;
  title: string;
  prompt: string;
  ok: boolean;
  text?: string;
  error?: string;
  steps?: AgentStepPayload[];
  usage?: ChatUsageSnapshot | null;
};

/** Overrides job source (tests). */
export function setSchedulerJobsReader(fn: () => ScheduledJob[]): void {
  jobsReader = fn;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn("broadcast failed", { channel, err: e instanceof Error ? e.message : String(e) });
    }
  }
}

function showOsNotification(title: string, body: string): void {
  if (!Notification.isSupported()) {
    log.info("Notification API not supported; skipping OS toast");
    return;
  }
  try {
    const n = new Notification({
      title: title.slice(0, 128),
      body: body.slice(0, 512),
    });
    n.show();
  } catch (e) {
    log.warn("notification show failed", { err: e instanceof Error ? e.message : String(e) });
  }
}

async function executeJob(job: ScheduledJob): Promise<void> {
  const id = job.id;
  if (running.has(id)) return;
  running.add(id);
  const history: ChatMessage[] = [{ role: "user", content: job.prompt }];
  try {
    const out = await runChatWithWebSearchFromSettings(history);
    const rec = recordJobRun(id, { ok: true });
    if (!rec.ok) {
      log.error("recordJobRun after success", rec.error);
    }
    const payload: SchedulerJobFinishedPayload = {
      id,
      title: job.title,
      prompt: job.prompt,
      ok: true,
      text: out.text,
      steps: out.steps,
      usage: out.usage ?? null,
    };
    broadcast("scheduler:job-finished", payload);
    if (job.notify) {
      showOsNotification(job.title, out.text.replace(/\s+/g, " ").slice(0, 480));
    }
    log.info("scheduler job ok", { id, title: job.title });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const rec = recordJobRun(id, { ok: false, error: msg });
    if (!rec.ok) {
      log.error("recordJobRun after failure", rec.error);
    }
    const payload: SchedulerJobFinishedPayload = {
      id,
      title: job.title,
      prompt: job.prompt,
      ok: false,
      error: msg,
    };
    broadcast("scheduler:job-finished", payload);
    if (job.notify) {
      showOsNotification(job.title, `Failed: ${msg.slice(0, 400)}`);
    }
    log.warn("scheduler job failed", { id, err: msg });
  } finally {
    running.delete(id);
  }
}

function tick(): void {
  const now = Date.now();
  let jobs: ScheduledJob[];
  try {
    jobs = jobsReader();
  } catch (e) {
    log.warn("scheduler read jobs failed", { err: e instanceof Error ? e.message : String(e) });
    return;
  }
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!isJobDue(job, now)) continue;
    if (running.has(job.id)) continue;
    void executeJob(job);
  }
}

/** Polls every `intervalMs` (default 20s) for due jobs. */
export function startSchedulerEngine(intervalMs = 20_000): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  tickTimer = setInterval(() => {
    tick();
  }, Math.max(5_000, intervalMs));
  tick();
}

export function stopSchedulerEngine(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Runs job immediately (Settings "Run now"); does not require due time. */
export async function runScheduledJobNow(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const jid = typeof id === "string" ? id.trim() : "";
  if (!jid) {
    return { ok: false, error: "id required" };
  }
  const job = listScheduledJobs().find((j) => j.id === jid);
  if (!job) {
    return { ok: false, error: "not found" };
  }
  await executeJob(job);
  return { ok: true };
}
