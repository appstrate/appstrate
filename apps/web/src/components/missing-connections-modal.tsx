// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, XCircle, Puzzle, Check, Loader2 } from "lucide-react";
import { Input } from "@appstrate/ui/components/input";
import type { AgentIntegrationEntry, IntegrationCandidate } from "@appstrate/shared-types";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { IntegrationConnectionPicker } from "./integration-connect/integration-connection-picker";
import { resolutionBlocksRun } from "./integration-connect/integration-run-readiness";
import { EMPTY_CONNECTION_SET } from "./integration-connect/connection-set";
import {
  useIntegrationDetail,
  useIntegrationAgentResolution,
  useUpdateIntegrationConnection,
} from "../hooks/use-integrations";

/**
 * Recovery surface for the run-kickoff 412 emitted by
 * `validateAgentReadiness` when integration connections are missing. The
 * 412 ships every failing `(integration, auth)` pair on `errors[]`;
 * this modal renders one row per entry.
 *
 * Each actionable row embeds the SAME `IntegrationConnectionPicker` the
 * Connexions tab and the schedule editor use, in `override` mode: the picker
 * lists every accessible connection (own + shared — including ones that need
 * reconnection, with an inline renew button) and exposes the connect / renew /
 * upgrade / add flows. A validated SET accumulates into the modal's per-run
 * `connection_overrides` map; the footer's "Re-run with picks" button fires
 * the parent's `onRetryWithOverrides` callback with the full
 * `{ integrationId: connectionIds[] }` map (mechanism #2).
 *
 * Reusing the picker keeps this modal in lockstep with the dropdown — same
 * candidate list, scope/lock verdicts and connect orchestration — instead of
 * re-deriving an affordance from the static 412 payload (the previous code
 * filtered must_choose candidates down to the 412's `candidate_connections`,
 * which dropped connections needing reconnection and so disagreed with the tab
 * dropdown). Only structural failures — the integration is not active here, or
 * its package is missing, mistyped or unloadable — keep a plain message: no
 * connection pick can fix them.
 */

export interface MissingIntegrationFieldError {
  field: string; // `integrations.{packageId}` (integration-level — auth_key lives on the candidate row)
  /**
   * The codes the server puts on an `integrations.*` item: the four verdicts
   * `collectAgentReadinessErrors` raises about the integration PACKAGE
   * (`agent-readiness.ts`) and the connection verdicts
   * `integration-connection-resolver.ts` raises about the accounts behind it.
   * `| string` keeps an unlisted one rendering its server message rather than
   * crashing the row — it is not licence to adapt a shape nothing emits.
   */
  code:
    | "not_connected"
    | "needs_reconnection"
    | "insufficient_scopes"
    | "must_choose_connection"
    | "duplicate_connection_label"
    | "auth_key_mismatch"
    | "pinned_connection_unavailable"
    | "override_connection_unavailable"
    | "integration_not_found"
    | "integration_wrong_type"
    | "integration_invalid_manifest"
    | "integration_not_active"
    | string;
  title?: string;
  message: string;
  /** Missing scopes — populated on insufficient_scopes for the OAuth re-consent upgrade. */
  missing_scopes?: string[];
  /**
   * Candidate connections. On `must_choose_connection` they are the rows to
   * choose among — deliberately unread there, since the row embeds the shared
   * `IntegrationConnectionPicker` whose candidate list is a superset (see the
   * module comment above); API and MCP callers, which have no picker, choose
   * from this field. On `duplicate_connection_label` they are the BOUND rows
   * that share a label, and the row DOES read them: the remedy is renaming
   * one, not re-picking.
   */
  candidate_connections?: {
    id: string;
    label: string;
    account_id: string;
    owned_by_actor: boolean;
  }[];
  /**
   * The dead/under-scoped connection id — populated on `needs_reconnection`
   * and `insufficient_scopes`.
   */
  connection_id?: string;
}

/**
 * Per-run connection picks, keyed by integration id. Matches the wire format
 * the run route expects on `connection_overrides` (mechanism #2, validated by
 * `input-parser.ts`: `Record<integrationId, connectionId[]>`, 1..10 per key).
 * Each chosen connection carries its own `auth_key`; storing it twice would
 * let the two diverge.
 */
type ConnectionOverridesMap = Record<string, string[]>;

/**
 * Codes that no connection pick can fix — surfaced as a plain message, no
 * picker. They are exactly the four the readiness pass raises about the
 * integration PACKAGE, before any account is looked at: the declared package is
 * absent, is not an integration, has a manifest that will not load, or is not
 * active in this space. Connecting an account changes none of them.
 */
function isStructuralCode(code: string): boolean {
  return (
    code === "integration_not_active" ||
    code === "integration_not_found" ||
    code === "integration_wrong_type" ||
    code === "integration_invalid_manifest"
  );
}

interface MissingConnectionsModalProps {
  open: boolean;
  onClose: () => void;
  errors: MissingIntegrationFieldError[];
  /**
   * The agent whose run 412'd. Keys the bulk server resolution
   * (`GET /api/agents/:scope/:name/connection-readiness`) each picker consumes
   * so its status + CTA stay in lockstep with the Connexions tab. Omitted only
   * by callers without the agent in context (none today).
   */
  agentPackageId?: string;
  /**
   * The agent's declared integration entries (tools/scopes per integration).
   * Forwarded to the picker so a fresh connection / re-consent requests
   * exactly the scopes THIS agent needs (avoids an immediate
   * insufficient_scopes re-run).
   */
  integrationEntries?: AgentIntegrationEntry[];
  /** Re-run with the picked overrides. */
  onRetryWithOverrides: (overrides: ConnectionOverridesMap) => void;
  /** Disables the retry button while the new run is in flight. */
  retrying?: boolean;
}

export function MissingConnectionsModal({
  open,
  onClose,
  errors,
  agentPackageId,
  integrationEntries,
  onRetryWithOverrides,
  retrying,
}: MissingConnectionsModalProps) {
  const { t } = useTranslation(["agents"]);
  const [picks, setPicks] = useState<ConnectionOverridesMap>({});

  const integrationErrors = errors.filter((e) => e.field.startsWith("integrations."));

  // must_choose rows have N>1 candidates and no auto-pick, so a re-run can't
  // proceed until the user picks one. Other actionable rows (connect / renew /
  // upgrade) resolve through the picker's own flow and re-run freely — a fresh
  // 412 just reopens the modal with the updated error list.
  const mustChooseIds = integrationErrors
    .filter((e) => e.code === "must_choose_connection")
    .map((e) => parseField(e.field));
  const allMustChosen = mustChooseIds.every((id) => (picks[id]?.length ?? 0) > 0);

  const hasActionable = integrationErrors.some((e) => !isStructuralCode(e.code));
  const showRetry = hasActionable;
  const canRetry = !retrying && allMustChosen;

  // Validating a set writes the per-run override; clearing (empty set, the
  // picker's "inherit / reset" entry) drops the key so the resolver falls
  // back to the member pin / cascade default at re-run.
  const setPick = (integrationId: string, connectionIds: string[]) => {
    setPicks((prev) => {
      if (connectionIds.length === 0) {
        const { [integrationId]: _omit, ...rest } = prev;
        void _omit;
        return rest;
      }
      return { ...prev, [integrationId]: connectionIds };
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("missingConnections.title")}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onClose} disabled={retrying}>
            {t("missingConnections.close")}
          </Button>
          {showRetry && (
            <Button
              onClick={() => onRetryWithOverrides(picks)}
              disabled={!canRetry}
              data-testid="must-choose-retry"
            >
              {retrying && <Spinner />}
              {mustChooseIds.length > 0
                ? t("missingConnections.mustChoose.retry")
                : t("missingConnections.retry")}
            </Button>
          )}
        </div>
      }
    >
      <p className="text-muted-foreground mb-3 text-sm">{t("missingConnections.intro")}</p>
      {/* Cap the list height so a long set of integrations scrolls inside the
          modal instead of overflowing past it (and pushing the footer out of
          view). `-mr-2 pr-2` insets the scrollbar without clipping row borders. */}
      <div className="-mr-2 max-h-[55vh] space-y-2 overflow-y-auto pr-2">
        {integrationErrors.map((err, i) => (
          <MissingRow
            key={`${err.field}-${i}`}
            err={err}
            agentPackageId={agentPackageId}
            integrationEntries={integrationEntries}
            pick={picks[parseField(err.field)] ?? EMPTY_CONNECTION_SET}
            onPick={setPick}
          />
        ))}
      </div>
    </Modal>
  );
}

function MissingRow({
  err,
  agentPackageId,
  integrationEntries,
  pick,
  onPick,
}: {
  err: MissingIntegrationFieldError;
  agentPackageId?: string;
  integrationEntries?: AgentIntegrationEntry[];
  /** Current per-run pick set for this integration; empty = no override. */
  pick: string[];
  onPick: (integrationId: string, connectionIds: string[]) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const packageId = parseField(err.field);
  const { data: detail } = useIntegrationDetail(packageId);
  // Structural failures can't be fixed by connecting — an admin must activate
  // the integration or the agent must drop the dependency. No picker.
  const isStructural = isStructuralCode(err.code);

  // Server-authoritative verdict — the SAME `IntegrationAgentResolution` the
  // Connexions tab and the launch-readiness badge consume (the picker below
  // fetches it too; React Query dedupes the shared key). The header reflects it
  // live: the connect/renew flow invalidates the `["integrations", …]` prefix
  // (hosted connect portal popup close, `connection_update` SSE), this query
  // refetches, and the header flips to resolved without a manual Re-run.
  const { data: resolution } = useIntegrationAgentResolution(
    isStructural ? undefined : packageId,
    isStructural ? undefined : agentPackageId,
  );
  const entry = integrationEntries?.find((e) => e.id === packageId);

  // Resolved = the run-kickoff gate would no longer reject this integration.
  // Single predicate shared with the badge, so resolved here ⇔ not blocking there.
  const resolved = !!resolution && !resolutionBlocksRun(resolution);
  // The picker needs the manifest + first verdict to render fully wired; hold
  // a spinner until both land (non-structural rows with the agent in context).
  const canRenderPicker = !isStructural && !!agentPackageId && !!detail && !!resolution;
  const loadingVerdict = !isStructural && !!agentPackageId && (!detail || !resolution);

  const displayName = detail?.manifest.display_name ?? packageId;
  const Icon = resolved ? Check : isStructural ? XCircle : AlertTriangle;
  const colorClass = resolved
    ? "text-emerald-600"
    : isStructural
      ? "text-destructive"
      : "text-amber-500";

  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Puzzle className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{displayName}</div>
            <div className={`flex items-center gap-1.5 truncate text-xs ${colorClass}`}>
              <Icon className="size-3" />
              {/* `title` because the row TRUNCATES: a structural message can
                  carry the server's diagnosis (e.g. the manifest schema issues
                  behind `integration_invalid_manifest`), and a cause clipped at
                  the row width is a cause the user never reads. */}
              <span className="truncate" title={resolved ? undefined : err.message}>
                {resolved ? t("missingConnections.resolved") : err.message}
              </span>
            </div>
          </div>
        </div>
        {loadingVerdict && (
          <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
        )}
      </div>
      {err.code === "duplicate_connection_label" && err.candidate_connections && (
        <DuplicateLabelFix
          packageId={packageId}
          connections={err.candidate_connections}
          {...(resolution ? { candidates: resolution.candidates } : {})}
        />
      )}
      {canRenderPicker && (
        <div className="border-border/60 mt-1 border-t pt-2">
          <IntegrationConnectionPicker
            integrationId={packageId}
            agentPackageId={agentPackageId}
            manifest={detail.manifest}
            authStatuses={detail.auths}
            agentTools={entry?.tools}
            agentScopes={entry?.scopes}
            persistence={{
              mode: "override",
              value: pick,
              onChange: (connectionIds) => onPick(packageId, connectionIds),
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Remedy for `duplicate_connection_label`: the run bound several connections
 * whose labels collide, and the agent addresses each one BY its label, so no
 * re-pick fixes it — one of them has to be renamed. Lists the colliding rows,
 * with an inline rename field (the same `PATCH .../connections/{id}` the
 * integration page uses) on the ones the actor owns; renaming someone else's
 * shared connection is refused server-side, so a foreign row asks its owner
 * instead of offering a control that would 403.
 */
function DuplicateLabelFix({
  packageId,
  connections,
  candidates,
}: {
  packageId: string;
  connections: { id: string; label: string; account_id: string; owned_by_actor: boolean }[];
  /** Resolution candidates — the only surface carrying each owner's name. */
  candidates?: IntegrationCandidate[];
}) {
  const { t } = useTranslation(["agents"]);
  const rename = useUpdateIntegrationConnection();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Labels this modal has already written. Without them the field would snap
  // back to the stale 412 payload and let the same PATCH be sent again.
  const [renamed, setRenamed] = useState<Record<string, string>>({});

  const ownerOf = (id: string): string =>
    candidates?.find((c) => c.id === id)?.owner_name ??
    t("detail.integrationMemberPicker.ownerUnknown");

  return (
    <div
      className="mt-1 flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
      data-testid={`duplicate-label-fix-${packageId}`}
    >
      <span className="text-amber-700 dark:text-amber-300">
        {t("missingConnections.duplicateLabel.hint")}
      </span>
      {connections.map((c) => {
        const current = renamed[c.id] ?? c.label;
        const draft = drafts[c.id] ?? current;
        return (
          <div key={c.id} className="flex items-center gap-2">
            <span className="text-muted-foreground min-w-0 flex-1 truncate">{c.account_id}</span>
            {c.owned_by_actor ? (
              <>
                <Input
                  className="h-7 max-w-[10rem] text-xs"
                  value={draft}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  aria-label={t("missingConnections.duplicateLabel.rename")}
                  data-testid={`duplicate-label-input-${c.id}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={rename.isPending || draft.trim() === "" || draft === current}
                  onClick={() =>
                    rename.mutate(
                      {
                        params: { path: { packageId, connectionId: c.id } },
                        body: { label: draft },
                      },
                      {
                        onSuccess: () => {
                          setRenamed((prev) => ({ ...prev, [c.id]: draft }));
                          setDrafts((prev) => {
                            const { [c.id]: _done, ...rest } = prev;
                            void _done;
                            return rest;
                          });
                        },
                      },
                    )
                  }
                  data-testid={`duplicate-label-save-${c.id}`}
                >
                  {t("missingConnections.duplicateLabel.rename")}
                </Button>
              </>
            ) : (
              <span data-testid={`duplicate-label-foreign-${c.id}`}>
                {t("missingConnections.duplicateLabel.askOwner", {
                  label: current,
                  owner: ownerOf(c.id),
                })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Extract the integration package id from the `integrations.{packageId}` field path. */
function parseField(field: string): string {
  return field.slice("integrations.".length);
}
