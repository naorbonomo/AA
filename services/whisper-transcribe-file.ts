/** One-shot: ffmpeg decode file → local Whisper (CLI / smoke; same path as Telegram voice). */

import fs from "node:fs";

import type { ResolvedWhisper } from "../config/user-settings.js";
import { decodeAudioFileTo16kMonoFloat, ffmpegAvailable } from "./telegram-voice.js";
import { transcribePcm } from "./whisper-transformers.js";

export async function transcribeAudioFileWithFfmpeg(opts: {
  inputPath: string;
  whisper: ResolvedWhisper;
  language?: string | null;
  task?: "transcribe" | "translate";
  onProgress?: (status: unknown) => void;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const p = opts.inputPath.trim();
  if (!p) {
    return { ok: false, error: "inputPath empty" };
  }
  if (!fs.existsSync(p)) {
    return { ok: false, error: `file not found: ${p}` };
  }
  if (!ffmpegAvailable()) {
    return { ok: false, error: "ffmpeg not on PATH" };
  }
  const pcm = decodeAudioFileTo16kMonoFloat(p);
  if (!pcm) {
    return { ok: false, error: "ffmpeg decode failed (see aa.log / telegram-voice stderr)" };
  }
  return transcribePcm({
    samples: pcm.samples,
    sampleRate: pcm.sampleRate,
    whisper: opts.whisper,
    language: opts.language,
    task: opts.task ?? "transcribe",
    onProgress: opts.onProgress,
  });
}
