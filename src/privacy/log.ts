export type LogLevel = "info" | "warn" | "critical";

export interface LogEvent {
  level: LogLevel;
  event: string;
  timestamp: string;
  [field: string]: unknown;
}

export interface Logger {
  emit(event: Omit<LogEvent, "timestamp">): void;
}

function defaultEmit(event: Omit<LogEvent, "timestamp">): void {
  const line = { ...event, timestamp: new Date().toISOString() };
  const stream = event.level === "info" ? process.stdout : process.stderr;
  stream.write(JSON.stringify(line) + "\n");
}

let globalLogger: Logger = { emit: defaultEmit };

export function setLoggerForTests(logger: Logger | null): void {
  globalLogger = logger ?? { emit: defaultEmit };
}

export function emit(event: Omit<LogEvent, "timestamp">): void {
  globalLogger.emit(event);
}
