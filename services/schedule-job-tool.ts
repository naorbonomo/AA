/** OpenAI function schema + handler for `schedule_job` (CRUD against `scheduler-store` from agent loop). */

import {
  createScheduledJob,
  deleteScheduledJob,
  listScheduledJobsWithMeta,
  updateScheduledJob,
  type ScheduleSpec,
  type UpdateScheduledJobPatch,
} from "./scheduler-store.js";
import { getResolvedSettings } from "./settings-store.js";

export const scheduleJobOpenAiTool = {
  type: "function" as const,
  function: {
    name: "schedule_job",
    description:
      "Create, list, update, or delete scheduled background jobs. Each run uses LLM + web_search (Tavily). Repeating: every_minutes (e.g. 60). One-shot UTC: one_shot_utc_iso. Local wall time: Settings → Scheduler. Call list first if job_id unknown (update/delete).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "delete"],
          description: "create | list | update | delete",
        },
        title: { type: "string", description: "Short label (create; optional on update)." },
        prompt: {
          type: "string",
          description:
            "Instruction per run (create required). Optional on update — omit to leave unchanged.",
        },
        every_minutes: {
          type: "number",
          description:
            "Interval in minutes (create: required unless one_shot_utc_iso; update: optional to change cadence). 1–10080.",
        },
        one_shot_utc_iso: {
          type: "string",
          description:
            "UTC ISO-8601 instant for one-shot (create: alternative to every_minutes; update: optional to switch schedule).",
        },
        job_id: { type: "string", description: "Required for update and delete (from list)." },
        enabled: {
          type: "boolean",
          description: "update only — turn job on/off.",
        },
        notify_desktop: {
          type: "boolean",
          description: "Desktop notification after each run (create default true; update optional).",
        },
        deliver_desktop: {
          type: "boolean",
          description:
            "When true (default), scheduler run appends to desktop chat + IPC. Set false for Telegram-only delivery.",
        },
        deliver_telegram: {
          type: "boolean",
          description:
            "When true, scheduler run also sends result text to Telegram. Needs telegram_chat_id or Settings → default chat id.",
        },
        telegram_chat_id: {
          type: "integer",
          description:
            "Numeric Telegram chat_id for deliver_telegram. When creating from Telegram, omitted id uses current chat.",
        },
      },
      required: ["action"],
    },
  },
};

/** Optional context when agent runs inside Telegram — fills default telegram_chat_id for schedule_job. */
export type ScheduleJobToolContext = {
  telegramChatId?: number;
};

/** Runs tool; returns JSON-serializable object for the assistant message. */
export function executeScheduleJobTool(
  rawArgs: string,
  ctx?: ScheduleJobToolContext,
): Record<string, unknown> {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "invalid JSON arguments" };
  }
  const act = o.action;
  const action =
    act === "list" || act === "delete" || act === "create" || act === "update" ? act : null;
  if (!action) {
    return { ok: false, error: "action must be create, list, update, or delete" };
  }
  if (action === "list") {
    const jobs = listScheduledJobsWithMeta().map((j) => ({
      id: j.id,
      title: j.title,
      enabled: j.enabled,
      notify: j.notify,
      deliverDesktop: j.deliverDesktop,
      deliverTelegram: j.deliverTelegram,
      telegramChatId: j.telegramChatId,
      schedule: j.schedule,
      nextRunAtMs: j.nextRunAtMs,
      lastRunAt: j.lastRunAt,
    }));
    return { ok: true, jobs };
  }
  if (action === "delete") {
    const id = typeof o.job_id === "string" ? o.job_id.trim() : "";
    if (!id) {
      return { ok: false, error: "job_id required for delete" };
    }
    const r = deleteScheduledJob(id);
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    return { ok: true, deleted: id };
  }
  if (action === "update") {
    const id = typeof o.job_id === "string" ? o.job_id.trim() : "";
    if (!id) {
      return { ok: false, error: "job_id required for update" };
    }
    const patch: UpdateScheduledJobPatch = {};
    if (typeof o.title === "string" && o.title.trim()) {
      patch.title = o.title.trim();
    }
    if (typeof o.prompt === "string" && o.prompt.trim()) {
      patch.prompt = o.prompt.trim();
    }
    if (typeof o.enabled === "boolean") {
      patch.enabled = o.enabled;
    }
    if (typeof o.notify_desktop === "boolean") {
      patch.notify = o.notify_desktop;
    }
    if (typeof o.deliver_desktop === "boolean") {
      patch.deliverDesktop = o.deliver_desktop;
    }
    if (typeof o.deliver_telegram === "boolean") {
      patch.deliverTelegram = o.deliver_telegram;
    }
    if (o.telegram_chat_id !== undefined) {
      if (o.telegram_chat_id === null) {
        patch.telegramChatId = null;
      } else {
        const tc = Number(o.telegram_chat_id);
        if (Number.isFinite(tc)) {
          patch.telegramChatId = Math.floor(tc);
        }
      }
    }
    const everyU = o.every_minutes !== undefined ? Number(o.every_minutes) : NaN;
    const onceU = typeof o.one_shot_utc_iso === "string" ? o.one_shot_utc_iso.trim() : "";
    if (Number.isFinite(everyU) && everyU >= 1 && everyU <= 10_080) {
      patch.schedule = { kind: "interval", intervalMinutes: Math.floor(everyU) };
    } else if (onceU.length > 0) {
      const t = Date.parse(onceU);
      if (!Number.isFinite(t)) {
        return { ok: false, error: "invalid one_shot_utc_iso" };
      }
      patch.schedule = { kind: "once", runAtIso: new Date(t).toISOString() };
    }
    if (Object.keys(patch).length === 0) {
      return {
        ok: false,
        error:
          "update needs at least one of: title, prompt, enabled, notify_desktop, deliver_desktop, deliver_telegram, telegram_chat_id, every_minutes, one_shot_utc_iso",
      };
    }
    const r = updateScheduledJob(id, patch);
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    return { ok: true, job: r.job };
  }
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, error: "prompt required for create" };
  }
  const titleRaw = typeof o.title === "string" ? o.title.trim() : "";
  const notify = o.notify_desktop === false ? false : true;
  const deliverDesktop = o.deliver_desktop === false ? false : true;
  const deliverTelegram = o.deliver_telegram === true;
  let telegramChatId: number | undefined;
  if (o.telegram_chat_id !== undefined && o.telegram_chat_id !== null) {
    const tc = Number(o.telegram_chat_id);
    if (Number.isFinite(tc)) {
      telegramChatId = Math.floor(tc);
    }
  }
  if (deliverTelegram && telegramChatId === undefined && typeof ctx?.telegramChatId === "number") {
    const d = Math.floor(ctx.telegramChatId);
    if (Number.isInteger(d)) {
      telegramChatId = d;
    }
  }
  if (deliverTelegram && telegramChatId === undefined) {
    const fromSettings = getResolvedSettings().telegram.schedulerDefaultChatId;
    if (fromSettings != null) {
      telegramChatId = fromSettings;
    }
  }
  if (deliverTelegram && telegramChatId === undefined) {
    return {
      ok: false,
      error:
        "deliver_telegram needs telegram_chat_id, or run from Telegram, or set default in Settings → Chat / Telegram",
    };
  }
  const every = o.every_minutes !== undefined ? Number(o.every_minutes) : NaN;
  const onceIso = typeof o.one_shot_utc_iso === "string" ? o.one_shot_utc_iso.trim() : "";
  let schedule: ScheduleSpec | null = null;
  if (Number.isFinite(every) && every >= 1 && every <= 10_080) {
    schedule = { kind: "interval", intervalMinutes: Math.floor(every) };
  } else if (onceIso.length > 0) {
    const t = Date.parse(onceIso);
    if (!Number.isFinite(t)) {
      return { ok: false, error: "invalid one_shot_utc_iso" };
    }
    schedule = { kind: "once", runAtIso: new Date(t).toISOString() };
  } else {
    return { ok: false, error: "set every_minutes (1–10080) or one_shot_utc_iso for create" };
  }
  const created = createScheduledJob({
    title: titleRaw || "Scheduled task",
    prompt,
    notify,
    deliverDesktop,
    deliverTelegram,
    ...(telegramChatId !== undefined ? { telegramChatId } : {}),
    schedule,
  });
  if (!created.ok) {
    return { ok: false, error: created.error };
  }
  return { ok: true, job: created.job };
}
