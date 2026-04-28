/** Local Whisper via Transformers.js (@xenova/transformers) + ONNX in Electron main. */

import path from "node:path";

import type { AutomaticSpeechRecognitionPipeline } from "@xenova/transformers";
import type { ResolvedWhisper } from "../config/user-settings.js";

let cacheDir: string | null = null;

export function setWhisperCacheDir(absDir: string): void {
  cacheDir = path.resolve(absDir);
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return fromRate === toRate ? input : new Float32Array(0);
  }
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const x = i * ratio;
    const x0 = Math.floor(x);
    const x1 = Math.min(x0 + 1, input.length - 1);
    const t = x - x0;
    out[i] = input[x0]! * (1 - t) + input[x1]! * t;
  }
  return out;
}

export function to16kMono(samples: Float32Array, sampleRate: number): Float32Array {
  return resampleLinear(samples, sampleRate, 16_000);
}

export function whisperHfModelId(r: ResolvedWhisper): { modelId: string; revision: string } {
  let modelId = `Xenova/whisper-${r.modelSize}`;
  if (!r.multilingual) {
    modelId += ".en";
  }
  const revision = r.modelSize === "medium" ? "no_attentions" : "main";
  return { modelId, revision };
}

function extractText(out: unknown): string {
  if (out && typeof out === "object" && "text" in out) {
    const t = (out as { text?: unknown }).text;
    if (typeof t === "string") {
      return t.trim();
    }
  }
  return String(out ?? "").trim();
}

let pipeKey = "";
let asrPipe: AutomaticSpeechRecognitionPipeline | null = null;

export async function transcribePcm(opts: {
  samples: Float32Array;
  sampleRate: number;
  whisper: ResolvedWhisper;
  language?: string | null;
  task?: "transcribe" | "translate";
  onProgress?: (status: unknown) => void;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const { samples, sampleRate, whisper, language, task, onProgress } = opts;
  try {
    const { pipeline, env } = await import("@xenova/transformers");
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }

    const pcm = to16kMono(samples, sampleRate);
    if (pcm.length === 0) {
      return { ok: false, error: "empty audio" };
    }

    const { modelId, revision } = whisperHfModelId(whisper);
    const key = `${modelId}|${revision}|${whisper.quantized ? "q" : "fp"}`;
    if (pipeKey !== key && asrPipe) {
      await asrPipe.dispose();
      asrPipe = null;
      pipeKey = "";
    }

    if (!asrPipe) {
      asrPipe = await pipeline("automatic-speech-recognition", modelId, {
        quantized: whisper.quantized,
        revision,
        progress_callback: onProgress ?? undefined,
      });
      pipeKey = key;
    }

    const gen: {
      chunk_length_s: number;
      stride_length_s: number;
      return_timestamps: boolean;
      language?: string;
      task?: string;
    } = {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    };
    const lang = typeof language === "string" ? language.trim() : "";
    if (lang) {
      gen.language = lang;
    }
    gen.task = task ?? "transcribe";

    const out = await asrPipe(pcm, gen);
    return { ok: true, text: extractText(out) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
