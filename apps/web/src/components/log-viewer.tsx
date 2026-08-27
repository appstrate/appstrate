// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
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
  Loader2,
  CircleSlash2,
  CircleHelp,
  MessageSquareText,
  Bug,
  Wrench,
  Filter,
  Search,
  SearchX,
  X,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
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
  /** Terminal failures open with the causal event near the middle of the journal. */
  focusError?: boolean;
  variant?: "card" | "integrated";
  heading?: string;
  description?: string;
  headerActions?: ReactNode;
}

type JournalLevelFilter = "info" | "warn" | "error";
type JournalTypeFilter = "message" | "tool_call" | "tool_result" | "diagnostic";

function journalLevel(entry: ExecutionEntry): JournalLevelFilter {
  if (entry.kind === "tool" && entry.status === "failed") return "error";
  if (entry.level === "error") return "error";
  if (entry.level === "warn") return "warn";
  return "info";
}

function journalType(entry: ExecutionEntry): JournalTypeFilter {
  if (entry.kind === "agent") return "message";
  if (entry.kind === "tool") return entry.status === "running" ? "tool_call" : "tool_result";
  return "diagnostic";
}

function journalSearchText(entry: ExecutionEntry): string {
  if (entry.kind === "tool") {
    return [entry.tool, entry.detail, entry.status].filter(Boolean).join(" ");
  }
  return [entry.message, entry.kind === "runtime" ? entry.sourceType : undefined]
    .filter(Boolean)
    .join(" ");
}

function toggleFilterValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function LogViewer({
  entries,
  focusError = false,
  variant = "card",
  heading,
  description,
  headerActions,
}: LogViewerProps) {
  const { t, i18n } = useTranslation("agents");
  const scrollRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);

  const [showTimestamps, setShowTimestamps] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [levelFilters, setLevelFilters] = useState<JournalLevelFilter[]>([]);
  const [typeFilters, setTypeFilters] = useState<JournalTypeFilter[]>([]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
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
  const activeFilterCount = levelFilters.length + typeFilters.length;
  const hasJournalFilters = availableLevels.length > 1 || availableTypes.length > 1;
  const hasActiveQueryOrFilters = normalizedQuery !== "" || activeFilterCount > 0;
  const selectedTool =
    entries.find((entry): entry is ToolExecutionEntry => {
      return entry.kind === "tool" && entry.id === selectedToolId;
    }) ?? null;

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (variant === "integrated" ? 34 : 28),
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
          const entry = visibleEntries[index]!;
          if (entry.level === "error" || (entry.kind === "tool" && entry.status === "failed")) {
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
  }, [visibleEntries, autoScroll, focusError]); // eslint-disable-line react-hooks/exhaustive-deps

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
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const clearJournalFilters = () => {
    setQuery("");
    setLevelFilters([]);
    setTypeFilters([]);
  };

  return (
    <div
      className={cn(
        "bg-card overflow-hidden",
        variant === "card" && "border-border rounded-lg border",
      )}
      data-log-viewer-variant={variant}
    >
      <div
        className={cn(
          "border-border flex flex-wrap items-center gap-3 border-b",
          heading ? "py-3" : "px-2 py-1.5",
        )}
      >
        {heading && (
          <div className={cn("min-w-0", searchOpen ? "shrink-0" : "flex-1")}>
            <h2 className="text-sm font-semibold">{heading}</h2>
            {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
          </div>
        )}
        {searchOpen && (
          <div className="relative order-3 w-full md:order-none md:min-w-40 md:flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (query) setQuery("");
                  else setSearchOpen(false);
                }
              }}
              aria-label={t("log.search")}
              placeholder={t("log.search")}
              className="h-8 w-full pr-8 pl-8"
            />
            {query && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-0 right-0 size-8"
                onClick={() => setQuery("")}
                aria-label={t("log.clearSearch")}
                title={t("log.clearSearch")}
              >
                <X />
              </Button>
            )}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0 md:gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "text-muted-foreground size-6 md:size-7",
              (searchOpen || normalizedQuery) && "text-primary",
            )}
            onClick={() => setSearchOpen((value) => !value)}
            title={t("log.search")}
            aria-label={t("log.search")}
            aria-expanded={searchOpen}
          >
            <Search />
          </Button>
          {hasJournalFilters && (
            <Popover open={filterOpen} onOpenChange={setFilterOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "text-muted-foreground relative size-6 md:size-7",
                    (filterOpen || activeFilterCount > 0) && "text-primary",
                  )}
                  title={t("log.filters")}
                  aria-label={t("log.filters")}
                >
                  <Filter />
                  {activeFilterCount > 0 && (
                    <span className="bg-foreground text-background absolute -top-1 -right-1 grid size-4 place-items-center rounded-full text-[0.6rem] font-semibold">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-0">
                <div className="border-border border-b px-3 py-2.5 text-sm font-medium">
                  {t("log.filters")}
                </div>
                <div className="space-y-3 p-2">
                  {availableLevels.length > 1 && (
                    <JournalFilterGroup
                      label={t("log.filterLevel")}
                      options={availableLevels.map((value) => ({
                        value,
                        label: t(`log.level.${value}`),
                      }))}
                      values={levelFilters}
                      onToggle={(value) =>
                        setLevelFilters((current) => toggleFilterValue(current, value))
                      }
                    />
                  )}
                  {availableTypes.length > 1 && (
                    <JournalFilterGroup
                      label={t("log.filterType")}
                      options={availableTypes.map((value) => ({
                        value,
                        label: t(`log.type.${value}`),
                      }))}
                      values={typeFilters}
                      onToggle={(value) =>
                        setTypeFilters((current) => toggleFilterValue(current, value))
                      }
                    />
                  )}
                </div>
                {activeFilterCount > 0 && (
                  <div className="border-border border-t p-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-center"
                      onClick={() => {
                        setLevelFilters([]);
                        setTypeFilters([]);
                      }}
                    >
                      {t("log.clearAll")}
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "text-muted-foreground ml-auto size-6 md:size-7",
              showTimestamps && "text-primary",
            )}
            onClick={() => setShowTimestamps((v) => !v)}
            title={t("log.toggleTimestamps")}
          >
            <Clock size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-muted-foreground size-6 md:size-7", showTools && "text-primary")}
            onClick={() => setShowTools((value) => !value)}
            title={t(showTools ? "log.hideTools" : "log.showTools")}
            aria-label={t(showTools ? "log.hideTools" : "log.showTools")}
            aria-pressed={showTools}
          >
            <Wrench />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-muted-foreground size-6 md:size-7", autoScroll && "text-primary")}
            onClick={() => {
              setAutoScroll(true);
              if (visibleEntries.length > 0) {
                virtualizer.scrollToIndex(visibleEntries.length - 1, { align: "end" });
              }
            }}
            title={t("log.autoScroll")}
          >
            <ArrowDown size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("text-muted-foreground size-6 md:size-7", copied && "text-success")}
            onClick={handleCopy}
            title={copied ? t("log.copied") : t("log.copyLogs")}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
          {headerActions}
        </div>
      </div>

      <div
        className={cn("h-[400px] overflow-auto", variant === "integrated" && "pt-2")}
        ref={scrollRef}
      >
        {visibleEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <SearchX className="text-muted-foreground mb-3 size-7" />
            <p className="text-sm font-medium">{t("log.noMatches")}</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-xs">{t("log.noMatchesHint")}</p>
            {hasActiveQueryOrFilters && (
              <Button variant="ghost" size="sm" className="mt-2" onClick={clearJournalFilters}>
                {t("log.clearAll")}
              </Button>
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
                      "text-muted-foreground hover:bg-muted/50 flex font-mono text-sm select-none",
                      variant === "integrated"
                        ? "min-h-8 px-2 leading-8"
                        : "min-h-7 px-3 leading-7",
                      entry.kind === "tool"
                        ? "items-center gap-1.5 truncate"
                        : "items-start gap-1.5 break-words whitespace-normal",
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
                    {entry.kind === "tool" ? (
                      <>
                        <ToolStatus status={entry.status} />
                        {showTimestamps && (
                          <span className="text-muted-foreground/60 flex h-7 shrink-0 items-center font-mono text-xs">
                            {formatTimestamp(entry.createdAt, i18n.language)}
                          </span>
                        )}
                        <span className="text-foreground text-xs font-semibold">{entry.tool}</span>
                        {entry.detail && (
                          <span className="text-muted-foreground truncate text-xs">
                            {entry.detail}
                          </span>
                        )}
                        {entry.durationMs !== undefined && (
                          <span className="text-muted-foreground/70 shrink-0 text-xs tabular-nums">
                            {formatDuration(entry.durationMs)}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="flex h-7 w-3.5 shrink-0 items-center justify-center">
                          <ExecutionEntryIcon entry={entry} />
                        </span>
                        {showTimestamps && (
                          <span className="text-muted-foreground/60 flex h-7 shrink-0 items-center font-mono text-xs">
                            {formatTimestamp(entry.createdAt, i18n.language)}
                          </span>
                        )}
                        <span
                          className={cn(
                            "text-foreground/80 min-w-0 flex-1 py-1 font-sans text-sm leading-5 break-words whitespace-pre-wrap",
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
        )}
      </div>
      <ToolDetailsModal entry={selectedTool} onClose={() => setSelectedToolId(null)} />
    </div>
  );
}

function JournalFilterGroup<T extends string>({
  label,
  options,
  values,
  onToggle,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  values: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div>
      <p className="text-muted-foreground px-2 py-1 text-xs font-medium">{label}</p>
      <div className="space-y-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
            onClick={() => onToggle(option.value)}
          >
            <Checkbox checked={values.includes(option.value)} className="pointer-events-none" />
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
