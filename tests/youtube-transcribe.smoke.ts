/** Smoke: `youtube_transcribe` execute (no LLM). Args: URL [auto|youtube|whisper]. Omit mode → default auto (captions then Whisper). */

import { initializeSecretsStore } from "../services/secrets-store.js";
import { initializeSettingsStore, getResolvedSettings } from "../services/settings-store.js";
import { executeYoutubeTranscribeTool } from "../services/youtube-transcribe-tool.js";

async function main(): Promise<void> {
  const ud = typeof process.env.AA_USER_DATA === "string" ? process.env.AA_USER_DATA.trim() : "";
  initializeSettingsStore(ud ? { userDataDir: ud } : undefined);
  initializeSecretsStore(ud ? { userDataDir: ud } : undefined);

  const argv = process.argv.slice(2);
  const modeArg = argv[argv.length - 1];
  const modes = new Set(["auto", "youtube", "whisper"]);
  const hasMode = modes.has(modeArg);
  const urlArg = hasMode ? argv.slice(0, -1).join(" ").trim() : argv.join(" ").trim();
  const url = urlArg || "https://www.youtube.com/watch?v=jNQXAC9IVRw";

  const whisper = getResolvedSettings().whisper;
  const payload: Record<string, unknown> = { url };
  if (hasMode) {
    payload.transcript_source = modeArg;
  }
  const rawArgs = JSON.stringify(payload);
  const out = await executeYoutubeTranscribeTool({ rawArgs, whisper });
  console.log(JSON.stringify(out, null, 2));
  if (!out.ok) {
    process.exitCode = 1;
  }
}

void main();
