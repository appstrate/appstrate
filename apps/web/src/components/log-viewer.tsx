// SPDX-License-Identifier: Apache-2.0

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
import { formatTimestamp, typeColors, levelColors, type LogEntry } from "./log-utils";
import { ProviderCallBody } from "./provider-call-body";

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
        "mr-1.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] leading-none font-semibold",
        config.className,
      )}
    >
      <Icon size={10} />
      {config.label}
    </span>
  );
}

// --- LogViewer (admin/developer view) ---

interface LogViewerProps {
  entries: LogEntry[];
}

export function LogViewer({ entries }: LogViewerProps) {
  const { t, i18n } = useTranslation("agents");
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
    <div className="border-border bg-card overflow-hidden rounded-lg border">
      <div className="border-border flex items-center gap-1 border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className={cn("text-muted-foreground h-7 w-7", expandAll && "text-primary")}
          onClick={() => setExpandAll((v) => !v)}
          title={t("log.expandAll")}
          style={{ marginLeft: "auto" }}
        >
          <WrapText size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("text-muted-foreground h-7 w-7", showTimestamps && "text-primary")}
          onClick={() => setShowTimestamps((v) => !v)}
          title={t("log.toggleTimestamps")}
        >
          <Clock size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("text-muted-foreground h-7 w-7", autoScroll && "text-primary")}
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
          className={cn("text-muted-foreground h-7 w-7", copied && "text-success")}
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
            const entry = entries[virtualRow.index]!;
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
                    "text-muted-foreground hover:bg-muted/50 cursor-pointer truncate px-3 py-0.5 font-mono text-sm leading-7 select-none",
                    (entry.level && levelColors[entry.level]) || typeColors[entry.type],
                    entry.type === "progress" &&
                      (!entry.level || entry.level === "debug") &&
                      "before:bg-primary before:mr-1.5 before:inline-block before:h-1.5 before:w-1.5 before:rounded-full before:opacity-60 before:content-['']",
                    expanded && "bg-muted/30 break-words whitespace-normal",
                  )}
                >
                  {showTimestamps && (
                    <span className="text-muted-foreground/60 mr-2 font-mono text-xs">
                      {formatTimestamp(entry.createdAt, i18n.language)}
                    </span>
                  )}
                  <LevelBadge level={entry.level} />
                  {entry.message}
                  {entry.detail && (
                    <span className="text-muted-foreground ml-2 text-xs">{entry.detail}</span>
                  )}
                  {expanded && entry.providerCallBody && (
                    <div className="mt-2 mr-2 ml-4">
                      <ProviderCallBody body={entry.providerCallBody} />
                    </div>
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

// --- RunTimeline (public/user view) ---

interface RunTimelineProps {
  entries: LogEntry[];
  isRunning?: boolean;
}

export function RunTimeline({ entries, isRunning }: RunTimelineProps) {
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
        <div className="text-muted-foreground flex items-center gap-2 py-1 text-sm">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
