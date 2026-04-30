/** Agent `youtube_transcribe`: YouTube captions (trust platform text) vs download + local Whisper. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchTranscript } from "youtube-transcript";

import type { ResolvedWhisper } from "../config/user-settings.js";
import { decodeAudioFileTo16kMonoFloat, ffmpegAvailable } from "./telegram-voice.js";
import { transcribePcm } from "./whisper-transformers.js";
import { logToolInfo } from "../utils/logger.js";

export const youtubeTranscribeOpenAiTool = {
  type: "function" as const,
  function: {
    name: "youtube_transcribe",
    description:
      "Get plain text from a YouTube video. transcript_source `auto` (default when omitted): try YouTube captions first (no yt-dlp), then fall back to local Whisper if captions missing (needs yt-dlp + ffmpeg). `youtube` = captions only. `whisper` = always download + Whisper. Pass full watch or youtu.be URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full YouTube URL (watch, youtu.be, shorts) or 11-char video id.",
        },
        transcript_source: {
          type: "string",
          enum: ["auto", "whisper", "youtube"],
          description:
            "Optional; default auto. auto = captions then Whisper fallback. youtube = platform captions only. whisper = always local ASR (yt-dlp + ffmpeg).",
        },
        language: {
          type: "string",
          description:
            'Optional ISO-639-1 language for captions (e.g. "en"). Whisper: passed as hint when set.',
        },
        max_duration_seconds: {
          type: "number",
          description:
            "Whisper mode only: refuse if video duration exceeds this (default 7200). Caps RAM/time for long uploads.",
        },
      },
      required: ["url"],
    },
  },
};

const DEFAULT_MAX_DURATION_SEC = 7200;

const YOUTUBE_ID_RE =
  /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([^"&?/\s]{11})/i;

export function extractYoutubeVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) {
    return s;
  }
  const m = s.match(YOUTUBE_ID_RE);
  return m?.[1] ?? null;
}

export function ytdlpAvailable(): boolean {
  const r = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

export type YoutubeTranscriptSourceMode = "auto" | "whisper" | "youtube";

function parseArgs(raw: string): {
  url: string;
  transcript_source: YoutubeTranscriptSourceMode;
  language?: string;
  max_duration_seconds?: number;
} {
  const o = JSON.parse(raw) as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  const ts = o.transcript_source;
  const transcript_source: YoutubeTranscriptSourceMode =
    ts === "youtube" || ts === "whisper" || ts === "auto" ? ts : "auto";
  const language = typeof o.language === "string" ? o.language.trim() : undefined;
  const md = o.max_duration_seconds !== undefined ? Number(o.max_duration_seconds) : undefined;
  return {
    url,
    transcript_source,
    ...(language ? { language } : {}),
    ...(Number.isFinite(md) && md! > 0 ? { max_duration_seconds: md } : {}),
  };
}

function joinCaptionPieces(
  parts: Array<{ text: string; offset?: number; duration?: number }>,
): string {
  return parts
    .map((p) => (typeof p.text === "string" ? p.text.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function findDownloadedFile(outBase: string): string | null {
  const dir = path.dirname(outBase);
  const prefix = path.basename(outBase) + ".";
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((f) => f.startsWith(prefix) && !f.endsWith(".part"));
  return hit ? path.join(dir, hit) : null;
}

function ytDlpDurationSeconds(videoUrl: string): number | null {
  const r = spawnSync(
    "yt-dlp",
    ["--no-warnings", "--quiet", "--no-playlist", "--print", "%(duration)s", videoUrl],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 },
  );
  if (r.status !== 0) {
    return null;
  }
  const line = String(r.stdout ?? "")
    .trim()
    .split("\n")[0];
  const n = Number(line);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function downloadYoutubeBestAudio(videoUrl: string): Promise<{ path: string; cleanup: () => void }> {
  const outBase = path.join(
    os.tmpdir(),
    `aa-yt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const template = `${outBase}.%(ext)s`;
  const r = spawnSync(
    "yt-dlp",
    [
      "-f",
      "bestaudio/best",
      "-o",
      template,
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      videoUrl,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 600_000 },
  );
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || "yt-dlp failed").slice(0, 500);
    throw new Error(err);
  }
  const p = findDownloadedFile(outBase);
  if (!p || !fs.existsSync(p)) {
    throw new Error("yt-dlp finished but output file not found");
  }
  return {
    path: p,
    cleanup: () => {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    },
  };
}

export type YoutubeTranscribeResult =
  | {
      ok: true;
      text: string;
      transcript_source: YoutubeTranscriptSourceMode;
      video_id: string;
      /** whisper | youtube_captions */
      backend: "whisper" | "youtube_captions";
    }
  | {
      ok: false;
      error: string;
      transcript_source?: YoutubeTranscriptSourceMode;
      video_id?: string;
    };

async function tryYoutubeCaptions(
  videoId: string,
  vUrl: string,
  language?: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const cfg = language ? { lang: language } : undefined;
    const parts = await fetchTranscript(vUrl, cfg);
    const text = joinCaptionPieces(parts);
    if (!text) {
      logToolInfo("youtube_transcribe", "fail", { videoId, mode: "youtube", note: "empty" });
      return {
        ok: false,
        error:
          "YouTube returned empty caption text — captions may be off or unavailable",
      };
    }
    logToolInfo("youtube_transcribe", "ok", { videoId, mode: "youtube", chars: text.length });
    return { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logToolInfo("youtube_transcribe", "fail", { videoId, mode: "youtube", error: msg.slice(0, 200) });
    return { ok: false, error: msg.slice(0, 400) };
  }
}

async function runWhisperTranscribePath(opts: {
  videoId: string;
  vUrl: string;
  language?: string | null;
  maxDur: number;
  whisper: ResolvedWhisper;
  onProgress?: (status: unknown) => void;
}): Promise<YoutubeTranscribeResult> {
  const { videoId, vUrl, language, maxDur, whisper, onProgress } = opts;
  if (!ytdlpAvailable()) {
    return {
      ok: false,
      error:
        "local Whisper path needs `yt-dlp` on PATH (https://github.com/yt-dlp/yt-dlp). Install, restart app, retry.",
      transcript_source: "whisper",
      video_id: videoId,
    };
  }
  if (!ffmpegAvailable()) {
    return {
      ok: false,
      error:
        "local Whisper path needs `ffmpeg` on PATH (https://ffmpeg.org/) to decode audio after download.",
      transcript_source: "whisper",
      video_id: videoId,
    };
  }

  const dur = ytDlpDurationSeconds(vUrl);
  if (dur !== null && dur > maxDur) {
    return {
      ok: false,
      error: `video duration ~${Math.round(dur)}s exceeds max_duration_seconds=${maxDur}`,
      transcript_source: "whisper",
      video_id: videoId,
    };
  }

  let cleanup: (() => void) | undefined;
  try {
    const dl = await downloadYoutubeBestAudio(vUrl);
    cleanup = dl.cleanup;
    const pcm = decodeAudioFileTo16kMonoFloat(dl.path);
    if (!pcm) {
      return {
        ok: false,
        error: "ffmpeg could not decode downloaded audio",
        transcript_source: "whisper",
        video_id: videoId,
      };
    }
    const tr = await transcribePcm({
      samples: pcm.samples,
      sampleRate: pcm.sampleRate,
      whisper,
      language: language ?? null,
      task: "transcribe",
      onProgress,
    });
    if (!tr.ok) {
      logToolInfo("youtube_transcribe", "fail", { videoId, mode: "whisper", error: tr.error });
      return { ok: false, error: tr.error, transcript_source: "whisper", video_id: videoId };
    }
    logToolInfo("youtube_transcribe", "ok", { videoId, mode: "whisper", chars: tr.text.length });
    return {
      ok: true,
      text: tr.text,
      transcript_source: "whisper",
      video_id: videoId,
      backend: "whisper",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logToolInfo("youtube_transcribe", "fail", { videoId, mode: "whisper", error: msg.slice(0, 200) });
    return { ok: false, error: msg.slice(0, 500), transcript_source: "whisper", video_id: videoId };
  } finally {
    cleanup?.();
  }
}

export async function executeYoutubeTranscribeTool(opts: {
  rawArgs: string;
  whisper: ResolvedWhisper;
  onProgress?: (status: unknown) => void;
}): Promise<YoutubeTranscribeResult> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(opts.rawArgs);
  } catch {
    logToolInfo("youtube_transcribe", "skip", { reason: "bad JSON" });
    return { ok: false, error: "invalid tool arguments JSON" };
  }

  const { url, transcript_source, language } = parsed;
  const maxDur = parsed.max_duration_seconds ?? DEFAULT_MAX_DURATION_SEC;

  if (!url) {
    logToolInfo("youtube_transcribe", "skip", { reason: "url required" });
    return { ok: false, error: "url required", transcript_source };
  }

  const videoId = extractYoutubeVideoId(url);
  if (!videoId) {
    logToolInfo("youtube_transcribe", "skip", { reason: "not a YouTube url" });
    return { ok: false, error: "could not parse YouTube video id from url", transcript_source };
  }

  const vUrl =
    url.includes("http://") || url.includes("https://")
      ? url
      : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  if (transcript_source === "youtube") {
    const cap = await tryYoutubeCaptions(videoId, vUrl, language);
    if (cap.ok) {
      return {
        ok: true,
        text: cap.text,
        transcript_source: "youtube",
        video_id: videoId,
        backend: "youtube_captions",
      };
    }
    return {
      ok: false,
      error: `${cap.error} — use transcript_source auto or whisper if Whisper + yt-dlp available`,
      transcript_source: "youtube",
      video_id: videoId,
    };
  }

  if (transcript_source === "whisper") {
    return runWhisperTranscribePath({
      videoId,
      vUrl,
      language,
      maxDur,
      whisper: opts.whisper,
      onProgress: opts.onProgress,
    });
  }

  const cap = await tryYoutubeCaptions(videoId, vUrl, language);
  if (cap.ok) {
    return {
      ok: true,
      text: cap.text,
      transcript_source: "auto",
      video_id: videoId,
      backend: "youtube_captions",
    };
  }
  logToolInfo("youtube_transcribe", "auto_fallback", {
    videoId,
    captionErr: cap.error.slice(0, 160),
  });
  const w = await runWhisperTranscribePath({
    videoId,
    vUrl,
    language,
    maxDur,
    whisper: opts.whisper,
    onProgress: opts.onProgress,
  });
  if (w.ok) {
    return { ...w, transcript_source: "auto" };
  }
  return {
    ok: false,
    error: `Captions failed (${cap.error}). Whisper fallback: ${w.error}`,
    transcript_source: "auto",
    video_id: videoId,
  };
}
