// Log types and pure utility functions shared between log-viewer components and pages.

export interface LogEntry {
  message: string;
  type: string;
  level?: string;
  detail?: string;
  createdAt?: Date | string | null;
}

export interface RawLog {
  type: string;
  level: string;
  event?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
}

export function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}: ${str}`);
  }
  const joined = parts.join(", ");
  return joined.length > 200 ? joined.slice(0, 200) + "..." : joined;
}

/**
 * Transform raw execution logs into LogEntry[], merging consecutive text-only
 * progress entries and extracting report chunks and structured data.
 */
export function buildLogEntries(rawLogs: RawLog[]): {
  entries: LogEntry[];
  report: string;
  reportComplete: boolean;
  data: Record<string, unknown> | null;
} {
  const entries: LogEntry[] = [];
  let report = "";
  let reportComplete = false;
  let data: Record<string, unknown> | null = null;
  let lastWasPlainText = false;

  for (const log of rawLogs) {
    if (log.event === "report_chunk" || log.event === "report_final") {
      report += (log.message || "") + "\n\n";
      if (log.event === "report_final") reportComplete = true;
      lastWasPlainText = false;
    } else if (log.event === "structured_output" && log.data) {
      if (!data) data = {};
      Object.assign(data, log.data);
      lastWasPlainText = false;
    } else if (log.event === "execution_completed") {
      lastWasPlainText = false;
    } else {
      const logData = (log.data ?? {}) as Record<string, unknown>;
      const message = (logData.message as string) || log.message || "";
      if (message) {
        const args = logData.args as Record<string, unknown> | undefined;
        const detail = args ? formatToolArgs(args) : undefined;
        const isPlainText = log.type === "progress" && !log.data;

        if (isPlainText && lastWasPlainText && entries.length > 0) {
          entries[entries.length - 1]!.message += "\n" + message;
        } else {
          entries.push({
            message,
            type: log.type || "progress",
            level: log.level || "debug",
            detail,
            createdAt: log.createdAt,
          });
        }
        lastWasPlainText = isPlainText;
      }
    }
  }

  return { entries, report, reportComplete, data };
}

export function formatTimestamp(d: Date | string | null | undefined, lang: string): string {
  if (!d) return "\u2014";
  try {
    const date = d instanceof Date ? d : new Date(d);
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const hms = date.toLocaleTimeString(lang, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `${hms}.${ms}`;
  } catch {
    return "\u2014";
  }
}

/** Text color by semantic type (nature of the log). */
export const typeColors: Record<string, string> = {
  system: "text-primary",
};

/** Text color by severity level (overrides type color when set). */
export const levelColors: Record<string, string> = {
  warn: "text-amber-400",
  error: "text-destructive",
};
