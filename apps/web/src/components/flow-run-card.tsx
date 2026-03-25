import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { JSONSchemaObject, ProviderStatus } from "@appstrate/shared-types";
import { InputFields } from "./input-fields";
import { initInputValues, buildInputPayload } from "./input-utils";
import { JsonView } from "./json-view";
import { Spinner } from "./spinner";
import { InlineMarkdown } from "./markdown";
import { ExecutionTimeline } from "./log-viewer";
import type { LogEntry } from "./log-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunCardStatus =
  | "loading"
  | "idle"
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "invalid";

export interface FlowRunCardProps {
  // Flow metadata
  displayName?: string;
  description?: string;
  inputSchema?: JSONSchemaObject;
  providers?: ProviderStatus[];

  // State
  status: RunCardStatus;
  error?: string | null;
  result?: Record<string, unknown> | null;
  logEntries?: LogEntry[];
  submitting?: boolean;

  // Callbacks
  onRun: (input?: Record<string, unknown>, files?: Record<string, File[]>) => void;
  onRerun?: () => void;
  onProviderConnect?: (svc: ProviderStatus) => void;

  // Config
  canRun?: boolean;
  canRunTitle?: string;
  invalidTitle?: string;
  invalidMessage?: string;
  notFoundMessage?: string;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider badges
// ---------------------------------------------------------------------------

function ProviderBadges({
  providers,
  onConnect,
}: {
  providers: ProviderStatus[];
  onConnect?: (svc: ProviderStatus) => void;
}) {
  const { t } = useTranslation(["flows"]);
  if (providers.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {providers.map((svc) => {
        const isConnected = svc.status === "connected";
        const isAdmin = svc.connectionMode === "admin";

        // Admin-mode provider
        if (isAdmin) {
          const ready = svc.adminProvided && isConnected;
          return (
            <div
              key={svc.id}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
              title={svc.description}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full inline-block",
                  ready ? "bg-success" : "bg-destructive",
                )}
              />
              {svc.id}
              {ready ? (
                <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {t("admin")}
                </span>
              ) : (
                <span className="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                  {t("detail.pending")}
                </span>
              )}
            </div>
          );
        }

        // User-mode, connected
        if (isConnected) {
          return (
            <div
              key={svc.id}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
              title={svc.description}
            >
              <span className="h-2 w-2 rounded-full bg-success inline-block" />
              {svc.id}
            </div>
          );
        }

        // User-mode, not connected — clickable if onConnect provided
        if (onConnect) {
          return (
            <Button
              key={svc.id}
              variant="outline"
              type="button"
              className="flex items-center gap-1.5 border-dashed px-2.5 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-foreground"
              onClick={() => onConnect(svc)}
              title={svc.description}
            >
              <span className="h-2 w-2 rounded-full bg-destructive inline-block" />
              {svc.id} ({t("detail.connect")})
            </Button>
          );
        }

        return (
          <div
            key={svc.id}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
            title={svc.description}
          >
            <span className="h-2 w-2 rounded-full bg-destructive inline-block" />
            {svc.id}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FlowRunCard({
  displayName,
  description,
  inputSchema,
  providers,
  status,
  error,
  result,
  logEntries,
  submitting,
  onRun,
  onRerun,
  onProviderConnect,
  canRun = true,
  canRunTitle,
  invalidTitle,
  invalidMessage,
  notFoundMessage,
}: FlowRunCardProps) {
  const { t } = useTranslation(["flows", "common"]);

  const hasInput = !!inputSchema?.properties && Object.keys(inputSchema.properties).length > 0;

  const initialInputValues = useMemo(
    () => (inputSchema ? initInputValues(inputSchema) : {}),
    [inputSchema],
  );
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const mergedInputValues = useMemo(
    () => ({ ...initialInputValues, ...inputValues }),
    [initialInputValues, inputValues],
  );
  const [fileValues, setFileValues] = useState<Record<string, File[]>>({});

  const handleSubmit = () => {
    const input = inputSchema ? buildInputPayload(inputSchema, mergedInputValues) : undefined;
    onRun(input, fileValues);
  };

  // Loading
  if (status === "loading") {
    return (
      <Shell>
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      </Shell>
    );
  }

  // Invalid token
  if (status === "invalid") {
    return (
      <Shell>
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{invalidTitle || t("public.invalidTitle")}</h2>
        </div>
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {invalidMessage || t("public.invalidMessage")}
        </div>
      </Shell>
    );
  }

  // Not found (no flow data)
  if (!displayName) {
    return (
      <Shell>
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {notFoundMessage || t("shareable.notFound")}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">{displayName}</h2>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">
            <InlineMarkdown>{description}</InlineMarkdown>
          </p>
        )}
      </div>

      {providers && providers.length > 0 && (
        <ProviderBadges providers={providers} onConnect={onProviderConnect} />
      )}

      {status === "idle" && (
        <div className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {hasInput && (
            <InputFields
              schema={inputSchema!}
              values={mergedInputValues}
              onChange={(key, value) => setInputValues((prev) => ({ ...prev, [key]: value }))}
              fileValues={fileValues}
              onFileChange={(key, files) => setFileValues((prev) => ({ ...prev, [key]: files }))}
              idPrefix="run-input"
            />
          )}
          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={!canRun || submitting}
            title={!canRun ? canRunTitle : undefined}
          >
            {submitting ? <Spinner /> : t("shareable.execute")}
          </Button>
        </div>
      )}

      {status === "running" && <ExecutionTimeline entries={logEntries ?? []} isRunning />}

      {(status === "success" || status === "failed" || status === "timeout") && (
        <div className="space-y-4">
          {logEntries && logEntries.length > 0 && <ExecutionTimeline entries={logEntries} />}
          {error && (
            <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          {result && Object.keys(result).length > 0 && <JsonView data={result} />}
          {onRerun && (
            <Button variant="outline" className="w-full" onClick={onRerun}>
              {t("shareable.rerun")}
            </Button>
          )}
        </div>
      )}
    </Shell>
  );
}
