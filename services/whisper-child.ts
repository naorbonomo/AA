/** Run Whisper in a child process so native ONNX SIGTRAP/SIGABRT cannot crash Electron. */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedWhisper } from "../config/user-settings.js";
import { getWhisperCacheDir } from "./whisper-transformers.js";

const WORKER_TIMEOUT_MS = 15 * 60_000;

function tmpJsonPath(label: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return path.join(os.tmpdir(), `aa-${label}-${suffix}.json`);
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function nodeBinary(): string {
  const explicit = process.env.AA_NODE_BINARY?.trim();
  if (explicit) return explicit;
  const npmNode = process.env.npm_node_execpath?.trim();
  if (npmNode) return npmNode;
  return "node";
}

export async function transcribeAudioFileInChild(opts: {
  inputPath: string;
  whisper: ResolvedWhisper;
  language?: string | null;
  task?: "transcribe" | "translate";
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "whisper-worker.js");
  const requestPath = tmpJsonPath("whisper-request");
  const responsePath = tmpJsonPath("whisper-response");
  const req = {
    inputPath: opts.inputPath,
    responsePath,
    cacheDir: getWhisperCacheDir(),
    whisper: opts.whisper,
    language: opts.language ?? null,
    task: opts.task ?? "transcribe",
  };
  fs.writeFileSync(requestPath, `${JSON.stringify(req)}\n`, "utf8");

  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const child = spawn(nodeBinary(), [workerPath, requestPath], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const finish = (result: { ok: true; text: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      safeUnlink(requestPath);
      safeUnlink(responsePath);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: "Whisper worker timed out" });
    }, WORKER_TIMEOUT_MS);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on("error", (e) => {
      finish({ ok: false, error: `Whisper worker failed to start: ${e.message}` });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      try {
        const raw = fs.readFileSync(responsePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === true) {
          const text = (parsed as { text?: unknown }).text;
          finish({ ok: true, text: typeof text === "string" ? text : "" });
          return;
        }
        const err = (parsed as { error?: unknown }).error;
        finish({ ok: false, error: typeof err === "string" ? err : "Whisper worker failed" });
        return;
      } catch {
        const exit = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
        const tail = stderr.trim() ? `: ${stderr.trim().slice(-1200)}` : "";
        finish({ ok: false, error: `Whisper worker crashed (${exit})${tail}` });
      }
    });
  });
}
