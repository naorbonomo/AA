/** Load/save merged `user-settings.json`; nested topics mirror `*_config.ts` + legacy flat keys. */

import fs from "node:fs";
import path from "node:path";

import * as agentDef from "../config/agent_config.js";
import { APP_TIME_ZONE_PRESETS } from "../config/app_time_config.js";
import * as llmDef from "../config/llm_config.js";
import * as loggingDef from "../config/logging_config.js";
import {
  DEFAULT_AGENT_PROMPT_KEY,
  SYSTEM_PROMPTS,
} from "../config/system_prompts.js";
import * as whisperDef from "../config/whisper_config.js";
import type {
  ResolvedAgent,
  ResolvedAppSettings,
  ResolvedLlm,
  ResolvedLogging,
  ResolvedTelegram,
  ResolvedWhisper,
  UserAgent,
  UserAppTime,
  UserLlm,
  UserLogging,
  UserSettings,
  UserTelegram,
  UserWhisper,
} from "../config/user-settings.js";
import { mergeResolvedAppTime } from "../utils/app-time.js";

let storeUserDataDir: string | null = null;
let cache: ResolvedAppSettings | null = null;

function aaRootFromCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

export function initializeSettingsStore(opts?: { userDataDir?: string }): void {
  storeUserDataDir = opts?.userDataDir?.trim() ? opts.userDataDir : null;
  cache = null;
  loadMergedFromDisk();
}

export function getSettingsFilePath(): string {
  if (storeUserDataDir) {
    return path.join(storeUserDataDir, "aa-user-settings.json");
  }
  return path.join(aaRootFromCwd(), "user-settings.json");
}

function readUserFileRaw(): unknown {
  const p = getSettingsFilePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** Normalize nested + migrate legacy flat keys. */
function normalizeDiskShape(raw: unknown): UserSettings {
  if (!raw || typeof raw !== "object" || raw === null) {
    return {};
  }
  const o = raw as Record<string, unknown>;

  const llm: UserLlm = {};
  if (typeof o.llm === "object" && o.llm !== null) {
    Object.assign(llm, o.llm as UserLlm);
  }

  const logging: UserLogging = {};
  if (typeof o.logging === "object" && o.logging !== null) {
    Object.assign(logging, o.logging as UserLogging);
  }

  const agent: UserAgent = {};
  if (typeof o.agent === "object" && o.agent !== null) {
    Object.assign(agent, o.agent as UserAgent);
  }

  if (typeof o.llmBaseUrl === "string") {
    llm.baseUrl = o.llmBaseUrl;
  }
  if (typeof o.llmModel === "string") {
    llm.model = o.llmModel;
  }
  if (typeof o.llmTemperature === "number" && Number.isFinite(o.llmTemperature)) {
    llm.temperature = o.llmTemperature;
  }
  if (typeof o.llmHttpTimeoutMs === "number" && Number.isFinite(o.llmHttpTimeoutMs)) {
    llm.httpTimeoutMs = o.llmHttpTimeoutMs;
  }
  if (typeof o.logToFile === "boolean") {
    logging.logToFile = o.logToFile;
  }
  if (typeof o.logToConsole === "boolean") {
    logging.logToConsole = o.logToConsole;
  }

  const appTime: UserAppTime = {};
  if (typeof o.appTime === "object" && o.appTime !== null) {
    const at = o.appTime as Record<string, unknown>;
    if (typeof at.timeZone === "string") {
      appTime.timeZone = at.timeZone;
    }
    if (typeof at.regionLabel === "string") {
      appTime.regionLabel = at.regionLabel;
    }
  }

  const whisper: UserWhisper = {};
  if (typeof o.whisper === "object" && o.whisper !== null) {
    const w = o.whisper as Record<string, unknown>;
    if (typeof w.modelSize === "string") {
      whisper.modelSize = w.modelSize as UserWhisper["modelSize"];
    }
    if (typeof w.quantized === "boolean") {
      whisper.quantized = w.quantized;
    }
    if (typeof w.multilingual === "boolean") {
      whisper.multilingual = w.multilingual;
    }
  }

  const telegram: UserTelegram = {};
  if (typeof o.telegram === "object" && o.telegram !== null) {
    const tg = o.telegram as Record<string, unknown>;
    if (typeof tg.usePolling === "boolean") {
      telegram.usePolling = tg.usePolling;
    }
    if (typeof tg.webhookPort === "number" && Number.isFinite(tg.webhookPort)) {
      telegram.webhookPort = Math.floor(tg.webhookPort);
    }
  }

  const out: UserSettings = {};
  if (Object.keys(llm).length) out.llm = llm;
  if (Object.keys(logging).length) out.logging = logging;
  if (Object.keys(agent).length) out.agent = agent;
  if (Object.keys(appTime).length) out.appTime = appTime;
  if (Object.keys(whisper).length) out.whisper = whisper;
  if (Object.keys(telegram).length) out.telegram = telegram;
  return out;
}

function stripSlash(u: string): string {
  return u.replace(/\/$/, "");
}

function mergeLlm(u: UserLlm | undefined): ResolvedLlm {
  const x = u ?? {};
  const inferred = llmDef.inferLlmProviderId(x);
  const preset =
    llmDef.getLlmProviderPreset(inferred) ??
    llmDef.getLlmProviderPreset(llmDef.LLM_DEFAULT_PROVIDER_ID)!;
  const base =
    x.baseUrl != null && String(x.baseUrl).trim() !== ""
      ? stripSlash(String(x.baseUrl).trim())
      : stripSlash(preset.defaultBaseUrl);
  const model =
    x.model != null && String(x.model).trim() !== ""
      ? String(x.model).trim()
      : preset.defaultModel;
  return {
    provider: preset.id,
    baseUrl: base,
    model,
    temperature:
      typeof x.temperature === "number" && Number.isFinite(x.temperature)
        ? x.temperature
        : llmDef.LLM_DEFAULT_TEMPERATURE,
    httpTimeoutMs:
      typeof x.httpTimeoutMs === "number" &&
      Number.isFinite(x.httpTimeoutMs) &&
      x.httpTimeoutMs > 0
        ? x.httpTimeoutMs
        : llmDef.LLM_DEFAULT_HTTP_TIMEOUT_MS,
    vision: x.vision === true,
  };
}

function mergeLogging(u: UserLogging | undefined): ResolvedLogging {
  const x = u ?? {};
  return {
    logToFile: x.logToFile ?? loggingDef.DEFAULT_LOG_TO_FILE,
    logToConsole: x.logToConsole ?? loggingDef.DEFAULT_LOG_TO_CONSOLE,
    logTools: x.logTools === true,
  };
}

function mergeAgent(u: UserAgent | undefined): ResolvedAgent {
  const x = u ?? {};
  const mr = x.maxToolRounds;
  const defaultLabel = agentDef.AGENT_DEFAULT_SESSION_LABEL_DEFAULT.trim();
  const rawPk = typeof x.promptKey === "string" ? x.promptKey.trim() : "";
  const promptKey =
    rawPk && Object.prototype.hasOwnProperty.call(SYSTEM_PROMPTS, rawPk) ? rawPk : DEFAULT_AGENT_PROMPT_KEY;
  let systemPrompt: string | undefined;
  if (typeof x.systemPrompt === "string") {
    const t = x.systemPrompt.trim();
    if (t.length) {
      systemPrompt = t.length > 100_000 ? t.slice(0, 100_000) : t;
    }
  }
  return {
    maxToolRounds:
      typeof mr === "number" && Number.isFinite(mr) && mr >= 1 && mr <= 500 ? Math.floor(mr) : agentDef.AGENT_RUN_MAX_TOOL_ROUNDS_DEFAULT,
    sessionLabel:
      x.sessionLabel !== undefined ? String(x.sessionLabel).trim() : defaultLabel,
    promptKey,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };
}

function mergeWhisper(u: UserWhisper | undefined): ResolvedWhisper {
  const x = u ?? {};
  const sz = x.modelSize;
  const modelSize = whisperDef.WHISPER_MODEL_SIZES.includes(sz as whisperDef.WhisperModelSize)
    ? (sz as whisperDef.WhisperModelSize)
    : whisperDef.WHISPER_DEFAULT_MODEL_SIZE;
  return {
    modelSize,
    quantized: x.quantized ?? whisperDef.WHISPER_DEFAULT_QUANTIZED,
    multilingual: x.multilingual ?? whisperDef.WHISPER_DEFAULT_MULTILINGUAL,
  };
}

function mergeTelegram(u: UserTelegram | undefined): ResolvedTelegram {
  const x = u ?? {};
  const wp = x.webhookPort;
  const webhookPort =
    typeof wp === "number" && Number.isFinite(wp) && wp > 0 && wp < 65536 ? Math.floor(wp) : 0;
  return {
    usePolling: x.usePolling !== false,
    webhookPort,
  };
}

function mergeUserWithDefaults(u: UserSettings): ResolvedAppSettings {
  return {
    llm: mergeLlm(u.llm),
    logging: mergeLogging(u.logging),
    agent: mergeAgent(u.agent),
    appTime: mergeResolvedAppTime(u.appTime),
    whisper: mergeWhisper(u.whisper),
    telegram: mergeTelegram(u.telegram),
  };
}

function loadMergedFromDisk(): ResolvedAppSettings {
  const raw = normalizeDiskShape(readUserFileRaw());
  const merged = mergeUserWithDefaults(raw);
  cache = merged;
  return merged;
}

export function getResolvedSettings(): ResolvedAppSettings {
  if (cache) {
    return cache;
  }
  return loadMergedFromDisk();
}

export function reloadSettingsFromDisk(): ResolvedAppSettings {
  cache = null;
  return loadMergedFromDisk();
}

function writeUserFileNested(u: UserSettings): void {
  const p = getSettingsFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(u, null, 2)}\n`, "utf8");
}

export function saveUserSettingsPatch(patch: Partial<UserSettings>): ResolvedAppSettings {
  const cur = normalizeDiskShape(readUserFileRaw());
  const next: UserSettings = {
    llm: { ...(cur.llm ?? {}), ...(patch.llm ?? {}) },
    logging: { ...(cur.logging ?? {}), ...(patch.logging ?? {}) },
    agent: { ...(cur.agent ?? {}), ...(patch.agent ?? {}) },
    appTime: { ...(cur.appTime ?? {}), ...(patch.appTime ?? {}) },
    whisper: { ...(cur.whisper ?? {}), ...(patch.whisper ?? {}) },
    telegram: { ...(cur.telegram ?? {}), ...(patch.telegram ?? {}) },
  };

  writeUserFileNested(trimEmptyBranches(next));

  cache = mergeUserWithDefaults(normalizeDiskShape(readUserFileRaw()));
  return cache;
}

function trimEmptyBranches(s: UserSettings): UserSettings {
  const out: UserSettings = {};
  if (s.llm && Object.keys(s.llm).length > 0) {
    out.llm = s.llm;
  }
  if (s.logging) {
    const lg: UserLogging = {};
    if (typeof s.logging.logToFile === "boolean") {
      lg.logToFile = s.logging.logToFile;
    }
    if (typeof s.logging.logToConsole === "boolean") {
      lg.logToConsole = s.logging.logToConsole;
    }
    if (typeof s.logging.logTools === "boolean") {
      lg.logTools = s.logging.logTools;
    }
    if (Object.keys(lg).length) {
      out.logging = lg;
    }
  }
  if (s.agent && Object.keys(s.agent).length > 0) {
    out.agent = s.agent;
  }
  if (s.appTime) {
    const cleaned: UserAppTime = {};
    if (typeof s.appTime.timeZone === "string" && s.appTime.timeZone.trim()) {
      cleaned.timeZone = s.appTime.timeZone.trim();
    }
    if (typeof s.appTime.regionLabel === "string" && s.appTime.regionLabel.trim()) {
      cleaned.regionLabel = s.appTime.regionLabel.trim();
    }
    if (Object.keys(cleaned).length) {
      out.appTime = cleaned;
    }
  }
  if (s.whisper) {
    const w: UserWhisper = {};
    if (whisperDef.WHISPER_MODEL_SIZES.includes(s.whisper.modelSize as whisperDef.WhisperModelSize)) {
      w.modelSize = s.whisper.modelSize as whisperDef.WhisperModelSize;
    }
    if (typeof s.whisper.quantized === "boolean") {
      w.quantized = s.whisper.quantized;
    }
    if (typeof s.whisper.multilingual === "boolean") {
      w.multilingual = s.whisper.multilingual;
    }
    if (Object.keys(w).length) {
      out.whisper = w;
    }
  }
  if (s.telegram) {
    const tg: UserTelegram = {};
    if (typeof s.telegram.usePolling === "boolean") {
      tg.usePolling = s.telegram.usePolling;
    }
    if (typeof s.telegram.webhookPort === "number" && Number.isFinite(s.telegram.webhookPort)) {
      const p = Math.floor(s.telegram.webhookPort);
      if (p > 0 && p < 65536) {
        tg.webhookPort = p;
      }
    }
    if (Object.keys(tg).length) {
      out.telegram = tg;
    }
  }
  return out;
}

export function resetUserSettingsFile(): ResolvedAppSettings {
  writeUserFileNested({});
  cache = mergeUserWithDefaults({});
  return cache;
}

export function getSettingsSnapshot(): {
  resolved: ResolvedAppSettings;
  filePath: string;
  user: UserSettings;
  timeZonePresets: typeof APP_TIME_ZONE_PRESETS;
  llmProviders: readonly llmDef.LlmProviderPreset[];
} {
  const user = normalizeDiskShape(readUserFileRaw());
  return {
    resolved: getResolvedSettings(),
    filePath: getSettingsFilePath(),
    user,
    timeZonePresets: [...APP_TIME_ZONE_PRESETS],
    llmProviders: llmDef.LLM_PROVIDERS,
  };
}
