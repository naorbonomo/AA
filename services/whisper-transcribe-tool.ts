/** OpenAI-function `stt`: local Whisper — in-memory PCM for current turn plus on-disk ffmpeg path from saved chat attachments (restarts). */

import fs from "node:fs";

import type { ResolvedWhisper } from "../config/user-settings.js";
import { pathIsInsideChatAttachments } from "./chat-attachment-store.js";
import { transcribeAudioFileInChild } from "./whisper-child.js";
import { transcribePcm } from "./whisper-transformers.js";
import { logToolInfo } from "../utils/logger.js";

export const sttOpenAiTool = {
  type: "function" as const,
  function: {
    name: "stt",
    description:
      "Speech-to-text: transcribe user-attached audio to plain text (local Whisper). Use file_name exactly as listed in the user ‘Attached files’ block (same spelling/case). If this turn sends no PCM, prior turns might still expose the same file_name with a saved disk path — stt resolves from ffmpeg + Whisper. Returns { ok, text }.",
    parameters: {
      type: "object",
      properties: {
        file_name: {
          type: "string",
          description:
            'Exact attachment file name including extension, e.g. "memo.m4a" — character-for-character match to the dashed list in the user message.',
        },
        language: {
          type: "string",
          description: 'Optional ISO-639-1 code (e.g. "en", "he"). Omit to auto-detect (multilingual models only).',
        },
        task: {
          type: "string",
          enum: ["transcribe", "translate"],
          description: 'transcribe = same language; translate = to English (Whisper). Default transcribe.',
        },
      },
      required: ["file_name"],
    },
  },
};

export type StagedAudioClip = { samples: Float32Array; sampleRate: number };

function parseArgs(raw: string | undefined): {
  file_name?: string;
  language?: string;
  task?: "transcribe" | "translate";
} {
  if (!raw || typeof raw !== "string") {
    return {};
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const rawName = o.file_name ?? o.audio_file_name ?? o.audio_path;
    const file_name = typeof rawName === "string" ? rawName.trim() : "";
    const language = typeof o.language === "string" ? o.language.trim() : undefined;
    const t = o.task;
    const task = t === "translate" || t === "transcribe" ? t : undefined;
    return {
      file_name: file_name || undefined,
      language: language || undefined,
      task,
    };
  } catch {
    return {};
  }
}

export async function executeSttTool(opts: {
  rawArgs: string;
  stagedByName: Map<string, StagedAudioClip>;
  savedPathsByName?: Map<string, string>;
  whisper: ResolvedWhisper;
  onProgress?: (status: unknown) => void;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const { rawArgs, stagedByName, savedPathsByName, whisper, onProgress } = opts;
  const { file_name, language, task } = parseArgs(rawArgs);
  const key = file_name ?? "";
  if (!key) {
    logToolInfo("stt", "skip", { reason: "file_name required" });
    return { ok: false, error: "file_name required" };
  }
  const clip = stagedByName.get(key);
  let diskPath: string | null = null;
  const p = savedPathsByName?.get(key)?.trim() ?? "";
  if (p && pathIsInsideChatAttachments(p) && fs.existsSync(p)) {
    diskPath = p;
  }

  if (diskPath) {
    logToolInfo("stt", "child_start", { file_name: key, path_tail: diskPath.slice(-72), has_pcm: Boolean(clip) });
    const rPath = await transcribeAudioFileInChild({
      inputPath: diskPath,
      whisper,
      language: language ?? null,
      task: task ?? "transcribe",
    });
    if (rPath.ok) {
      logToolInfo("stt", "ok", { file_name: key, source: "child", chars: rPath.text.length });
      return { ok: true, text: rPath.text };
    }
    logToolInfo("stt", "fail", { file_name: key, source: "child", error: rPath.error });
    return { ok: false, error: rPath.error };
  }

  if (!clip) {
    const names = [...stagedByName.keys()];
    const hinted = [...(savedPathsByName?.keys() ?? [])];
    const hint = names.length ? ` Staged audio (this turn): ${names.join(", ")}.` : "";
    const hint2 = hinted.length ? ` Known saved names: ${hinted.join(", ")}.` : "";
    logToolInfo("stt", "skip", { key, staged: names.length, saved: hinted.length });
    return { ok: false, error: `No attachment named "${key}".${hint}${hint2}` };
  }
  const r = await transcribePcm({
    samples: clip.samples,
    sampleRate: clip.sampleRate,
    whisper,
    language: language ?? null,
    task: task ?? "transcribe",
    onProgress,
  });
  if (r.ok) {
    logToolInfo("stt", "ok", { file_name: key, chars: r.text.length });
    return { ok: true, text: r.text };
  }
  logToolInfo("stt", "fail", { file_name: key, error: r.error });
  return { ok: false, error: r.error };
}
