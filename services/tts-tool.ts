/** OpenAI-function `tts`: local Transformers.js VITS (English); tool JSON stays small (no audio bytes). */

import { synthesizeTtsPcm } from "./tts-transformers.js";

export const ttsOpenAiTool = {
  type: "function" as const,
  function: {
    name: "tts",
    description:
      "Text-to-speech: synthesize short spoken audio from text (local on-device model, English). Use when user asks to hear text read aloud or wants audio output. Keep passages concise (~1–3 sentences per call when possible). Returns compact JSON: ok, duration_seconds, sample_rate — do not read file paths or technical ids to the user; say you played or generated speech when ok is true.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Words to speak. Plain text; no SSML.",
        },
      },
      required: ["text"],
    },
  },
};

export type TtsToolLlmPayload =
  | { ok: true; duration_seconds: number; sample_rate: number }
  | { ok: false; error: string };

/** Optional playback in UI (not sent to model). */
export type TtsToolUiExtra = {
  dataUrl: string;
};

function parseArgs(raw: string | undefined): { text?: string } {
  if (!raw || typeof raw !== "string") {
    return {};
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const t = typeof o.text === "string" ? o.text.trim() : "";
    return { text: t || undefined };
  } catch {
    return {};
  }
}

export async function executeTtsTool(rawArgs: string): Promise<{
  llm: TtsToolLlmPayload;
  ui?: TtsToolUiExtra;
}> {
  const { text } = parseArgs(rawArgs);
  if (!text) {
    return { llm: { ok: false, error: "text required" } };
  }

  const syn = await synthesizeTtsPcm({ text });
  if (!syn.ok) {
    return { llm: { ok: false, error: syn.error } };
  }

  const b64 = syn.wav.toString("base64");
  const dataUrl = `data:audio/wav;base64,${b64}`;
  return {
    llm: {
      ok: true,
      duration_seconds: Math.round(syn.durationSec * 100) / 100,
      sample_rate: syn.sampleRate,
    },
    ui: { dataUrl },
  };
}
