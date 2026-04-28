/** Load/save merged `user-settings.json`; nested topics mirror `*_config.ts` + legacy flat keys. */

import fs from "node:fs";
import path from "node:path";

import * as agentDef from "../config/agent_config.js";
import * as llmDef from "../config/llm_config.js";
import * as loggingDef from "../config/logging_config.js";
import type {
  ResolvedAgent,
  ResolvedAppSettings,
  ResolvedLlm,
  ResolvedLogging,
  UserAgent,
  UserLlm,
  UserLogging,
  UserSettings,
} from "../config/user-settings.js";

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

  const out: UserSettings = {};
  if (Object.keys(llm).length) out.llm = llm;
  if (Object.keys(logging).length) out.logging = logging;
  if (Object.keys(agent).length) out.agent = agent;
  return out;
}

function stripSlash(u: string): string {
  return u.replace(/\/$/, "");
}

function mergeLlm(u: UserLlm | undefined): ResolvedLlm {
  const x = u ?? {};
  const base =
    x.baseUrl != null && String(x.baseUrl).trim() !== ""
      ? stripSlash(String(x.baseUrl).trim())
      : stripSlash(llmDef.LLM_DEFAULT_BASE_URL);
  return {
    baseUrl: base,
    model:
      x.model != null && String(x.model).trim() !== ""
        ? String(x.model).trim()
        : llmDef.LLM_DEFAULT_MODEL,
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
  };
}

function mergeLogging(u: UserLogging | undefined): ResolvedLogging {
  const x = u ?? {};
  return {
    logToFile: x.logToFile ?? loggingDef.DEFAULT_LOG_TO_FILE,
    logToConsole: x.logToConsole ?? loggingDef.DEFAULT_LOG_TO_CONSOLE,
  };
}

function mergeAgent(u: UserAgent | undefined): ResolvedAgent {
  const x = u ?? {};
  const mr = x.maxToolRounds;
  const defaultLabel = agentDef.AGENT_DEFAULT_SESSION_LABEL_DEFAULT.trim();
  return {
    maxToolRounds:
      typeof mr === "number" && Number.isFinite(mr) && mr >= 1 && mr <= 500 ? Math.floor(mr) : agentDef.AGENT_RUN_MAX_TOOL_ROUNDS_DEFAULT,
    sessionLabel:
      x.sessionLabel !== undefined ? String(x.sessionLabel).trim() : defaultLabel,
  };
}

function mergeUserWithDefaults(u: UserSettings): ResolvedAppSettings {
  return {
    llm: mergeLlm(u.llm),
    logging: mergeLogging(u.logging),
    agent: mergeAgent(u.agent),
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
  if (s.logging && Object.keys(s.logging).length > 0) {
    out.logging = s.logging;
  }
  if (s.agent && Object.keys(s.agent).length > 0) {
    out.agent = s.agent;
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
} {
  const user = normalizeDiskShape(readUserFileRaw());
  return {
    resolved: getResolvedSettings(),
    filePath: getSettingsFilePath(),
    user,
  };
}
