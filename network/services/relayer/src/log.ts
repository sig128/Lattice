/** Structured JSON-lines logging to stdout. Never log secrets or key material. */

export type Level = "debug" | "info" | "warn" | "error" | "critical";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  critical(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function createLogger(
  base: Record<string, unknown> = {},
  minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? "info",
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: Level, msg: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }, (_k, v) => serialize(v)));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    critical: (m, f) => emit("critical", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, minLevel, sink),
  };
}

export const silentLogger: Logger = createLogger({}, "critical", () => {});
