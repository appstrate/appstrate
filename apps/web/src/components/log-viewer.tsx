// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Copy,
  Check,
  CheckCircle2,
  Clock,
  ArrowDown,
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
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "@appstrate/core/format";
import {
  formatTimestamp,
  levelColors,
  type ExecutionEntry,
  type ToolExecutionEntry,
  type ToolExecutionStatus,
} from "./log-utils";
import { Modal } from "./modal";

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
        "inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] leading-none font-semibold",
        config.className,
      )}
    >
      <Icon size={10} />
      {config.label}
    </span>
  );
}

function ExecutionEntryLeading({ entry }: { entry: ExecutionEntry }) {
  let content: ReactNode = null;

  if (entry.kind === "agent") {
    content = <MessageSquareText className="size-3.5 text-violet-400" />;
  } else if (entry.kind === "log") {
    content = (
      <>
        <MessageSquareText className="size-3.5" />
        <LevelBadge level={entry.level} />
      </>
    );
  } else if (entry.kind === "runtime") {
    if (!entry.level || entry.level === "debug") {
      content = <span className="bg-primary size-1.5 rounded-full opacity-60" />;
    } else if (levelConfig[entry.level]) {
      content = <LevelBadge level={entry.level} />;
    }
  }

  if (!content) return null;
  return <span className="mr-1.5 flex h-7 shrink-0 items-center gap-1.5">{content}</span>;
}

const toolStatusConfig = {
  running: {
    icon: Loader2,
    className: "text-blue-400 animate-spin",
    labelKey: "log.toolStatus.running",
  },
  success: {
    icon: CheckCircle2,
    className: "text-success",
    labelKey: "log.toolStatus.success",
  },
  failed: {
    icon: XCircle,
    className: "text-destructive",
    labelKey: "log.toolStatus.failed",
  },
  interrupted: {
    icon: CircleSlash2,
    className: "text-amber-400",
    labelKey: "log.toolStatus.interrupted",
  },
  unknown: {
    icon: CircleHelp,
    className: "text-muted-foreground",
    labelKey: "log.toolStatus.unknown",
  },
} satisfies Record<
  ToolExecutionStatus,
  { icon: typeof Loader2; className: string; labelKey: string }
>;

function ToolStatus({
  status,
  showLabel = false,
}: {
  status: ToolExecutionStatus;
  showLabel?: boolean;
}) {
  const { t } = useTranslation("agents");
  const config = toolStatusConfig[status];
  const Icon = config.icon;
  const label = t(config.labelKey);

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <Icon
        className={cn("size-3.5 shrink-0", config.className)}
        aria-hidden={showLabel || undefined}
        aria-label={showLabel ? undefined : label}
      />
      {showLabel && <span>{label}</span>}
    </span>
  );
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ToolDetailsModal({
  entry,
  onClose,
}: {
  entry: ToolExecutionEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <Modal
      open={entry !== null}
      onClose={onClose}
      title={t("log.toolDetails", { tool: entry?.tool ?? "" })}
      className="grid h-[85vh] max-h-[48rem] grid-rows-[auto_minmax(0,1fr)] sm:max-w-4xl"
    >
      {entry && (
        <ScrollArea className="min-h-0">
          <div className="flex flex-col gap-5 pr-4">
            <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-sm">
              <ToolStatus status={entry.status} showLabel />
              {entry.durationMs !== undefined && (
                <span className="tabular-nums">{formatDuration(entry.durationMs)}</span>
              )}
              {entry.detail && <span>{entry.detail}</span>}
            </div>
            {entry.args !== undefined && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t("log.arguments")}</h3>
                <pre className="bg-muted text-foreground/80 overflow-x-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
                  {formatStructuredValue(entry.args)}
                </pre>
              </section>
            )}
            {entry.result !== undefined && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t("log.result")}</h3>
                <pre className="bg-muted text-foreground/80 overflow-x-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
                  {formatStructuredValue(entry.result)}
                </pre>
              </section>
            )}
          </div>
        </ScrollArea>
      )}
    </Modal>
  );
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
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const selectedTool =
    entries.find((entry): entry is ToolExecutionEntry => {
      return entry.kind === "tool" && entry.id === selectedToolId;
    }) ?? null;

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
          className={cn("text-muted-foreground ml-auto h-7 w-7", showTimestamps && "text-primary")}
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
            const hasToolDetails =
              entry.kind === "tool" && (entry.args !== undefined || entry.result !== undefined);
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
              >
                <div
                  className={cn(
                    "text-muted-foreground hover:bg-muted/50 flex min-h-7 px-3 py-0.5 font-mono text-sm leading-7 select-none",
                    entry.kind === "tool"
                      ? "items-center truncate"
                      : "items-start break-words whitespace-normal",
                    entry.level && levelColors[entry.level],
                    hasToolDetails && "cursor-pointer",
                  )}
                  onClick={() => {
                    if (hasToolDetails) setSelectedToolId(entry.id);
                  }}
                  onKeyDown={(event) => {
                    if (hasToolDetails && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setSelectedToolId(entry.id);
                    }
                  }}
                  role={hasToolDetails ? "button" : undefined}
                  tabIndex={hasToolDetails ? 0 : undefined}
                  aria-haspopup={hasToolDetails ? "dialog" : undefined}
                >
                  {showTimestamps && (
                    <span className="text-muted-foreground/60 mr-2 flex h-7 shrink-0 items-center font-mono text-xs">
                      {formatTimestamp(entry.createdAt, i18n.language)}
                    </span>
                  )}
                  {entry.kind === "tool" ? (
                    <>
                      <ToolStatus status={entry.status} />
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
                  ) : (
                    <>
                      <ExecutionEntryLeading entry={entry} />
                      <span
                        className={cn(
                          "text-foreground/80 min-w-0 flex-1 break-words whitespace-pre-wrap",
                          (entry.kind === "agent" || entry.kind === "log") && "font-sans",
                          entry.level && levelColors[entry.level],
                        )}
                      >
                        {entry.message}
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <ToolDetailsModal entry={selectedTool} onClose={() => setSelectedToolId(null)} />
    </div>
  );
}
