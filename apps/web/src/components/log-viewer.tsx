// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Braces,
  Copy,
  Check,
  CheckCircle2,
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
  X,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageActionsMenu } from "./page-actions-menu";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { cn } from "@appstrate/ui/cn";
import { formatDuration } from "../lib/format-duration";
import {
  formatTimestamp,
  journalLevel,
  levelColors,
  type ExecutionEntry,
  type ToolExecutionStatus,
} from "./log-utils";
import { ItemList } from "./item-list";
import { EmptyState } from "./page-states";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { Badge } from "./status-badge";
import { formatDateField } from "../lib/format-date";
import { historyRuns, recalledMemories } from "../lib/runtime-tool-results";
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

/**
 * A tool's result. The two first-party memory tools read as the items they
 * returned (a memory's text, a past run's status and date); anything else, and
 * the raw payload of those two, is the JSON as the runner logged it.
 */
function ToolResult({ tool, result }: { tool: string; result: unknown }) {
  const { t } = useTranslation("agents");
  const [showJson, setShowJson] = useState(false);
  const memories = tool === "recall_memory" ? recalledMemories(result) : null;
  const runs = tool === "run_history" ? historyRuns(result) : null;
  const raw = (
    <pre className="bg-muted text-foreground/80 overflow-x-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
      {formatStructuredValue(result)}
    </pre>
  );
  if (!memories && !runs) return raw;
  let items = raw;
  if (!showJson && memories) {
    items = (
      <ItemList
        items={memories}
        itemKey={(memory) => memory.id}
        empty={<EmptyState compact icon={Info} message={t("log.recalledNone")} />}
        renderItem={(memory) => (
          <div className="rounded-md border px-3 py-2 text-sm">
            <p className="whitespace-pre-wrap">{memory.content}</p>
            {memory.createdAt && (
              <p className="text-muted-foreground mt-1 text-xs">
                {formatDateField(memory.createdAt)}
              </p>
            )}
          </div>
        )}
      />
    );
  } else if (!showJson && runs) {
    items = (
      <ItemList
        items={runs}
        itemKey={(run) => run.id}
        empty={<EmptyState compact icon={Info} message={t("log.historyNone")} />}
        renderItem={(run) => (
          <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
            {run.status && <Badge status={run.status} />}
            <span className="font-mono text-xs">{run.id}</span>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              {[
                run.date && formatDateField(run.date),
                run.duration != null && formatDuration(run.duration),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        )}
      />
    );
  }
  return (
    <div className="space-y-3">
      {items}
      <Button variant="outline" size="sm" onClick={() => setShowJson((v) => !v)}>
        <Braces />
        {showJson ? t("run.outputShowFields") : t("run.outputShowJson")}
      </Button>
    </div>
  );
}

interface LogViewerProps {
  entries: ExecutionEntry[];
  /** The entries are still being read: rows on their way replace the empty state. */
  isLoading?: boolean;
  /** Terminal failures open with the causal event near the middle of the journal. */
  focusError?: boolean;
  headerActions?: ReactNode;
  selectedEntryId?: string | null;
  onSelectEntry: (entryId: string | null) => void;
  /** Read once at mount: the caller keys the viewer on it to apply a new focus. */
  initialFocus?: JournalOverviewFilter;
}

export type JournalOverviewFilter = "tools" | "warnings" | "errors";
type JournalLevelFilter = ReturnType<typeof journalLevel>;
type JournalTypeFilter = "message" | "tool_call" | "tool_result" | "diagnostic";

function journalType(entry: ExecutionEntry): JournalTypeFilter {
  if (entry.kind === "agent") return "message";
  if (entry.kind === "tool") return entry.status === "running" ? "tool_call" : "tool_result";
  return "diagnostic";
}

function focusLevelFilters(focus: JournalOverviewFilter | undefined): JournalLevelFilter[] {
  if (focus === "warnings") return ["warn"];
  if (focus === "errors") return ["error"];
  return [];
}

function focusTypeFilters(focus: JournalOverviewFilter | undefined): JournalTypeFilter[] {
  return focus === "tools" ? ["tool_call", "tool_result"] : [];
}

function journalSearchText(entry: ExecutionEntry): string {
  if (entry.kind === "tool") {
    return [entry.tool, entry.detail, entry.status].filter(Boolean).join(" ");
  }
  return [entry.message, entry.kind === "runtime" ? entry.sourceType : undefined]
    .filter(Boolean)
    .join(" ");
}

export function LogViewer({
  entries,
  isLoading = false,
  focusError = false,
  headerActions,
  selectedEntryId,
  onSelectEntry,
  initialFocus,
}: LogViewerProps) {
  const { t, i18n } = useTranslation("agents");
  const scrollRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);

  const [autoScroll, setAutoScroll] = useState(true);
  const { copied, copy } = useCopyToClipboard();
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [query, setQuery] = useState("");
  const [levelFilters, setLevelFilters] = useState(() => focusLevelFilters(initialFocus));
  const [typeFilters, setTypeFilters] = useState(() => focusTypeFilters(initialFocus));
  const displayFilters = [
    ...(showTimestamps ? ["timestamps"] : []),
    ...(!showTools ? ["hide_tools"] : []),
  ];

  const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);
  const visibleEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (!showTools && entry.kind === "tool") return false;
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
  }, [entries, i18n.language, levelFilters, normalizedQuery, showTools, typeFilters]);
  const availableLevels = (["info", "warn", "error"] as const).filter((value) =>
    entries.some((entry) => journalLevel(entry) === value),
  );
  const availableTypes = (["message", "tool_call", "tool_result", "diagnostic"] as const).filter(
    (value) => entries.some((entry) => journalType(entry) === value),
  );
  const activeFilterCount = levelFilters.length + typeFilters.length + displayFilters.length;
  const hasActiveQueryOrFilters = normalizedQuery !== "" || activeFilterCount > 0;
  const filters: FilterSpec[] = [
    // A filter in force stays on screen, so it can be cleared.
    ...(availableLevels.length > 1 || levelFilters.length > 0
      ? [
          {
            id: "level",
            label: t("log.filterLevel"),
            values: levelFilters,
            options: availableLevels.map((value) => ({
              value,
              label: t(`log.level.${value}`),
            })),
            onChange: (values: string[]) => setLevelFilters(values as JournalLevelFilter[]),
          },
        ]
      : []),
    ...(availableTypes.length > 1 || typeFilters.length > 0
      ? [
          {
            id: "type",
            label: t("log.filterType"),
            values: typeFilters,
            options: availableTypes.map((value) => ({
              value,
              label: t(`log.type.${value}`),
            })),
            onChange: (values: string[]) => setTypeFilters(values as JournalTypeFilter[]),
          },
        ]
      : []),
    {
      id: "display",
      label: t("log.filterDisplay"),
      values: displayFilters,
      options: [
        { value: "timestamps", label: t("log.toggleTimestamps") },
        { value: "hide_tools", label: t("log.hideTools") },
      ],
      onChange: (values: string[]) => {
        setShowTimestamps(values.includes("timestamps"));
        setShowTools(!values.includes("hide_tools"));
      },
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
  }, [levelFilters, normalizedQuery, showTools, typeFilters]);

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
    setShowTimestamps(false);
    setShowTools(true);
  };

  const journalGrid = showTimestamps
    ? "grid-cols-[7rem_10rem_minmax(22rem,1fr)_6rem]"
    : "grid-cols-[10rem_minmax(22rem,1fr)_6rem]";

  return (
    <div className="bg-card overflow-hidden">
      <ListToolbar
        placement="panel"
        search={{ value: query, onChange: setQuery, placeholder: t("log.search") }}
        filters={filters}
        onReset={clearJournalFilters}
        actions={
          <div className="flex items-center gap-2">
            {headerActions}
            <PageActionsMenu>
              <DropdownMenuItem onSelect={handleCopy}>
                {copied ? <Check /> : <Copy />}
                {copied ? t("log.copied") : t("log.copyLogs")}
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
          </div>
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
            <span>{t("log.columnDuration")}</span>
          </div>

          <div className="h-[400px] overflow-y-auto" ref={scrollRef}>
            {isLoading && entries.length === 0 ? (
              <div role="status" aria-busy="true" aria-label={t("loading", { ns: "common" })}>
                <div aria-hidden className="space-y-2 p-4">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState compact icon={ScrollText} message={t("log.empty")} />
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  compact
                  icon={SearchX}
                  message={t("log.noMatches")}
                  hint={t("log.noMatchesHint")}
                >
                  {hasActiveQueryOrFilters && (
                    <Button variant="ghost" size="sm" onClick={clearJournalFilters}>
                      {t("log.clearAll")}
                    </Button>
                  )}
                </EmptyState>
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
                  const isSelected = selectedEntryId === entry.id;
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
                      <button
                        type="button"
                        className={cn(
                          "hover:bg-muted/20 grid min-h-10 w-full cursor-pointer items-center gap-4 px-4 py-2 text-left text-sm transition-colors",
                          journalGrid,
                          isSelected && "bg-muted/40",
                        )}
                        onClick={() => onSelectEntry(isSelected ? null : entry.id)}
                        aria-pressed={isSelected}
                      >
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
                        <span className="text-muted-foreground text-right text-xs tabular-nums">
                          {entry.kind === "tool" && entry.durationMs !== undefined
                            ? formatDuration(entry.durationMs)
                            : ""}
                        </span>
                      </button>
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

export function LogEntryInspector({
  entry,
  onClose,
}: {
  entry: ExecutionEntry;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("agents");
  const type = journalType(entry);

  return (
    <div className="flex h-full min-h-[400px] flex-col">
      <div className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("log.inspectorTitle")}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-7"
          onClick={onClose}
          aria-label={t("common:btn.close")}
        >
          <X />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          <FactGrid columns={1}>
            <Fact label={t("log.filterType")}>{t(`log.type.${type}`)}</Fact>
            {entry.createdAt && (
              <Fact label={t("log.timestamp")}>
                {formatTimestamp(entry.createdAt, i18n.language)}
              </Fact>
            )}
            <Fact label={t("log.filterLevel")}>{t(`log.level.${journalLevel(entry)}`)}</Fact>
            {entry.kind === "tool" && (
              <>
                <Fact label={t("log.tool")}>{entry.tool}</Fact>
                <Fact label={t("log.status")}>
                  <ToolStatus status={entry.status} showLabel />
                </Fact>
                {entry.durationMs !== undefined && (
                  <Fact label={t("run.infoDuration")}>{formatDuration(entry.durationMs)}</Fact>
                )}
              </>
            )}
          </FactGrid>

          {entry.kind === "tool" ? (
            <>
              {entry.args !== undefined && (
                <InspectorCode label={t("log.arguments")} value={entry.args} />
              )}
              {entry.result !== undefined && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("log.result")}</h3>
                  <ToolResult key={entry.id} tool={entry.tool} result={entry.result} />
                </section>
              )}
              {entry.detail && entry.args === undefined && (
                <InspectorText label={t("log.details")} value={entry.detail} />
              )}
            </>
          ) : (
            <InspectorText label={t("log.message")} value={entry.message} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function InspectorText({ label, value }: { label: string; value: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{label}</h3>
      <p className="text-foreground/80 text-sm break-words whitespace-pre-wrap">{value}</p>
    </section>
  );
}

function InspectorCode({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{label}</h3>
      <pre className="bg-muted text-foreground/80 overflow-x-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
        {formatStructuredValue(value)}
      </pre>
    </section>
  );
}
