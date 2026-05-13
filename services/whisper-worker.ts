/** Child-process entrypoint for Whisper. Native ONNX crashes must not kill Electron main. */

import fs from "node:fs";

import type { ResolvedWhisper } from "../config/user-settings.js";
import { setWhisperCacheDir } from "./whisper-transformers.js";
import { transcribeAudioFileWithFfmpeg } from "./whisper-transcribe-file.js";

type WorkerRequest = {
  inputPath: string;
  responsePath: string;
  cacheDir?: string | null;
  whisper: ResolvedWhisper;
  language?: string | null;
  task?: "transcribe" | "translate";
};

function parseRequest(raw: unknown): WorkerRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("request must be object");
  }
  const o = raw as Record<string, unknown>;
  const inputPath = typeof o.inputPath === "string" ? o.inputPath.trim() : "";
  const responsePath = typeof o.responsePath === "string" ? o.responsePath.trim() : "";
  if (!inputPath) throw new Error("inputPath required");
  if (!responsePath) throw new Error("responsePath required");
  if (!o.whisper || typeof o.whisper !== "object") throw new Error("whisper required");
  const task = o.task === "translate" || o.task === "transcribe" ? o.task : undefined;
  return {
    inputPath,
    responsePath,
    cacheDir: typeof o.cacheDir === "string" ? o.cacheDir : null,
    whisper: o.whisper as ResolvedWhisper,
    language: typeof o.language === "string" ? o.language : null,
    task,
  };
}

async function main(): Promise<void> {
  const requestFile = process.argv[2] ?? "";
  if (!requestFile) {
    throw new Error("usage: whisper-worker <request-json-file>");
  }
  const req = parseRequest(JSON.parse(fs.readFileSync(requestFile, "utf8")) as unknown);
  if (req.cacheDir) {
    setWhisperCacheDir(req.cacheDir);
  }
  const result = await transcribeAudioFileWithFfmpeg({
    inputPath: req.inputPath,
    whisper: req.whisper,
    language: req.language,
    task: req.task ?? "transcribe",
  });
  fs.writeFileSync(req.responsePath, `${JSON.stringify(result)}\n`, "utf8");
  process.exitCode = result.ok ? 0 : 1;
}

void main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`whisper-worker error: ${msg}\n`);
  process.exitCode = 1;
});
