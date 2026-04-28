/** Application logging — toggles resolved via nested `logging` settings. */

import fs from "node:fs";
import path from "node:path";

import * as loggingDefaults from "../config/logging_config.js";
import * as logPaths from "../config/logging.js";
import { getResolvedSettings } from "../services/settings-store.js";

/** `AA/` root when inferring paths from cwd (same rule as settings-store). */
function aaRoot(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "AA") {
    return cwd;
  }
  return path.join(cwd, "AA");
}

function logDir(): string {
  return process.env.AA_LOG_DIR ?? path.join(aaRoot(), logPaths.LOG_DIR_NAME);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

function logToFileEnabled(): boolean {
  try {
    return getResolvedSettings().logging.logToFile;
  } catch {
    return loggingDefaults.DEFAULT_LOG_TO_FILE;
  }
}

function logToConsoleEnabled(): boolean {
  try {
    return getResolvedSettings().logging.logToConsole;
  } catch {
    return loggingDefaults.DEFAULT_LOG_TO_CONSOLE;
  }
}

function stringifyArg(a: unknown): string {
  if (a instanceof Error) {
    return a.stack ?? a.message;
  }
  if (typeof a === "string") {
    return a;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function formatLine(level: LogLevel, name: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args.map(stringifyArg).join(" ");
  return `[${ts}] [${name}] [${level.toUpperCase()}] ${body}`;
}

function writeFileLine(fullLine: string): void {
  if (!logToFileEnabled()) {
    return;
  }
  const dir = logDir();
  const filePath = path.join(dir, logPaths.LOG_FILE_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, `${fullLine}\n`, "utf8");
  } catch {
    console.error("[AA/logger] failed to append log file:", filePath);
  }
}

function emitConsole(level: LogLevel, line: string): void {
  if (!logToConsoleEnabled()) {
    return;
  }
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function emit(level: LogLevel, name: string, args: unknown[]): void {
  const line = formatLine(level, name, args);
  writeFileLine(line);
  emitConsole(level, line);
}

/** Small logger bound to `name` — prefer over raw `console` in app code. */
export function getLogger(name: string) {
  return {
    debug: (...args: unknown[]) => emit("debug", name, args),
    info: (...args: unknown[]) => emit("info", name, args),
    warn: (...args: unknown[]) => emit("warn", name, args),
    error: (...args: unknown[]) => emit("error", name, args),
  };
}
