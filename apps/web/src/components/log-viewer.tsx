// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Copy,
  Check,
  CheckCircle2,
  ChevronRight,
  Info,
  AlertTriangle,
  XCircle,
  Loader2,
  CircleSlash2,
  CircleHelp,
  MessageSquareText,
  Bug,
  ScrollText,
  SearchX,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "./page-actions-menu";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "../lib/format-duration";
import {
  formatTimestamp,
  journalLevel,
  levelColors,
  type ExecutionEntry,
  type ToolExecutionStatus,
} from "./log-utils";
import { Waiting } from "./loading-skeletons";
import { EmptyState } from "./page-states";
import { ListToolbar, type FilterSpec } from "./list-toolbar";
import { useCopyToClipboard } from "@appstrate/ui/use-copy-to-clipboard";

const levelIconConfig: Record<string, { icon: typeof Info; className: string; label: string }> = {
  debug: { icon: Bug, className: "text-muted-foreground", label: "DEBUG" },
  info: { icon: Info, className: "text-primary", label: "INFO" },
  warn: { icon: AlertTriangle, className: "text-warning", label: "WARN" },
  error: { icon: XCircle, className: "text-destructive", label: "ERROR" },
};

function ExecutionEntryIcon({ entry }: { entry: ExecutionEntry }) {
  if (entry.kind === "agent") {
    return <MessageSquareText className="text-primary size-3.5" />;
  }
  if (entry.kind === "runtime" && (!entry.level || entry.level === "debug")) {
    return <span className="bg-primary size-1.5 rounded-full opacity-60" />;
  }

  const config = levelIconConfig[entry.level ?? "debug"] ?? levelIconConfig.debug!;
  const Icon = config.icon;
  return (
    <Icon className={cn("size-3.5", config.className)} role="img" aria-label={config.label}>
      <title>{config.label}</title>
    </Icon>
  );
}

const toolStatusConfig = {
  running: {
    icon: Loader2,
    className: "text-primary animate-spin",
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
    className: "text-warning",
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

function ToolStatus({ status }: { status: ToolExecutionStatus }) {
  const { t } = useTranslation("agents");
  const config = toolStatusConfig[status];
  const Icon = config.icon;

  return (
    <Icon className={cn("size-3.5 shrink-0", config.className)} aria-label={t(config.labelKey)} />
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

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="bg-muted text-foreground/80 overflow-x-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
      {formatStructuredValue(value)}
    </pre>
  );
}

function ExpandedSection({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{label}</h3>
      <JsonBlock value={value} />
    </section>
  );
}

interface LogViewerProps {
  entries: ExecutionEntry[];
  /** The entries are still being read: rows on their way replace the empty state. */
  isLoading?: boolean;
  /** Terminal failures open with the causal event near the middle of the journal. */
  focusError?: boolean;
}

type JournalTypeFilter = "message" | "tool_call" | "tool_result" | "diagnostic";

function journalType(entry: ExecutionEntry): JournalTypeFilter {
  if (entry.kind === "agent") return "message";
  if (entry.kind === "tool") return entry.status === "running" ? "tool_call" : "tool_result";
  return "diagnostic";
}

/** A filter in force stays on screen, so it can be cleared. */
function facet(
  id: string,
  label: string,
  values: string[],
  available: readonly string[],
  optionLabel: (value: string) => string,
  onChange: (values: string[]) => void,
): FilterSpec[] {
  if (available.length < 2 && values.length === 0) return [];
  const options = available.map((value) => ({ value, label: optionLabel(value) }));
  return [{ id, label, values, options, onChange }];
}

function journalSearchText(entry: ExecutionEntry): string {
  if (entry.kind === "tool") {
    return [entry.tool, entry.detail, entry.status].filter(Boolean).join(" ");
  }
  return [entry.message, entry.kind === "runtime" ? entry.sourceType : undefined]
    .filter(Boolean)
    .join(" ");
}

export function LogViewer({ entries, isLoading = false, focusError = false }: LogViewerProps) {
  const { t, i18n } = useTranslation("agents");
  const scrollRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);

  const [autoScroll, setAutoScroll] = useState(true);
  const { copied, copy } = useCopyToClipboard();
  const [display, setDisplay] = useState<string[]>([]);
  const showTimestamps = display.includes("timestamps");
  const [query, setQuery] = useState("");
  const [levelFilters, setLevelFilters] = useState<string[]>([]);
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);
  const visibleEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (levelFilters.length > 0 && !levelFilters.includes(journalLevel(entry))) return false;
      if (typeFilters.length > 0 && !typeFilters.includes(journalType(entry))) return false;
      if (
        normalizedQuery &&
        !journalSearchText(entry).toLocaleLowerCase(i18n.language).includes(normalizedQuery)
      ) {
        return false;
      }
      return true;
    });
  }, [entries, i18n.language, levelFilters, normalizedQuery, typeFilters]);
  const availableLevels = (["info", "warn", "error"] as const).filter((value) =>
    entries.some((entry) => journalLevel(entry) === value),
  );
  const availableTypes = (["message", "tool_call", "tool_result", "diagnostic"] as const).filter(
    (value) => entries.some((entry) => journalType(entry) === value),
  );
  const activeFilterCount = levelFilters.length + typeFilters.length + display.length;
  const hasActiveQueryOrFilters = normalizedQuery !== "" || activeFilterCount > 0;
  const filters: FilterSpec[] = [
    ...facet(
      "level",
      t("log.filterLevel"),
      levelFilters,
      availableLevels,
      (value) => t(`log.level.${value}`),
      setLevelFilters,
    ),
    ...facet(
      "type",
      t("log.filterType"),
      typeFilters,
      availableTypes,
      (value) => t(`log.type.${value}`),
      setTypeFilters,
    ),
    {
      id: "display",
      label: t("log.filterDisplay"),
      values: display,
      options: [{ value: "timestamps", label: t("log.toggleTimestamps") }],
      onChange: setDisplay,
    },
  ];

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 10,
  });

  useEffect(() => {
    positionedRef.current = false;
  }, [levelFilters, normalizedQuery, typeFilters]);

  // Auto-scroll when entries are added OR a running tool row settles in place.
  useEffect(() => {
    if (visibleEntries.length === 0) return;
    if (!positionedRef.current) {
      let errorIndex = -1;
      if (focusError) {
        for (let index = visibleEntries.length - 1; index >= 0; index -= 1) {
          if (journalLevel(visibleEntries[index]!) === "error") {
            errorIndex = index;
            break;
          }
        }
      }
      virtualizer.scrollToIndex(errorIndex >= 0 ? errorIndex : visibleEntries.length - 1, {
        align: errorIndex >= 0 ? "center" : "end",
      });
      positionedRef.current = true;
      return;
    }
    if (autoScroll) {
      virtualizer.scrollToIndex(visibleEntries.length - 1, { align: "end" });
    }
  }, [visibleEntries, autoScroll, focusError, virtualizer]);

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
    const text = visibleEntries
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
    void copy(text);
  };

  const clearJournalFilters = () => {
    setQuery("");
    setLevelFilters([]);
    setTypeFilters([]);
    setDisplay([]);
  };

  const journalGrid = showTimestamps
    ? "grid-cols-[7rem_10rem_minmax(22rem,1fr)_6rem]"
    : "grid-cols-[10rem_minmax(22rem,1fr)_6rem]";

  return (
    <div className="bg-card overflow-hidden">
      <ListToolbar
        search={{ value: query, onChange: setQuery, placeholder: t("log.search") }}
        filters={filters}
        onReset={clearJournalFilters}
        actions={
          <PageActionsMenu>
            <DropdownMenuItem onSelect={handleCopy}>
              {copied ? <Check /> : <Copy />}
              {copied ? t("common:btn.copied") : t("log.copyLogs")}
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={autoScroll}
              onCheckedChange={(checked) => {
                setAutoScroll(checked);
                if (checked && visibleEntries.length > 0) {
                  virtualizer.scrollToIndex(visibleEntries.length - 1, { align: "end" });
                }
              }}
            >
              {t("log.autoScroll")}
            </DropdownMenuCheckboxItem>
          </PageActionsMenu>
        }
      />

      <div className="overflow-x-auto">
        <div className={cn("min-w-[640px]", showTimestamps && "min-w-[760px]")}>
          <div
            className={cn(
              "border-border bg-muted/20 text-muted-foreground grid items-center gap-4 border-y px-4 py-2 text-xs font-semibold tracking-wide uppercase",
              journalGrid,
            )}
          >
            {showTimestamps && <span>{t("log.timestamp")}</span>}
            <span>{t("log.filterType")}</span>
            <span>{t("log.columnEvent")}</span>
            <span>{t("run.infoDuration")}</span>
          </div>

          <div className="h-[400px] overflow-y-auto" ref={scrollRef}>
            {isLoading && entries.length === 0 ? (
              <Waiting>
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              </Waiting>
            ) : visibleEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                {entries.length === 0 ? (
                  <EmptyState compact icon={ScrollText} message={t("log.empty")} />
                ) : (
                  <EmptyState
                    compact
                    icon={SearchX}
                    message={t("log.noMatches")}
                    hint={t("log.noMatchesHint")}
                  >
                    {hasActiveQueryOrFilters && (
                      <Button variant="ghost" size="sm" onClick={clearJournalFilters}>
                        {t("common:toolbar.clearAll")}
                      </Button>
                    )}
                  </EmptyState>
                )}
              </div>
            ) : (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const entry = visibleEntries[virtualRow.index]!;
                  const hasDetail =
                    entry.kind === "tool" &&
                    (entry.args !== undefined || entry.result !== undefined);
                  const isOpen = hasDetail && expanded.has(entry.id);
                  const rowClass = cn(
                    "grid min-h-10 w-full items-center gap-4 px-4 py-2 text-left text-sm transition-colors",
                    journalGrid,
                    isOpen && "bg-muted/40",
                  );
                  const rowContent = (
                    <>
                      {showTimestamps && (
                        <span className="text-muted-foreground font-mono text-xs">
                          {formatTimestamp(entry.createdAt, i18n.language)}
                        </span>
                      )}
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          {entry.kind === "tool" ? (
                            <ToolStatus status={entry.status} />
                          ) : (
                            <ExecutionEntryIcon entry={entry} />
                          )}
                        </span>
                        <span className="text-muted-foreground truncate text-xs">
                          {t(`log.type.${journalType(entry)}`)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "text-foreground min-w-0",
                          entry.kind === "tool" ? "truncate" : "break-words whitespace-pre-wrap",
                          entry.level && levelColors[entry.level],
                        )}
                      >
                        {entry.kind === "tool" ? (
                          <>
                            <span className="font-medium">{entry.tool}</span>
                            {entry.detail && (
                              <span className="text-muted-foreground"> · {entry.detail}</span>
                            )}
                          </>
                        ) : (
                          entry.message
                        )}
                      </span>
                      <span className="text-muted-foreground flex items-center justify-end gap-1 text-xs tabular-nums">
                        {entry.kind === "tool" && entry.durationMs !== undefined
                          ? formatDuration(entry.durationMs)
                          : ""}
                        {hasDetail && (
                          <ChevronRight
                            className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
                            aria-hidden
                          />
                        )}
                      </span>
                    </>
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
                    >
                      {hasDetail ? (
                        <button
                          type="button"
                          className={cn(rowClass, "hover:bg-muted/20 cursor-pointer")}
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (!next.delete(entry.id)) next.add(entry.id);
                              return next;
                            })
                          }
                          aria-expanded={isOpen}
                        >
                          {rowContent}
                        </button>
                      ) : (
                        <div className={rowClass}>{rowContent}</div>
                      )}
                      {isOpen && entry.kind === "tool" && (
                        <div className="bg-muted/40 flex flex-col gap-4 px-4 pt-1 pb-4">
                          {entry.args !== undefined && (
                            <ExpandedSection label={t("log.arguments")} value={entry.args} />
                          )}
                          {entry.result !== undefined && (
                            <ExpandedSection label={t("log.result")} value={entry.result} />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
