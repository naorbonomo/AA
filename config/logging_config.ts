/** Log paths / toggles (parity with backend logging topic; AA desktop slice). */

export const DEFAULT_LOG_TO_FILE = true;

export const DEFAULT_LOG_TO_CONSOLE = true;

/** When true (Settings → Logging), emit verbose `[tool:*]` lines for agent tools (`web_search`, `stt`, `tts`, `schedule_job`). */
export const DEFAULT_LOG_TOOLS = false;

/** Directory name under package log root. */
export const LOG_DIR_NAME = "logs";

export const LOG_FILE_NAME = "aa.log";
