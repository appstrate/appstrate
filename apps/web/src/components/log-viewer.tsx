// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Copy,
  Check,
  CheckCircle2,
  Clock,
  ArrowDown,
  WrapText,
  Info,
  AlertTriangle,
  XCircle,
  Wrench,
  Loader2,
  CircleSlash2,
  CircleHelp,
  MessageSquareText,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "@appstrate/core/format";
import {
  formatTimestamp,
  getExecutionEntryDisclosure,
  levelColors,
  type ExecutionEntry,
  type ToolExecutionStatus,
} from "./log-utils";

const levelConfig: Record<string, { icon: typeof Info; className: string; label: string }> = {
  info: { icon: Info, className: "text-blue-400 bg-blue-400/10", label: "INFO" },
  warn: { icon: AlertTriangle, className: "text-amber-400 bg-amber-400/10", label: "WARN" },
  error: { icon: XCircle, className: "text-destructive bg-destructive/10", label: "ERROR" },
};

function LevelBadge({ level }: { level?: string }) {
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

const toolStatusClasses: Record<ToolExecutionStatus, string> = {
  running: "text-blue-400",
  success: "text-success",
  failed: "text-destructive",
  interrupted: "text-amber-400",
  unknown: "text-muted-foreground",
};

function ToolStatusIcon({ status }: { status: ToolExecutionStatus }) {
  const { t } = useTranslation("agents");
  const className = cn("size-3.5 shrink-0", toolStatusClasses[status]);
  const label = {
    running: t("log.toolStatus.running"),
    success: t("log.toolStatus.success"),
    failed: t("log.toolStatus.failed"),
    interrupted: t("log.toolStatus.interrupted"),
    unknown: t("log.toolStatus.unknown"),
  }[status];
  switch (status) {
    case "running":
      return <Loader2 className={cn(className, "animate-spin")} aria-label={label} />;
    case "success":
      return <CheckCircle2 className={className} aria-label={label} />;
    case "failed":
      return <XCircle className={className} aria-label={label} />;
    case "interrupted":
      return <CircleSlash2 className={className} aria-label={label} />;
    case "unknown":
      return <CircleHelp className={className} aria-label={label} />;
  }
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

interface LogViewerProps {
  entries: ExecutionEntry[];
}

export function LogViewer({ entries }: LogViewerProps) {
  const { t, i18n } = useTranslation("agents");
  const scrollRef = useRef<HTMLDivElement>(null);

  const [showTimestamps, setShowTimestamps] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  // Auto-scroll when entries are added OR a running tool row settles in place.
  useEffect(() => {
    if (autoScroll && entries.length > 0) {
      virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries, autoScroll]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (e.kind === "tool") {
          const detail = e.detail ? ` ${e.detail}` : "";
          const duration = e.durationMs !== undefined ? ` ${formatDuration(e.durationMs)}` : "";
          const args =
            e.args !== undefined
              ? `\n  ${t("log.arguments")}: ${formatStructuredValue(e.args)}`
              : "";
          const result =
            e.result !== undefined
              ? `\n  ${t("log.result")}: ${formatStructuredValue(e.result)}`
              : "";
          return `${ts}[tool:${e.status}] ${e.tool}${detail}${duration}${args}${result}`;
        }
        return `${ts}${e.message}`;
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
            const disclosure = getExecutionEntryDisclosure(entry);
            const expanded = disclosure.expandable && (expandAll || expandedId === entry.id);
            const visibleMessage =
              entry.kind === "tool" ? null : expanded ? entry.message : disclosure.collapsedMessage;
            const wrapMessage = entry.kind !== "tool" && expanded;
            const messageClassName = cn(
              "min-w-0 flex-1",
              wrapMessage ? "break-words whitespace-pre-wrap" : "truncate whitespace-nowrap",
            );
            return (
              <div
                key={entry.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() => {
                  if (disclosure.expandable) {
                    setExpandedId((prev) => (prev === entry.id ? null : entry.id));
                  }
                }}
              >
                <div
                  className={cn(
                    "text-muted-foreground hover:bg-muted/50 flex min-h-7 px-3 py-0.5 font-mono text-sm leading-7 select-none",
                    wrapMessage ? "items-start" : "items-center",
                    entry.level && levelColors[entry.level],
                    disclosure.expandable && "cursor-pointer",
                    entry.kind === "tool" || !wrapMessage
                      ? "truncate"
                      : "break-words whitespace-normal",
                    entry.kind === "runtime" &&
                      (!entry.level || entry.level === "debug") &&
                      "before:bg-primary before:mr-1.5 before:inline-block before:h-1.5 before:w-1.5 before:rounded-full before:opacity-60 before:content-['']",
                    expanded && "bg-muted/30 break-words whitespace-normal",
                  )}
                >
                  {showTimestamps && (
                    <span className="text-muted-foreground/60 mr-2 shrink-0 font-mono text-xs">
                      {formatTimestamp(entry.createdAt, i18n.language)}
                    </span>
                  )}
                  {entry.kind === "tool" ? (
                    <>
                      <ToolStatusIcon status={entry.status} />
                      <Wrench className="text-muted-foreground/60 ml-1.5 size-3.5 shrink-0" />
                      <span className="text-foreground ml-1.5 font-medium">{entry.tool}</span>
                      {entry.detail && (
                        <span className="text-muted-foreground ml-2 truncate text-xs">
                          {entry.detail}
                        </span>
                      )}
                      {entry.durationMs !== undefined && (
                        <span className="text-muted-foreground/70 ml-2 shrink-0 text-xs tabular-nums">
                          {formatDuration(entry.durationMs)}
                        </span>
                      )}
                    </>
                  ) : entry.kind === "agent" ? (
                    <>
                      <MessageSquareText className="mr-1.5 size-3.5 shrink-0 text-violet-400" />
                      <span className={cn("text-foreground/80 font-sans", messageClassName)}>
                        {visibleMessage}
                      </span>
                    </>
                  ) : entry.kind === "log" ? (
                    <>
                      <MessageSquareText className="mr-1.5 size-3.5 shrink-0" />
                      <LevelBadge level={entry.level} />
                      <span className={cn("font-sans", messageClassName)}>{visibleMessage}</span>
                    </>
                  ) : (
                    <>
                      <LevelBadge level={entry.level} />
                      <span className={messageClassName}>{visibleMessage}</span>
                    </>
                  )}
                </div>
                {expanded && entry.kind === "tool" && (
                  <div
                    className="border-border bg-muted/20 border-t px-8 py-2 text-xs"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {entry.args !== undefined && (
                      <div className="mb-2 last:mb-0">
                        <div className="text-muted-foreground mb-1 font-medium">
                          {t("log.arguments")}
                        </div>
                        <pre className="text-foreground/80 overflow-x-auto whitespace-pre-wrap select-text">
                          {formatStructuredValue(entry.args)}
                        </pre>
                      </div>
                    )}
                    {entry.result !== undefined && (
                      <div>
                        <div className="text-muted-foreground mb-1 font-medium">
                          {t("log.result")}
                        </div>
                        <pre className="text-foreground/80 overflow-x-auto whitespace-pre-wrap select-text">
                          {formatStructuredValue(entry.result)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
