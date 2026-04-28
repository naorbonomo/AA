/** Electron/CLI secrets — primary store is `userData/.env` (or `AA/.env` for CLI); migrates legacy `aa-secrets.json` once; syncs matching keys into `process.env`. */

import fs from "node:fs";
import path from "node:path";

import type { SecretsPayload } from "../config/secrets_config.js";
import * as secretsCfg from "../config/secrets_config.js";
import { formatDotenvSection, parseDotenvLines } from "../utils/env-file.js";

let userDataDir: string | null = null;
let secretsCache: SecretsPayload | null = null;

const ENV_UPPER: Array<[keyof SecretsPayload, string]> = [
  ["telegram_bot_token", "TELEGRAM_BOT_TOKEN"],
  ["openai_api_key", "OPENAI_API_KEY"],
  ["tavily_api_key", "TAVILY_API_KEY"],
];

function aaRootFromCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

function baseDir(): string {
  if (userDataDir) {
    return userDataDir;
  }
  return aaRootFromCwd();
}

/** Path shown in Settings; canonical secrets file (`gitignore`). */
export function getSecretsFilePath(): string {
  return path.join(baseDir(), secretsCfg.DOTENV_SECRET_BASENAME);
}

function legacyJsonPath(): string {
  return path.join(baseDir(), secretsCfg.SECRETS_FILE_BASENAME);
}

/** Apply secrets payload to Node `process.env` so spawned tools / libs reading env behave like Smith backend `.env`. */
function applySecretsToProcessEnv(payload: SecretsPayload): void {
  for (const [field, upper] of ENV_UPPER) {
    const val = typeof payload[field] === "string" ? payload[field].trim() : "";
    if (val.length > 0) {
      process.env[upper] = val;
    } else {
      delete process.env[upper];
    }
  }
}

function payloadFromEnvRecord(rec: Record<string, string>): SecretsPayload {
  const accum: Partial<SecretsPayload> = {};
  for (const [field, upper] of ENV_UPPER) {
    const want = upper.toUpperCase();
    let v = "";
    for (const [k, val] of Object.entries(rec)) {
      if (k.toUpperCase() === want) {
        v = (val ?? "").trim();
        break;
      }
    }
    if (v.length > 0) {
      accum[field] = v;
    }
  }
  return accum as SecretsPayload;
}

function readLegacyJsonMerge(): SecretsPayload | null {
  const p = legacyJsonPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw) as unknown;
    if (typeof j !== "object" || j === null) {
      return null;
    }
    return j as SecretsPayload;
  } catch {
    return null;
  }
}

/** Write canonical `.env`; returns bytes written path. */
function writeDotenv(pathForFile: string, payload: SecretsPayload): void {
  const lines = ENV_UPPER.map(([field, upper]) => {
    const raw = typeof payload[field] === "string" ? payload[field].trim() : "";
    return [upper, raw] as [string, string];
  });
  const text = formatDotenvSection(lines);
  fs.mkdirSync(path.dirname(pathForFile), { recursive: true });
  fs.writeFileSync(pathForFile, text, "utf8");
  try {
    fs.chmodSync(pathForFile, 0o600);
  } catch {
    /* windows / sandbox */
  }
}

function migrateJsonToDotenvIfNeeded(dotPath: string): void {
  if (fs.existsSync(dotPath)) {
    try {
      const raw = fs.readFileSync(dotPath, "utf8");
      const parsed = payloadFromEnvRecord(parseDotenvLines(raw));
      if (
        parsed.telegram_bot_token ||
        parsed.openai_api_key ||
        parsed.tavily_api_key
      ) {
        return;
      }
    } catch {
      /* migrate from JSON below */
    }
  }
  const legacy = legacyJsonPath();
  if (!fs.existsSync(legacy)) {
    return;
  }
  const migrated = readLegacyJsonMerge();
  if (!migrated || !Object.keys(migrated).some((k) => (migrated as Record<string, string>)[k])) {
    return;
  }
  writeDotenv(dotPath, migrated);
  try {
    fs.renameSync(legacy, `${legacy}.migrated`);
  } catch {
    /* keep json if rename fails */
  }
}

/** Load from `.env`; migrate legacy JSON; empty object if absent. */
function loadFromDisk(): SecretsPayload {
  const dotPath = getSecretsFilePath();
  migrateJsonToDotenvIfNeeded(dotPath);

  try {
    if (!fs.existsSync(dotPath)) {
      const j = readLegacyJsonMerge();
      return j ?? {};
    }
    const raw = fs.readFileSync(dotPath, "utf8");
    return payloadFromEnvRecord(parseDotenvLines(raw));
  } catch {
    const j = readLegacyJsonMerge();
    return j ?? {};
  }
}

export function initializeSecretsStore(opts?: { userDataDir?: string }): void {
  userDataDir = opts?.userDataDir?.trim() ? opts.userDataDir : null;
  secretsCache = null;
  const s = loadFromDisk();
  secretsCache = s;
  applySecretsToProcessEnv(s);
}

/** Clear cached secrets and re-read disk + re-apply env (called when Settings Reload). */
export function reloadSecretsFromDisk(): void {
  secretsCache = null;
  const s = loadFromDisk();
  secretsCache = s;
  applySecretsToProcessEnv(s);
}

/** Hot path — returns merged keys from `.env`. */
export function getSecrets(): SecretsPayload {
  if (secretsCache) {
    return { ...secretsCache };
  }
  const s = loadFromDisk();
  secretsCache = s;
  applySecretsToProcessEnv(s);
  return { ...secretsCache };
}

function clearKey(obj: SecretsPayload, k: keyof SecretsPayload): void {
  delete obj[k];
}

export function saveSecretsPatch(patch: Partial<SecretsPayload>): SecretsPayload {
  const cur = loadFromDisk();
  const next: SecretsPayload = { ...cur };

  type K = keyof SecretsPayload;

  function setOrClear(k: K, raw: SecretsPayload[K] | undefined): void {
    if (raw === undefined) {
      return;
    }
    const s = typeof raw === "string" ? raw.trim() : "";
    if (s === "") {
      clearKey(next, k);
    } else {
      next[k] = s as SecretsPayload[K];
    }
  }

  setOrClear("telegram_bot_token", patch.telegram_bot_token);
  setOrClear("openai_api_key", patch.openai_api_key);
  setOrClear("tavily_api_key", patch.tavily_api_key);

  const dotPath = getSecretsFilePath();
  const nonempty = Object.keys(next).some((key) => (next as Record<string, string | undefined>)[key]);
  if (!nonempty) {
    secretsCache = {};
    applySecretsToProcessEnv({});
    try {
      fs.unlinkSync(dotPath);
    } catch {
      try {
        fs.writeFileSync(dotPath, "# empty\n", "utf8");
      } catch {
        /* noop */
      }
    }
    try {
      const lg = legacyJsonPath();
      if (fs.existsSync(lg)) {
        fs.unlinkSync(lg);
      }
    } catch {
      /* noop */
    }
    return {};
  }

  writeDotenv(dotPath, next);
  try {
    const lg = legacyJsonPath();
    if (fs.existsSync(lg)) {
      fs.renameSync(lg, `${lg}.migrated_old`);
    }
  } catch {
    /* noop */
  }

  secretsCache = next;
  applySecretsToProcessEnv(next);
  return { ...next };
}

function mask(secret: string | undefined): string {
  if (!secret) {
    return "";
  }
  if (secret.length <= 4) {
    return "••••";
  }
  return `••••••••${secret.slice(-4)}`;
}

export function getSecretsSnapshot(): {
  filePath: string;
  masked: {
    telegram_bot_token: string;
    openai_api_key: string;
    tavily_api_key: string;
  };
  hasTelegram: boolean;
  hasOpenAi: boolean;
  hasTavily: boolean;
} {
  const s = loadFromDisk();
  return {
    filePath: getSecretsFilePath(),
    masked: {
      telegram_bot_token: mask(s.telegram_bot_token),
      openai_api_key: mask(s.openai_api_key),
      tavily_api_key: mask(s.tavily_api_key),
    },
    hasTelegram: Boolean(s.telegram_bot_token),
    hasOpenAi: Boolean(s.openai_api_key),
    hasTavily: Boolean(s.tavily_api_key),
  };
}
