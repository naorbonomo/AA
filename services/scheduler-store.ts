/** Persist scheduled agent jobs (one-shot or repeating) as JSON under Electron userData or CLI cwd. */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

let storeUserDataDir: string | null = null;

function aaRootFromCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

/** Initializes path for `aa-scheduled-jobs.json`. */
export function initializeSchedulerStore(opts?: { userDataDir?: string }): void {
  storeUserDataDir = opts?.userDataDir?.trim() ? opts.userDataDir : null;
}

export function getSchedulerJobsFilePath(): string {
  if (storeUserDataDir) {
    return path.join(storeUserDataDir, "aa-scheduled-jobs.json");
  }
  return path.join(aaRootFromCwd(), "aa-scheduled-jobs.json");
}

/** `runAtIso` for `once` is always UTC instant (`Date.toISOString()`), not wall-local. */
export type ScheduleSpec =
  | { kind: "once"; runAtIso: string }
  | { kind: "interval"; intervalMinutes: number };

export type ScheduledJob = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  /** When true, show OS notification (macOS/Windows) after each run. */
  notify: boolean;
  /** When true (default), append assistant bubble to desktop chat + IPC broadcast. */
  deliverDesktop: boolean;
  /** When true, send assistant text to Telegram (needs `telegramChatId` or settings default). */
  deliverTelegram: boolean;
  /** Target chat for `deliverTelegram`; optional if `telegram.schedulerDefaultChatId` is set. */
  telegramChatId?: number;
  schedule: ScheduleSpec;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastError?: string;
};

export type ScheduledJobListItem = ScheduledJob & {
  /** Next fire time (ms since epoch), or null if disabled / completed once. */
  nextRunAtMs: number | null;
};

const MAX_JOBS = 100;
const MAX_PROMPT = 32_000;
const MAX_TITLE = 200;

function clampStr(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max) : s;
}

function isoNow(): string {
  return new Date().toISOString();
}

function normalizeSchedule(raw: unknown): ScheduleSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind === "once" ? "once" : o.kind === "interval" ? "interval" : null;
  if (kind === "once") {
    const runAtIso = typeof o.runAtIso === "string" ? o.runAtIso.trim() : "";
    const t = Date.parse(runAtIso);
    if (!runAtIso || !Number.isFinite(t)) return null;
    return { kind: "once", runAtIso };
  }
  if (kind === "interval") {
    const n = Number(o.intervalMinutes);
    const intervalMinutes = Number.isFinite(n) ? Math.floor(n) : NaN;
    if (intervalMinutes < 1 || intervalMinutes > 10_080) return null;
    return { kind: "interval", intervalMinutes };
  }
  return null;
}

function normalizeJob(raw: unknown): ScheduledJob | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : "";
  if (!id) return null;
  const prompt = clampStr(o.prompt, MAX_PROMPT);
  if (!prompt) return null;
  const title = clampStr(o.title, MAX_TITLE) || "Scheduled task";
  const schedule = normalizeSchedule(o.schedule);
  if (!schedule) return null;
  const createdAt = typeof o.createdAt === "string" ? o.createdAt : isoNow();
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : createdAt;
  const job: ScheduledJob = {
    id,
    title,
    prompt,
    enabled: o.enabled === false ? false : true,
    notify: o.notify === false ? false : true,
    deliverDesktop: o.deliverDesktop === false ? false : true,
    deliverTelegram: o.deliverTelegram === true,
    schedule,
    createdAt,
    updatedAt,
  };
  if (typeof o.telegramChatId === "number" && Number.isFinite(o.telegramChatId)) {
    const c = Math.floor(o.telegramChatId);
    if (Number.isInteger(c)) {
      job.telegramChatId = c;
    }
  }
  if (typeof o.lastRunAt === "string" && o.lastRunAt.length) job.lastRunAt = o.lastRunAt;
  if (typeof o.lastError === "string" && o.lastError.length) job.lastError = o.lastError.slice(0, 4000);
  return job;
}

function readRawJobs(): ScheduledJob[] {
  const p = getSchedulerJobsFilePath();
  let raw: unknown;
  try {
    const text = fs.readFileSync(p, "utf8");
    raw = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ScheduledJob[] = [];
  for (const item of raw) {
    const j = normalizeJob(item);
    if (j) out.push(j);
    if (out.length >= MAX_JOBS) break;
  }
  return out;
}

function writeRawJobs(jobs: ScheduledJob[]): void {
  const p = getSchedulerJobsFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(jobs.slice(0, MAX_JOBS), null, 2)}\n`, "utf8");
}

/** Next fire time for enabled jobs; once-job with lastRunAt treated as done (caller should disable). */
export function computeNextRunAtMs(job: ScheduledJob, nowMs: number): number | null {
  if (!job.enabled) return null;
  if (job.schedule.kind === "once") {
    const at = Date.parse(job.schedule.runAtIso);
    if (!Number.isFinite(at)) return null;
    if (job.lastRunAt) return null;
    return at;
  }
  const intervalMs = Math.max(60_000, job.schedule.intervalMinutes * 60_000);
  const last = job.lastRunAt ? Date.parse(job.lastRunAt) : NaN;
  if (Number.isFinite(last)) {
    return last + intervalMs;
  }
  const created = Date.parse(job.createdAt);
  const base = Number.isFinite(created) ? created : nowMs;
  return base + intervalMs;
}

export function isJobDue(job: ScheduledJob, nowMs: number): boolean {
  const next = computeNextRunAtMs(job, nowMs);
  if (next === null) return false;
  return nowMs >= next;
}

export function listScheduledJobsWithMeta(): ScheduledJobListItem[] {
  const now = Date.now();
  return readRawJobs().map((j) => ({
    ...j,
    nextRunAtMs: computeNextRunAtMs(j, now),
  }));
}

export function listScheduledJobs(): ScheduledJob[] {
  return readRawJobs();
}

export type CreateScheduledJobInput = {
  title?: string;
  prompt: string;
  enabled?: boolean;
  notify?: boolean;
  deliverDesktop?: boolean;
  deliverTelegram?: boolean;
  telegramChatId?: number;
  schedule: ScheduleSpec;
};

/** Creates job; returns job or error message. */
export function createScheduledJob(input: CreateScheduledJobInput): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
  const prompt = clampStr(input.prompt, MAX_PROMPT).trim();
  if (!prompt) {
    return { ok: false, error: "prompt required" };
  }
  const schedule = normalizeSchedule(input.schedule);
  if (!schedule) {
    return { ok: false, error: "invalid schedule" };
  }
  const jobs = readRawJobs();
  if (jobs.length >= MAX_JOBS) {
    return { ok: false, error: "max jobs reached" };
  }
  const t = isoNow();
  const job: ScheduledJob = {
    id: randomUUID(),
    title: clampStr(input.title, MAX_TITLE).trim() || "Scheduled task",
    prompt,
    enabled: input.enabled === false ? false : true,
    notify: input.notify === false ? false : true,
    deliverDesktop: input.deliverDesktop === false ? false : true,
    deliverTelegram: input.deliverTelegram === true,
    schedule,
    createdAt: t,
    updatedAt: t,
  };
  if (typeof input.telegramChatId === "number" && Number.isFinite(input.telegramChatId)) {
    const c = Math.floor(input.telegramChatId);
    if (Number.isInteger(c)) {
      job.telegramChatId = c;
    }
  }
  jobs.push(job);
  writeRawJobs(jobs);
  return { ok: true, job };
}

export type UpdateScheduledJobPatch = Partial<
  Pick<
    ScheduledJob,
    | "title"
    | "prompt"
    | "enabled"
    | "notify"
    | "deliverDesktop"
    | "deliverTelegram"
    | "schedule"
    | "lastError"
  >
> & { telegramChatId?: number | null };

export function updateScheduledJob(
  id: string,
  patch: UpdateScheduledJobPatch,
): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
  const jid = typeof id === "string" ? id.trim() : "";
  if (!jid) {
    return { ok: false, error: "id required" };
  }
  const jobs = readRawJobs();
  const idx = jobs.findIndex((j) => j.id === jid);
  if (idx < 0) {
    return { ok: false, error: "not found" };
  }
  const cur = jobs[idx];
  const next: ScheduledJob = { ...cur, updatedAt: isoNow() };
  if (patch.title !== undefined) {
    next.title = clampStr(patch.title, MAX_TITLE).trim() || "Scheduled task";
  }
  if (patch.prompt !== undefined) {
    const p = clampStr(patch.prompt, MAX_PROMPT).trim();
    if (!p) {
      return { ok: false, error: "prompt empty" };
    }
    next.prompt = p;
  }
  if (patch.enabled !== undefined) {
    const wasEnabled = cur.enabled;
    next.enabled = !!patch.enabled;
    if (next.enabled && !wasEnabled && next.schedule.kind === "once") {
      delete next.lastRunAt;
      delete next.lastError;
    }
  }
  if (patch.notify !== undefined) {
    next.notify = !!patch.notify;
  }
  if (patch.deliverDesktop !== undefined) {
    next.deliverDesktop = !!patch.deliverDesktop;
  }
  if (patch.deliverTelegram !== undefined) {
    next.deliverTelegram = !!patch.deliverTelegram;
  }
  if (patch.telegramChatId !== undefined) {
    if (patch.telegramChatId === null) {
      delete next.telegramChatId;
    } else if (typeof patch.telegramChatId === "number" && Number.isFinite(patch.telegramChatId)) {
      const c = Math.floor(patch.telegramChatId);
      if (Number.isInteger(c)) {
        next.telegramChatId = c;
      }
    }
  }
  if (patch.schedule !== undefined) {
    const s = normalizeSchedule(patch.schedule);
    if (!s) {
      return { ok: false, error: "invalid schedule" };
    }
    next.schedule = s;
    delete next.lastRunAt;
    delete next.lastError;
  }
  if (patch.lastError !== undefined) {
    if (patch.lastError === "" || patch.lastError === null) {
      delete next.lastError;
    } else {
      next.lastError = String(patch.lastError).slice(0, 4000);
    }
  }
  jobs[idx] = next;
  writeRawJobs(jobs);
  return { ok: true, job: next };
}

export function deleteScheduledJob(id: string): { ok: true } | { ok: false; error: string } {
  const jid = typeof id === "string" ? id.trim() : "";
  if (!jid) {
    return { ok: false, error: "id required" };
  }
  const jobs = readRawJobs();
  const next = jobs.filter((j) => j.id !== jid);
  if (next.length === jobs.length) {
    return { ok: false, error: "not found" };
  }
  writeRawJobs(next);
  return { ok: true };
}

/**
 * Persists run outcome. For `once` schedule, disables job after attempt.
 */
export function recordJobRun(
  id: string,
  outcome: { ok: boolean; error?: string },
): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
  const jid = typeof id === "string" ? id.trim() : "";
  if (!jid) {
    return { ok: false, error: "id required" };
  }
  const jobs = readRawJobs();
  const idx = jobs.findIndex((j) => j.id === jid);
  if (idx < 0) {
    return { ok: false, error: "not found" };
  }
  const cur = jobs[idx];
  const next: ScheduledJob = {
    ...cur,
    updatedAt: isoNow(),
    lastRunAt: isoNow(),
  };
  if (outcome.ok) {
    delete next.lastError;
  } else {
    next.lastError = (outcome.error ?? "error").slice(0, 4000);
  }
  if (next.schedule.kind === "once") {
    next.enabled = false;
  }
  jobs[idx] = next;
  writeRawJobs(jobs);
  return { ok: true, job: next };
}
