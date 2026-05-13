/** Download Telegram voice/docs; decode to 16k mono f32le via ffmpeg for `transcribePcm`. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TELEGRAM_API_BASE } from "../config/telegram_config.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("telegram-voice");

const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Chat attach: max bytes passed to ffmpeg temp decode (parity with Telegram download cap). */
export const MAX_CHAT_AUDIO_ATTACH_BYTES = 25 * 1024 * 1024;

export function ffmpegAvailable(): boolean {
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return r.status === 0;
}

export async function telegramGetFilePath(token: string, fileId: string): Promise<string> {
  const u = `${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(u);
  if (!res.ok) {
    throw new Error(`getFile ${res.status}`);
  }
  const data = (await res.json()) as { ok?: unknown; result?: { file_path?: string } };
  if (data.ok !== true || !data.result?.file_path || typeof data.result.file_path !== "string") {
    throw new Error("getFile: bad response");
  }
  return data.result.file_path;
}

export async function downloadTelegramFileBytes(
  token: string,
  filePath: string,
  maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
): Promise<Buffer> {
  const url = `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`file download ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new Error("file too large");
  }
  return Buffer.from(ab);
}

/**
 * Writes bytes to a temp file (basename-safe name + extension) and runs {@link decodeAudioFileTo16kMonoFloat}.
 * For WhatsApp / Telegram exports: `.opus` is usually Ogg+Opus; ffmpeg probes container from content.
 */
export function decodeAudioBytesTo16kMonoFloat(
  bytes: Buffer,
  fileName: string,
): { samples: Float32Array; sampleRate: number } | null {
  if (!bytes.length || !ffmpegAvailable()) {
    return null;
  }
  const base = path.basename(fileName || "audio.bin").replace(/\0/g, "") || "audio.bin";
  const extMatch = /\.[a-z0-9]+$/i.exec(base);
  const ext = extMatch ? extMatch[0] : ".bin";
  const tmpIn = path.join(
    os.tmpdir(),
    `aa-chat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`,
  );
  try {
    fs.writeFileSync(tmpIn, bytes);
    return decodeAudioFileTo16kMonoFloat(tmpIn);
  } catch (e) {
    log.warn("decodeAudioBytes temp write", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    safeUnlink(tmpIn);
  }
}

/** ffmpeg → 16 kHz mono 32-bit float LE (Whisper path resamples internally but 16k is standard). */
export function decodeAudioFileTo16kMonoFloat(inputPath: string): { samples: Float32Array; sampleRate: number } | null {
  const outPath = `${inputPath}.aa-f32.raw`;
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", inputPath, "-f", "f32le", "-ac", "1", "-ar", "16000", outPath],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    log.warn("ffmpeg decode failed", { stderr: String(r.stderr || "").slice(0, 400) });
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    return null;
  }
  try {
    const buf = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    const len = Math.floor(buf.length / 4);
    if (len < 1) {
      return null;
    }
    const samples = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      samples[i] = buf.readFloatLE(i * 4);
    }
    return { samples, sampleRate: 16_000 };
  } catch (e) {
    log.warn("read ffmpeg output", e instanceof Error ? e.message : String(e));
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export function tempTelegramVoicePath(chatId: number, messageId: number, ext: string): string {
  const e = ext.startsWith(".") ? ext : `.${ext}`;
  const base = `aa-tg-${chatId}-${messageId}${e}`;
  return path.join(os.tmpdir(), base);
}

/**
 * PCM WAV bytes → OGG Opus (Telegram `sendVoice`). Mirrors Smith `bot._wav_to_ogg`.
 * Returns null if ffmpeg missing or conversion fails.
 */
export function wavBytesToOggOpus(wav: Buffer): Buffer | null {
  if (!ffmpegAvailable() || !wav.length) {
    return null;
  }
  const base = `aa-tts-ogg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const wavPath = path.join(os.tmpdir(), `${base}.wav`);
  const oggPath = path.join(os.tmpdir(), `${base}.ogg`);
  try {
    fs.writeFileSync(wavPath, wav);
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-i", wavPath, "-c:a", "libopus", "-b:a", "64k", oggPath],
      { encoding: "utf8", maxBuffer: 25 * 1024 * 1024, timeout: 120_000 },
    );
    if (r.status !== 0) {
      log.warn("ffmpeg wav→ogg", { stderr: String(r.stderr || "").slice(0, 400) });
      return null;
    }
    if (!fs.existsSync(oggPath) || fs.statSync(oggPath).size < 1) {
      return null;
    }
    return fs.readFileSync(oggPath);
  } catch (e) {
    log.warn("wavBytesToOggOpus", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    safeUnlink(wavPath);
    safeUnlink(oggPath);
  }
}
