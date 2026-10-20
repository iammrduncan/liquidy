type Level = "info" | "warn" | "error";

/**
 * Logs one JSON line per event. Fields carry IDs and verdicts, never message text: the logs
 * should not become a second copy of what members wrote.
 */
function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
