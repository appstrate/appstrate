import { useEffect, useRef } from "react";

export interface LogEntry {
  message: string;
  type: string;
  detail?: string;
}

interface LogViewerProps {
  entries: LogEntry[];
}

export function LogViewer({ entries }: LogViewerProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [entries.length]);

  return (
    <div className="log-viewer">
      <div className="log-content" ref={contentRef}>
        {entries.map((entry, i) => (
          <div key={i} className={`log-entry ${entry.type}`}>
            {entry.message}
            {entry.detail && <span className="log-detail">{entry.detail}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
