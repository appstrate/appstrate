import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, Check, Clock, ArrowDown } from "lucide-react";

export interface LogEntry {
  message: string;
  type: string;
  detail?: string;
  createdAt?: Date | string | null;
}

interface LogViewerProps {
  entries: LogEntry[];
}

function formatTimestamp(d: Date | string | null | undefined, lang: string): string {
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

export function LogViewer({ entries }: LogViewerProps) {
  const { t, i18n } = useTranslation("flows");
  const scrollRef = useRef<HTMLDivElement>(null);

  const [showTimestamps, setShowTimestamps] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

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
        return `${ts}${e.message}`;
      })
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <button
          className={`log-icon-btn${showTimestamps ? " log-icon-btn--active" : ""}`}
          onClick={() => setShowTimestamps((v) => !v)}
          title={t("log.toggleTimestamps")}
          style={{ marginLeft: "auto" }}
        >
          <Clock size={14} />
        </button>
        <button
          className={`log-icon-btn${autoScroll ? " log-icon-btn--active" : ""}`}
          onClick={() => {
            setAutoScroll(true);
            if (entries.length > 0) {
              virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
            }
          }}
          title={t("log.autoScroll")}
        >
          <ArrowDown size={14} />
        </button>
        <button
          className={`log-icon-btn${copied ? " log-icon-btn--copied" : ""}`}
          onClick={handleCopy}
          title={copied ? t("log.copied") : t("log.copyLogs")}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div className="log-content" ref={scrollRef}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = entries[virtualRow.index];
            const expanded = expandedIndex === virtualRow.index;
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
                <div className={`log-entry ${entry.type}${expanded ? " log-entry--expanded" : ""}`}>
                  {showTimestamps && (
                    <span className="log-timestamp">
                      {formatTimestamp(entry.createdAt, i18n.language)}
                    </span>
                  )}
                  {entry.message}
                  {entry.detail && <span className="log-detail">{entry.detail}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
