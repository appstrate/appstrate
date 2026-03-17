import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Copy,
  Check,
  Clock,
  ArrowDown,
  WrapText,
  Info,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// --- Shared types and utilities ---

export interface LogEntry {
  message: string;
  type: string;
  level?: string;
  detail?: string;
  createdAt?: Date | string | null;
}

const levelConfig: Record<string, { icon: typeof Info; className: string; label: string }> = {
  info: { icon: Info, className: "text-blue-400 bg-blue-400/10", label: "INFO" },
  warn: { icon: AlertTriangle, className: "text-amber-400 bg-amber-400/10", label: "WARN" },
  error: { icon: XCircle, className: "text-destructive bg-destructive/10", label: "ERROR" },
};

export function LevelBadge({ level }: { level?: string }) {
  if (!level || level === "debug") return null;
  const config = levelConfig[level];
  if (!config) return null;
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold leading-none mr-1.5 shrink-0",
        config.className,
      )}
    >
      <Icon size={10} />
      {config.label}
    </span>
  );
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

// --- LogViewer (admin/developer view) ---

interface LogViewerProps {
  entries: LogEntry[];
}

export function LogViewer({ entries }: LogViewerProps) {
  const { t, i18n } = useTranslation("flows");
  const scrollRef = useRef<HTMLDivElement>(null);

  const [showTimestamps, setShowTimestamps] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (autoScroll && entries.length > 0) {
      virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries.length, autoScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Disable auto-scroll when user scrolls up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (!atBottom && autoScroll) setAutoScroll(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [autoScroll]);

  const handleCopy = () => {
    const text = entries
      .map((e) => {
        const ts = showTimestamps ? `[${formatTimestamp(e.createdAt, i18n.language)}] ` : "";
        const detail = e.detail ? ` ${e.detail}` : "";
        return `${ts}${e.message}${detail}`;
      })
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7 text-muted-foreground", expandAll && "text-primary")}
          onClick={() => setExpandAll((v) => !v)}
          title={t("log.expandAll")}
          style={{ marginLeft: "auto" }}
        >
          <WrapText size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7 text-muted-foreground", showTimestamps && "text-primary")}
          onClick={() => setShowTimestamps((v) => !v)}
          title={t("log.toggleTimestamps")}
        >
          <Clock size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7 text-muted-foreground", autoScroll && "text-primary")}
          onClick={() => {
            setAutoScroll(true);
            if (entries.length > 0) {
              virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
            }
          }}
          title={t("log.autoScroll")}
        >
          <ArrowDown size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7 text-muted-foreground", copied && "text-success")}
          onClick={handleCopy}
          title={copied ? t("log.copied") : t("log.copyLogs")}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>

      <div className="h-[400px] overflow-auto" ref={scrollRef}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = entries[virtualRow.index];
            const hasLevel = entry.level && entry.level !== "debug";
            const expanded = expandAll || expandedIndex === virtualRow.index || !!hasLevel;
            return (
              <div
                key={virtualRow.index}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() =>
                  setExpandedIndex((prev) => (prev === virtualRow.index ? null : virtualRow.index))
                }
              >
                <div
                  className={cn(
                    "px-3 py-0.5 text-sm font-mono text-muted-foreground cursor-pointer select-none leading-7 truncate hover:bg-muted/50",
                    (entry.level && levelColors[entry.level]) || typeColors[entry.type],
                    entry.type === "progress" &&
                      (!entry.level || entry.level === "debug") &&
                      "before:content-[''] before:inline-block before:w-1.5 before:h-1.5 before:rounded-full before:bg-primary before:mr-1.5 before:opacity-60",
                    expanded && "whitespace-normal break-words bg-muted/30",
                  )}
                >
                  {showTimestamps && (
                    <span className="mr-2 text-xs text-muted-foreground/60 font-mono">
                      {formatTimestamp(entry.createdAt, i18n.language)}
                    </span>
                  )}
                  <LevelBadge level={entry.level} />
                  {entry.message}
                  {entry.detail && (
                    <span className="ml-2 text-xs text-muted-foreground">{entry.detail}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- ExecutionTimeline (public/user view) ---

interface ExecutionTimelineProps {
  entries: LogEntry[];
  isRunning?: boolean;
}

export function ExecutionTimeline({ entries, isRunning }: ExecutionTimelineProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new entries or when loader appears
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length, isRunning]);

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => (
        <div
          key={i}
          className={cn(
            "flex items-start gap-2 text-sm",
            (entry.level && levelColors[entry.level]) || "text-foreground",
          )}
        >
          <span className="leading-6">{entry.message}</span>
        </div>
      ))}
      {isRunning && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
