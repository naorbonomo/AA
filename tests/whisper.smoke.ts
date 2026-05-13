/** Smoke: ffmpeg + local Whisper on one file path (no LLM, no Electron). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializeSecretsStore } from "../services/secrets-store.js";
import { initializeSettingsStore, getResolvedSettings } from "../services/settings-store.js";
import { setWhisperCacheDir } from "../services/whisper-transformers.js";
import { ffmpegAvailable } from "../services/telegram-voice.js";
import { transcribeAudioFileWithFfmpeg } from "../services/whisper-transcribe-file.js";

function defaultUserDataDir(): string {
  const fromEnv = process.env.AA_USER_DATA?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "aa");
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const cfgRoot = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  return path.join(cfgRoot, "aa");
}

async function main(): Promise<void> {
  const ud = defaultUserDataDir();
  fs.mkdirSync(ud, { recursive: true });
  initializeSettingsStore({ userDataDir: ud });
  initializeSecretsStore({ userDataDir: ud });
  setWhisperCacheDir(path.join(ud, "whisper-models"));

  const arg = process.argv[2]?.trim();
  if (!arg) {
    process.stderr.write(
      "usage: tsx tests/whisper.smoke.ts <audio-file>\n  tip: AA_USER_DATA=… to match Electron (default: ~/.config/aa)\n",
    );
    process.exitCode = 2;
    return;
  }
  const audioPath = path.resolve(arg);
  if (!fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) {
    process.stderr.write(`not a file: ${audioPath}\n`);
    process.exitCode = 2;
    return;
  }

  process.stderr.write(`userData: ${ud}\nffmpeg: ${ffmpegAvailable() ? "yes" : "NO"}\nfile: ${audioPath}\n`);

  const r = await transcribeAudioFileWithFfmpeg({
    inputPath: audioPath,
    whisper: getResolvedSettings().whisper,
  });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  if (!r.ok) {
    process.exitCode = 1;
  }
}

void main();
