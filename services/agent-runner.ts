/** Agent loop: `web_search` + `schedule_job` + `stt` + `tts` + `youtube_transcribe` + follow-up completions (main process). */

import { resolveAgentSystemContent } from "../config/system_prompts.js";
import type { ResolvedAgent } from "../config/user-settings.js";
import type { ChatMessage, ChatUsageSnapshot, CompletionApiMessage, StreamDelta } from "./llm.js";
import { normalizeAssistantContent, streamCompletionPost, completionUserMessage } from "./llm.js";
import { executeScheduleJobTool, scheduleJobOpenAiTool, type ScheduleJobToolContext } from "./schedule-job-tool.js";
import { webSearch, webSearchOpenAiTool, shrinkWebSearchForToolMessage } from "./web-search.js";
import { executeTtsTool, ttsOpenAiTool } from "./tts-tool.js";
import {
  executeSttTool,
  sttOpenAiTool,
  type StagedAudioClip,
} from "./whisper-transcribe-tool.js";
import {
  executeYoutubeTranscribeTool,
  youtubeTranscribeOpenAiTool,
} from "./youtube-transcribe-tool.js";
import { getResolvedSettings } from "./settings-store.js";
import { getLogger, logToolInfo } from "../utils/logger.js";

const log = getLogger("agent-runner");

export type AgentStepPayload =
  | { kind: "web_search"; status: "start"; query: string }
  | {
      kind: "web_search";
      status: "done";
      query: string;
      hitCount: number;
      ok: boolean;
      provider?: string;
      scrapeBackend?: string;
      /** First-hit preview for logs + UI trace. */
      previewSummary?: string;
    }
  | { kind: "schedule_job"; status: "done"; action: string; ok: boolean; summary?: string }
  | { kind: "stt"; status: "start"; file_name: string }
  | {
      kind: "stt";
      status: "done";
      file_name: string;
      ok: boolean;
      /** Short head of transcript for trace. */
      preview?: string;
      error?: string;
    }
  | { kind: "tts"; status: "start"; preview?: string }
  | {
      kind: "tts";
      status: "done";
      ok: boolean;
      duration_seconds?: number;
      error?: string;
      /** WAV data URL for UI playback only (not in LLM tool JSON). */
      dataUrl?: string;
    }
  | { kind: "youtube_transcribe"; status: "start"; url: string; transcript_source: string }
  | {
      kind: "youtube_transcribe";
      status: "done";
      url: string;
      transcript_source: string;
      ok: boolean;
      backend?: string;
      preview?: string;
      error?: string;
    };

function mergeUsage(acc: ChatUsageSnapshot | undefined, next: ChatUsageSnapshot | undefined): ChatUsageSnapshot | undefined {
  if (!next) {
    return acc;
  }
  if (!acc) {
    return { ...next };
  }
  const merged: ChatUsageSnapshot = { ...acc };
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const a = merged[k];
    const b = next[k];
    if (typeof b === "number") {
      merged[k] = (typeof a === "number" ? a : 0) + b;
    }
  }
  return merged;
}

function parseToolArgs(raw: string | undefined): { query?: string; max_results?: number } {
  if (!raw || typeof raw !== "string") {
    return {};
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const query = typeof o.query === "string" ? o.query : undefined;
    const max_results = o.max_results !== undefined ? Number(o.max_results) : undefined;
    return {
      query,
      max_results: Number.isFinite(max_results) ? max_results : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Tool loop: `web_search` + `schedule_job` + `stt` + `tts` + `youtube_transcribe`; streamed completions until assistant returns text or rounds exhausted.
 */
export async function runChatWithWebSearchTool(opts: {
  history: ChatMessage[];
  maxToolRounds: number;
  /** When omitted, reads merged settings once for system preset/override. */
  resolvedAgent?: ResolvedAgent;
  /** Float32 PCM keyed by exact `File.name` from chat attach; main fills from renderer each turn. */
  stagedAudioByFileName?: Map<string, StagedAudioClip>;
  onStep?: (p: AgentStepPayload) => void;
  /** Token/reasoning deltas for current assistant round (each completion is streamed). */
  onStreamDelta?: (d: StreamDelta) => void;
  /** Passed into `schedule_job` tool (e.g. Telegram `chat_id` for deliver_telegram default). */
  scheduleJobContext?: ScheduleJobToolContext;
}): Promise<{
  text: string;
  steps: AgentStepPayload[];
  usage?: ChatUsageSnapshot;
}> {
  const maxRounds = Math.max(1, Math.min(500, opts.maxToolRounds));
  const settings = getResolvedSettings();
  const agentResolved = opts.resolvedAgent ?? settings.agent;
  const staged =
    opts.stagedAudioByFileName instanceof Map
      ? opts.stagedAudioByFileName
      : new Map<string, StagedAudioClip>();
  const whisperResolved = settings.whisper;
  const vision = settings.llm.vision === true;
  const systemBody = resolveAgentSystemContent(agentResolved);
  const msgs: CompletionApiMessage[] = [{ role: "system", content: systemBody }];
  for (const m of opts.history) {
    if (m.role === "user") {
      msgs.push(completionUserMessage(m, vision));
      continue;
    }
    const c = typeof m.content === "string" ? m.content : String(m.content);
    msgs.push({ role: m.role, content: c } as CompletionApiMessage);
  }

  let usageAcc: ChatUsageSnapshot | undefined;
  const stepsOut: AgentStepPayload[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    logToolInfo("agent", "round", { round });
    const streamed = await streamCompletionPost({
      messages: msgs,
      tools: [
        webSearchOpenAiTool,
        scheduleJobOpenAiTool,
        sttOpenAiTool,
        ttsOpenAiTool,
        youtubeTranscribeOpenAiTool,
      ],
      tool_choice: "auto",
      onDelta: opts.onStreamDelta,
    });
    usageAcc = mergeUsage(usageAcc, streamed.usage);
    const message = streamed.message;
    if (!message || typeof message !== "object") {
      throw new Error("Agent: missing message");
    }

    msgs.push(JSON.parse(JSON.stringify(message)) as CompletionApiMessage);

    const tc = message.tool_calls;
    if (!Array.isArray(tc) || tc.length === 0) {
      const text = normalizeAssistantContent(message.content ?? null);
      if (text === null || text === "") {
        throw new Error("Agent: assistant returned no text and no tools");
      }
      return { text, steps: stepsOut, usage: usageAcc };
    }

    for (const call of tc) {
      const id = typeof call.id === "string" ? call.id : "";
      const name = call.function?.name?.trim() ?? "";
      const rawArgs = typeof call.function?.arguments === "string" ? call.function.arguments : "{}";
      if (name === "tts") {
        let preview = "";
        try {
          const pa = JSON.parse(rawArgs) as { text?: string };
          if (typeof pa.text === "string") {
            const t = pa.text.replace(/\s+/g, " ").trim();
            preview = t.length > 80 ? `${t.slice(0, 80)}…` : t;
          }
        } catch {
          /* keep */
        }
        const stTts0: AgentStepPayload = { kind: "tts", status: "start", preview: preview || undefined };
        opts.onStep?.(stTts0);
        stepsOut.push(stTts0);

        const ttsResult = await executeTtsTool(rawArgs);
        const ok = ttsResult.llm.ok === true;
        const stepTtsDone: AgentStepPayload = {
          kind: "tts",
          status: "done",
          ok,
          ...(ok && "duration_seconds" in ttsResult.llm
            ? { duration_seconds: ttsResult.llm.duration_seconds }
            : {}),
          ...(!ok && "error" in ttsResult.llm ? { error: ttsResult.llm.error } : {}),
          ...(ttsResult.ui?.dataUrl ? { dataUrl: ttsResult.ui.dataUrl } : {}),
        };
        opts.onStep?.(stepTtsDone);
        stepsOut.push(stepTtsDone);
        logToolInfo("tts", "done", { round, ok });
        msgs.push({ role: "tool", tool_call_id: id, content: JSON.stringify(ttsResult.llm) });
        continue;
      }

      if (name === "youtube_transcribe") {
        let yUrl = "";
        let yMode = "auto";
        try {
          const pa = JSON.parse(rawArgs) as { url?: string; transcript_source?: string };
          if (typeof pa.url === "string") {
            yUrl = pa.url.trim();
          }
          if (pa.transcript_source === "youtube" || pa.transcript_source === "whisper" || pa.transcript_source === "auto") {
            yMode = pa.transcript_source;
          }
        } catch {
          /* keep */
        }
        const stYt0: AgentStepPayload = {
          kind: "youtube_transcribe",
          status: "start",
          url: yUrl,
          transcript_source: yMode,
        };
        opts.onStep?.(stYt0);
        stepsOut.push(stYt0);

        const ytResult = await executeYoutubeTranscribeTool({
          rawArgs,
          whisper: whisperResolved,
        });
        const yOk = ytResult.ok === true;
        let yPreview: string | undefined;
        let yBackend: string | undefined;
        let yErr: string | undefined;
        if (yOk && "text" in ytResult) {
          const t = ytResult.text.replace(/\s+/g, " ").trim();
          yPreview = t.length > 160 ? `${t.slice(0, 160)}…` : t;
          yBackend = ytResult.backend;
        } else if (!yOk && "error" in ytResult) {
          yErr = ytResult.error;
        }
        const stepYtDone: AgentStepPayload = {
          kind: "youtube_transcribe",
          status: "done",
          url: yUrl || "?",
          transcript_source:
            ytResult.ok === false && ytResult.transcript_source
              ? ytResult.transcript_source
              : ytResult.ok && "transcript_source" in ytResult
                ? ytResult.transcript_source
                : yMode,
          ok: yOk,
          ...(yBackend ? { backend: yBackend } : {}),
          ...(yPreview ? { preview: yPreview } : {}),
          ...(yErr ? { error: yErr } : {}),
        };
        opts.onStep?.(stepYtDone);
        stepsOut.push(stepYtDone);
        logToolInfo("youtube_transcribe", "done", { round, ok: yOk, mode: yMode });
        msgs.push({ role: "tool", tool_call_id: id, content: JSON.stringify(ytResult) });
        continue;
      }

      if (name === "stt") {
        const st0: AgentStepPayload = { kind: "stt", status: "start", file_name: "" };
        try {
          const pa = JSON.parse(rawArgs) as { file_name?: string; audio_file_name?: string; audio_path?: string };
          const n = pa.file_name ?? pa.audio_file_name ?? pa.audio_path;
          if (typeof n === "string") {
            st0.file_name = n;
          }
        } catch {
          /* keep */
        }
        opts.onStep?.(st0);
        stepsOut.push(st0);

        const result = await executeSttTool({
          rawArgs: rawArgs,
          stagedByName: staged,
          whisper: whisperResolved,
        });
        const ok = result.ok === true;
        let preview: string | undefined;
        let error: string | undefined;
        if (ok && "text" in result) {
          const t = result.text.replace(/\s+/g, " ").trim();
          preview = t.length > 160 ? `${t.slice(0, 160)}…` : t;
        } else if (!ok && "error" in result) {
          error = result.error;
        }
        const stepDone: AgentStepPayload = {
          kind: "stt",
          status: "done",
          file_name: st0.file_name || "?",
          ok,
          preview,
          error,
        };
        opts.onStep?.(stepDone);
        stepsOut.push(stepDone);
        logToolInfo("stt", "done", { round, ok, file_name: stepDone.file_name });
        msgs.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result) });
        continue;
      }

      if (name === "schedule_job") {
        const result = executeScheduleJobTool(rawArgs, opts.scheduleJobContext);
        const ok = result.ok === true;
        let schedAction = "?";
        try {
          const p = JSON.parse(rawArgs) as { action?: string };
          if (typeof p.action === "string") schedAction = p.action;
        } catch {
          /* keep */
        }
        let summary: string | undefined;
        if (ok && typeof result.job === "object" && result.job !== null) {
          const j = result.job as { id?: string; title?: string };
          if (schedAction === "update") {
            summary = `updated ${j.id ?? "?"} (${j.title ?? ""})`;
          } else {
            summary = `created ${j.id ?? "?"} (${j.title ?? ""})`;
          }
        } else if (ok && Array.isArray(result.jobs)) {
          summary = `list ${result.jobs.length} job(s)`;
        } else if (ok && typeof result.deleted === "string") {
          summary = `deleted ${result.deleted}`;
        } else if (typeof result.error === "string") {
          summary = result.error;
        }
        const step: AgentStepPayload = {
          kind: "schedule_job",
          status: "done",
          action: schedAction,
          ok,
          summary,
        };
        opts.onStep?.(step);
        stepsOut.push(step);
        logToolInfo("schedule_job", "done", { round, ok, action: schedAction, summary });
        msgs.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result) });
        continue;
      }

      if (name !== "web_search") {
        const errText = JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
        msgs.push({ role: "tool", tool_call_id: id, content: errText });
        continue;
      }

      const parsed = parseToolArgs(rawArgs);
      const q = (parsed.query ?? "").trim();
      if (!q) {
        msgs.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify({ ok: false, error: "missing query in tool arguments" }),
        });
        continue;
      }

      const st: AgentStepPayload = { kind: "web_search", status: "start", query: q };
      opts.onStep?.(st);
      stepsOut.push(st);

      const result = await webSearch(q, {
        maxResults: parsed.max_results,
      });
      const hitCount = result.ok ? result.results.length : 0;

      let previewSummary: string | undefined;
      let providerLabel: string | undefined;
      let scrapeLabel: string | undefined;
      if (result.ok && result.results.length > 0) {
        providerLabel = result.provider;
        scrapeLabel = result.scrapeBackend;
        let host = "";
        try {
          host = new URL(result.results[0].url).hostname.replace(/^www\./, "");
        } catch {
          host = "?";
        }
        const sn = result.results[0].snippet.replace(/\s+/g, " ").slice(0, 120);
        previewSummary = `${host}: ${sn}${result.results[0].snippet.length > 120 ? "…" : ""}`;
        logToolInfo("web_search", "hits", {
          round,
          query: q,
          provider: providerLabel,
          scrapeBackend: scrapeLabel,
          hitCount,
          firstUrl: result.results[0].url,
          firstSnippet: result.results[0].snippet.slice(0, 280),
        });
      } else if (!result.ok) {
        log.warn("agent web_search tool", {
          round,
          query: q,
          error: result.error,
        });
        logToolInfo("web_search", "fail", { round, query: q, error: result.error });
      } else {
        log.warn("agent web_search tool", { round, query: q, note: "ok but zero hits" });
        logToolInfo("web_search", "empty", { round, query: q });
      }

      const done: AgentStepPayload = {
        kind: "web_search",
        status: "done",
        query: q,
        hitCount,
        ok: result.ok,
        provider: providerLabel,
        scrapeBackend: scrapeLabel,
        previewSummary,
      };
      opts.onStep?.(done);
      stepsOut.push(done);

      msgs.push({
        role: "tool",
        tool_call_id: id,
        content: JSON.stringify(shrinkWebSearchForToolMessage(result)),
      });
    }
  }

  throw new Error(`Agent: exceeded max tool rounds (${maxRounds})`);
}

/** Uses `agent.maxToolRounds` from merged settings. */
export async function runChatWithWebSearchFromSettings(
  history: ChatMessage[],
  onStep?: (p: AgentStepPayload) => void,
  onStreamDelta?: (d: StreamDelta) => void,
  stagedAudioByFileName?: Map<string, StagedAudioClip>,
  scheduleJobContext?: ScheduleJobToolContext,
): Promise<{ text: string; steps: AgentStepPayload[]; usage?: ChatUsageSnapshot }> {
  const s = getResolvedSettings();
  return runChatWithWebSearchTool({
    history,
    maxToolRounds: s.agent.maxToolRounds,
    resolvedAgent: s.agent,
    stagedAudioByFileName,
    onStep,
    onStreamDelta,
    scheduleJobContext,
  });
}
