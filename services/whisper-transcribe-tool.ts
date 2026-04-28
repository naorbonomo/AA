/** OpenAI-function `stt`: local Whisper, staged PCM keyed by attachment file name (Smith-style name; no disk path). */

import type { ResolvedWhisper } from "../config/user-settings.js";
import { transcribePcm } from "./whisper-transformers.js";

export const sttOpenAiTool = {
  type: "function" as const,
  function: {
    name: "stt",
    description:
      "Speech-to-text: transcribe a user-attached audio file to plain text (local Whisper). Only works for files listed in the user’s “Attached files” block this turn. Pass file_name exactly as shown (same spelling and case). Returns { ok, text } on success.",
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
  whisper: ResolvedWhisper;
  onProgress?: (status: unknown) => void;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const { rawArgs, stagedByName, whisper, onProgress } = opts;
  const { file_name, language, task } = parseArgs(rawArgs);
  const key = file_name ?? "";
  if (!key) {
    return { ok: false, error: "file_name required" };
  }
  const clip = stagedByName.get(key);
  if (!clip) {
    const names = [...stagedByName.keys()];
    const hint = names.length ? ` Staged audio: ${names.join(", ")}.` : " No audio staged for this turn.";
    return { ok: false, error: `No attachment named "${key}".${hint}` };
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
    return { ok: true, text: r.text };
  }
  return { ok: false, error: r.error };
}
