/** Local TTS via Transformers.js (@xenova/transformers) + ONNX — English VITS (no speaker embedding file). */

import path from "node:path";

import type { TextToAudioPipeline } from "@xenova/transformers";

/** Facebook MMS English; small VITS checkpoint, runs on CPU via ONNX (Win/macOS/Linux). */
export const DEFAULT_TTS_MODEL_ID = "Xenova/mms-tts-eng";

let cacheDir: string | null = null;

export function setTtsCacheDir(absDir: string): void {
  cacheDir = path.resolve(absDir);
}

const MAX_INPUT_CHARS = 2_500;

let pipeKey = "";
let ttsPipe: TextToAudioPipeline | null = null;

function floatTo16BitPcm(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
  }
  return out;
}

/** Mono 16-bit PCM WAV. */
export function pcm16MonoToWavBuffer(pcm: Int16Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i += 1) {
    buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  }
  return buf;
}

function toFloat32Audio(raw: unknown): Float32Array | null {
  if (raw instanceof Float32Array) {
    return raw;
  }
  if (raw && typeof raw === "object" && "data" in raw) {
    const d = (raw as { data?: unknown }).data;
    if (d instanceof Float32Array) {
      return d;
    }
  }
  return null;
}

export async function synthesizeTtsPcm(opts: {
  text: string;
  modelId?: string;
  quantized?: boolean;
  onProgress?: (status: unknown) => void;
}): Promise<
  | { ok: true; wav: Buffer; sampleRate: number; durationSec: number }
  | { ok: false; error: string }
> {
  const trimmed = opts.text.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return { ok: false, error: "empty text" };
  }
  if (trimmed.length > MAX_INPUT_CHARS) {
    return { ok: false, error: `text too long (max ${MAX_INPUT_CHARS} chars)` };
  }

  const modelId = opts.modelId?.trim() || DEFAULT_TTS_MODEL_ID;
  const quantized = opts.quantized !== false;

  try {
    const { pipeline, env } = await import("@xenova/transformers");
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }

    const key = `${modelId}|${quantized ? "q" : "fp"}`;
    if (pipeKey !== key && ttsPipe) {
      await ttsPipe.dispose();
      ttsPipe = null;
      pipeKey = "";
    }

    if (!ttsPipe) {
      ttsPipe = await pipeline("text-to-speech", modelId, {
        quantized,
        progress_callback: opts.onProgress ?? undefined,
      });
      pipeKey = key;
    }

    const out = await ttsPipe(trimmed, {});
    if (!out || typeof out !== "object") {
      return { ok: false, error: "unexpected TTS output" };
    }
    const o = out as { audio?: unknown; sampling_rate?: unknown };
    const audio = toFloat32Audio(o.audio);
    const sr = typeof o.sampling_rate === "number" && Number.isFinite(o.sampling_rate) ? o.sampling_rate : 0;
    if (!audio || audio.length === 0 || sr <= 0) {
      return { ok: false, error: "no audio in TTS output" };
    }

    const pcm = floatTo16BitPcm(audio);
    const wav = pcm16MonoToWavBuffer(pcm, sr);
    const durationSec = pcm.length / sr;
    return { ok: true, wav, sampleRate: sr, durationSec };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
