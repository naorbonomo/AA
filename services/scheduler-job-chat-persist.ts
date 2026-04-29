/** Append scheduler-run assistant bubbles to aa-chat-history.json from main — chat.html may not be loaded when job finishes (multi-page UI). */

import type { AgentStepPayload } from "./agent-runner.js";
import type { ChatUsageSnapshot } from "./llm.js";
import type { ChatHistoryRow, ChatHistoryTtsClip, ChatHistoryUsageMeta } from "./chat-history-store.js";
import { readChatHistory, writeChatHistory } from "./chat-history-store.js";

function formatAgentStepsForHistory(steps: unknown[] | undefined): string {
  if (!Array.isArray(steps)) return "";
  const bits: string[] = [];
  for (const s of steps) {
    if (s && typeof s === "object" && (s as AgentStepPayload).kind === "schedule_job" && (s as AgentStepPayload).status === "done") {
      const ao = s as { action?: unknown; ok?: unknown; summary?: unknown };
      const act = typeof ao.action === "string" ? ao.action : "?";
      const ok = ao.ok !== false;
      const sum = typeof ao.summary === "string" ? ao.summary : "";
      bits.push(`schedule_job ${act}${ok ? " ✓" : " ✗"}${sum ? ` · ${sum}` : ""}`);
      continue;
    }
    if (s && typeof s === "object" && (s as AgentStepPayload).kind === "stt" && (s as AgentStepPayload).status === "done") {
      const ao = s as { file_name?: unknown; ok?: unknown; preview?: unknown; error?: unknown };
      const fn = typeof ao.file_name === "string" ? ao.file_name : "?";
      const ok = ao.ok !== false;
      const pv = typeof ao.preview === "string" ? ao.preview : "";
      const err = typeof ao.error === "string" ? ao.error : "";
      let line = `stt "${fn.length > 48 ? fn.slice(0, 48) + "…" : fn}"${ok ? " ✓" : " ✗"}`;
      if (ok && pv) line += `\n  ${pv}`;
      else if (!ok && err) line += `\n  ${err}`;
      bits.push(line);
      continue;
    }
    if (s && typeof s === "object" && (s as AgentStepPayload).kind === "tts" && (s as AgentStepPayload).status === "done") {
      const ao = s as { ok?: unknown; duration_seconds?: unknown; error?: unknown };
      const ok = ao.ok !== false;
      const sec = typeof ao.duration_seconds === "number" ? ao.duration_seconds : null;
      const err = typeof ao.error === "string" ? ao.error : "";
      let line = `tts${ok ? " ✓" : " ✗"}`;
      if (ok && sec != null) line += ` · ${sec}s`;
      else if (!ok && err) line += `\n  ${err}`;
      bits.push(line);
      continue;
    }
    if (s && typeof s === "object" && (s as AgentStepPayload).kind === "web_search" && (s as AgentStepPayload).status === "done") {
      const ao = s as {
        query?: unknown;
        hitCount?: unknown;
        ok?: unknown;
        previewSummary?: unknown;
        provider?: unknown;
        scrapeBackend?: unknown;
      };
      const q = typeof ao.query === "string" ? ao.query : "?";
      const n = typeof ao.hitCount === "number" ? ao.hitCount : 0;
      const ok = ao.ok !== false;
      const pv = typeof ao.previewSummary === "string" ? ao.previewSummary : "";
      const prov =
        typeof ao.provider === "string"
          ? ao.provider +
            (typeof ao.scrapeBackend === "string" && ao.scrapeBackend.length ? `/${ao.scrapeBackend}` : "")
          : "";
      let line =
        `web_search "${q.length > 56 ? q.slice(0, 56) + "…" : q}" → ${n} hit${n === 1 ? "" : "s"}${ok ? "" : " (fail)"}`;
      if (prov) line += ` · ${prov}`;
      bits.push(line + (pv ? `\n  ${pv}` : ""));
    }
  }
  return bits.join("\n\n");
}

function usageSnapshotToMeta(u: ChatUsageSnapshot | null, wallMs: number): ChatHistoryUsageMeta | undefined {
  if (!u) {
    return wallMs > 0
      ? {
          wallMs,
          total_tokens: null,
          prompt_tokens: null,
          completion_tokens: null,
          msPerToken: null,
        }
      : undefined;
  }
  const prompt = typeof u.prompt_tokens === "number" ? Math.floor(u.prompt_tokens) : null;
  const completion = typeof u.completion_tokens === "number" ? Math.floor(u.completion_tokens) : null;
  let total: number | null = null;
  if (typeof u.total_tokens === "number") total = Math.floor(u.total_tokens);
  else if (prompt !== null && completion !== null) total = prompt + completion;
  const hasUsage =
    prompt !== null || completion !== null || total !== null;
  let reasoning_tokens: number | undefined;
  const cd = u.completion_tokens_details;
  if (cd && typeof cd === "object" && typeof cd.reasoning_tokens === "number") {
    reasoning_tokens = Math.floor(cd.reasoning_tokens);
  }
  let msPerToken: number | null = null;
  if (wallMs > 0) {
    if (completion !== null && completion > 0) msPerToken = wallMs / completion;
    else if (total !== null && total > 0) msPerToken = wallMs / total;
  }
  if (!hasUsage && wallMs <= 0) return undefined;
  const meta: ChatHistoryUsageMeta = {
    wallMs,
    total_tokens: total,
    prompt_tokens: prompt,
    completion_tokens: completion,
    msPerToken,
  };
  if (reasoning_tokens !== undefined) meta.reasoning_tokens = reasoning_tokens;
  return meta;
}

function collectTtsFromSteps(steps: unknown[] | undefined): ChatHistoryTtsClip[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  const out: ChatHistoryTtsClip[] = [];
  for (const s of steps) {
    if (out.length >= 8) break;
    if (
      s &&
      typeof s === "object" &&
      (s as { kind?: unknown }).kind === "tts" &&
      (s as { status?: unknown }).status === "done" &&
      typeof (s as { dataUrl?: unknown }).dataUrl === "string" &&
      (s as { dataUrl: string }).dataUrl.startsWith("data:audio/")
    ) {
      const du = (s as { dataUrl: string }).dataUrl;
      if (du.length <= 6_000_000) out.push({ dataUrl: du });
    }
  }
  return out.length ? out : undefined;
}

export type SchedulerJobPersistInput = {
  title: string;
  ok: boolean;
  text?: string;
  error?: string;
  steps?: AgentStepPayload[];
  usage?: ChatUsageSnapshot | null;
};

/** Mirrors `chat.js` applySchedulerFinished row shape so loaded Chat tab matches scheduler-run path. */
export function appendSchedulerJobToDisk(p: SchedulerJobPersistInput): void {
  let body = "";
  if (p.ok && typeof p.text === "string") body = p.text;
  else if (typeof p.error === "string") body = p.error;
  else body = p.ok ? "" : "error";

  const content = `[Scheduled: ${p.title}]\n\n${body}`;
  const trace = formatAgentStepsForHistory(p.steps);
  const atMs = Date.now();
  const row: ChatHistoryRow = {
    role: "assistant",
    content,
    atMs,
  };
  if (trace) row.agentTrace = trace;
  const um = usageSnapshotToMeta(p.usage ?? null, 0);
  if (um) row.usageMeta = um;
  const clips = collectTtsFromSteps(p.steps);
  if (clips) row.agentTtsClips = clips;

  const rows = readChatHistory();
  rows.push(row);
  writeChatHistory(rows);
}
