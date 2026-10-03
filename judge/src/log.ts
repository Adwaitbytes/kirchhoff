import type { LogLevel } from "./config.ts";

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  log(level: LogLevel, msg: string, fields?: Readonly<Record<string, unknown>>): void;
  enabled(level: LogLevel): boolean;
};

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** One JSON object per line on stdout (warn and error on stderr), bigints as decimal strings. */
export function createLogger(minLevel: LogLevel, write: (level: LogLevel, line: string) => void = defaultWrite): Logger {
  const enabled = (level: LogLevel): boolean => RANK[level] >= RANK[minLevel];
  return {
    enabled,
    log(level, msg, fields = {}) {
      if (!enabled(level)) return;
      write(level, `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, replacer)}\n`);
    },
  };
}

function defaultWrite(level: LogLevel, line: string): void {
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
}
