export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

let minimum: LogLevel = "info";

/** Hides events below `level`. Debug adds a line for every message the bot skips, and why. */
export function setLogLevel(level: LogLevel): void {
  minimum = level;
}

/**
 * Logs one JSON line per event. Fields carry IDs and verdicts, never message text: the logs
 * should not become a second copy of what members wrote.
 */
function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(minimum)) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "debug" || level === "info") console.log(line);
  else console.error(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
