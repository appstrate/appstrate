// SPDX-License-Identifier: Apache-2.0

/**
 * The working space's verdict on a remote integration's tools, set where the tools are listed:
 * each row of the tools table carries its own approve / withdraw / block / unblock deeds (and the
 * author's « declare in the integration »), and the undeclared tools that wait for a review get a
 * card with the definition to read before approving. What the agents may call follows from it
 * (`tool_catalog` statuses). The space's decisions are for a reader who may configure the
 * integration in the space; an author editing the draft also declares the listed tools, which
 * needs no space policy.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Ban, Check, ChevronRight, ListPlus, Undo2, Unlock, FilePlus2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { Spinner } from "@appstrate/ui/components/spinner";
import {
  useIntegrationToolPolicy,
  useIntegrationToolPolicyActions,
  type ToolPolicyAction,
} from "../../hooks/use-integrations";
import {
  canonicalDefinitionJson,
  declarableTools,
  latestApprovals,
  reviewItems,
  type CatalogRow,
  type ReviewItem,
  type ToolPolicy,
} from "../../lib/integration-tool-policy";
import type { MenuAction } from "../../lib/menu-action";
import { ConfirmModal } from "../confirm-modal";
import { DraftDiffView } from "../draft-diff-view";
import { JsonView } from "../json-view";
import { ToolPolicySkeleton } from "../loading-skeletons";
import { ErrorState } from "../page-states";
import type { PackageTool } from "../package-detail/package-tool-catalog";
import { SettingsHeading } from "../settings/settings-heading";

/** What the draft editor lends: the declared names and the way to declare more. */
export interface ToolDeclaration {
  declared: ReadonlySet<string>;
  declare: (names: string[]) => void;
}

/** What the reader may do about the tools of the integration, and what frames it. */
export interface ToolPolicyAccess {
  packageId: string;
  /** The working space's decisions (approve, block) are offered: the caller's verdict. */
  review: boolean;
  /** Present when the reader edits the draft: tools can be declared in the integration. */
  declaration?: ToolDeclaration;
  /** Drawn above the table: the space the decisions are for, and why they may be out of reach. */
  banner?: ReactNode;
}

/** What the tools table takes from the policy: entries for its menus, rows it lacks. */
export interface ToolPolicyControls {
  /** The tool's entries of the row menu. */
  rowActions: (tool: { name: string }) => MenuAction[];
  /** A write on the tool is in flight: its row waits. */
  isBusy: (name: string) => boolean;
  /** The list-level entries (declare every listed tool). */
  listActions: MenuAction[];
  /** Blocked tools the catalog no longer carries, as rows, so they can still be unblocked. */
  extraRows: PackageTool[];
}

const NO_CONTROLS: ToolPolicyControls = {
  rowActions: () => [],
  isBusy: () => false,
  listActions: [],
  extraRows: [],
};

type Approval = { name: string; fingerprint: string };
type Confirm =
  { kind: "block" | "revoke"; name: string } | { kind: "approveAll"; items: Approval[] };

/**
 * Wraps the tools table: `children` draws it with the controls, the review follows. Without
 * `access` the table stands alone.
 */
export function IntegrationToolPolicySection({
  access,
  tools,
  children,
}: {
  access?: ToolPolicyAccess;
  /** The detail's `tool_catalog`: the statuses say which tools wait. */
  tools: readonly CatalogRow[];
  children: (controls: ToolPolicyControls) => ReactNode;
}) {
  // Only the space's decisions read the policy: declaring works from the catalog alone.
  const query = useIntegrationToolPolicy(access?.packageId, access?.review ?? false);
  const actions = useIntegrationToolPolicyActions(access?.packageId ?? "");
  if (!access) return children(NO_CONTROLS);
  return (
    <ToolPolicyView
      policy={query.data ?? null}
      error={query.data ? null : query.error}
      tools={tools}
      review={access.review}
      declaration={access.declaration}
      banner={access.banner}
      pending={actions.isPending}
      onApprove={actions.approve}
      onBlock={actions.block}
      onRevoke={actions.revoke}
      onUnblock={actions.unblock}
    >
      {children}
    </ToolPolicyView>
  );
}

/** The section's structure; `ToolPolicySkeleton` stands for its review while the policy loads. */
export function ToolPolicyView({
  policy,
  error = null,
  tools,
  review,
  declaration,
  banner,
  pending,
  onApprove,
  onBlock,
  onRevoke,
  onUnblock,
  children,
}: {
  /** `null`: not read yet. */
  policy: ToolPolicy | null;
  error?: unknown;
  tools: readonly CatalogRow[];
  /** Approve, block and the review: the space's decisions. */
  review: boolean;
  declaration?: ToolDeclaration;
  banner?: ReactNode;
  /** Whether a write of that kind is in flight for that tool: only its own row waits on it. */
  pending: (action: ToolPolicyAction, name: string) => boolean;
  /** `onDone` runs on success: a confirmation closes then, not on the click. */
  onApprove: (items: Approval[], onDone?: () => void) => void;
  onBlock: (name: string, onDone: () => void) => void;
  onRevoke: (name: string, onDone: () => void) => void;
  onUnblock: (name: string) => void;
  children: (controls: ToolPolicyControls) => ReactNode;
}) {
  const { t } = useTranslation("agents");
  // Blocking, withdrawing an approval and approving many at once change what every agent of the
  // space may call, like deactivating a package there (which asks): they ask too. Approving one
  // tool, whose definition sits beside the button, and unblocking give back and do not.
  // The target outlives the dialog's close, so its title keeps the name while it fades out.
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ask = (next: Confirm) => {
    setConfirm(next);
    setConfirmOpen(true);
  };
  // A tool's row is locked while any write on it is in flight; the others stay usable.
  const isBusy = (name: string) =>
    (["approve", "revoke", "block", "unblock"] as const).some((action) => pending(action, name));

  const decided = review ? policy : null;
  const items = decided ? reviewItems(tools, decided) : [];
  const approvable = items.flatMap((item) =>
    item.fingerprint === null ? [] : [{ name: item.name, fingerprint: item.fingerprint }],
  );
  const approved = new Set(decided ? latestApprovals(decided.approvals).keys() : []);
  const blocked = new Set(decided?.blocks.map((block) => block.tool_name));
  const inCatalog = new Set(tools.map((tool) => tool.name));
  const declarable = new Set(declaration ? declarableTools(tools) : []);
  const toDeclare = [...declarable].filter((name) => !declaration?.declared.has(name));

  const rowActions = (tool: { name: string }): MenuAction[] => {
    const { name } = tool;
    const disabled = isBusy(name);
    const out: MenuAction[] = [];
    if (declaration && declarable.has(name) && !declaration.declared.has(name)) {
      out.push({
        id: "declare",
        label: t("integrationTools.policy.declare.button"),
        icon: FilePlus2,
        onSelect: () => declaration.declare([name]),
        testId: `tool-declare-${name}`,
      });
    }
    if (!decided) return out;
    const waiting = items.filter((item) => item.name === name);
    if (waiting.length === 1 && waiting[0]!.fingerprint !== null) {
      const fingerprint = waiting[0]!.fingerprint;
      out.push({
        id: "approve",
        label: t("integrationTools.policy.approve"),
        icon: Check,
        disabled,
        onSelect: () => onApprove([{ name, fingerprint }]),
      });
    }
    if (blocked.has(name)) {
      out.push({
        id: "unblock",
        label: t("integrationTools.policy.unblock"),
        icon: Unlock,
        disabled,
        onSelect: () => onUnblock(name),
      });
    }
    if (approved.has(name)) {
      out.push({
        id: "revoke",
        label: t("integrationTools.policy.revoke"),
        icon: Undo2,
        destructive: true,
        disabled,
        onSelect: () => ask({ kind: "revoke", name }),
      });
    }
    if (inCatalog.has(name) && !blocked.has(name)) {
      out.push({
        id: "block",
        label: t("integrationTools.policy.block"),
        icon: Ban,
        destructive: true,
        disabled,
        onSelect: () => ask({ kind: "block", name }),
      });
    }
    return out;
  };
  const controls: ToolPolicyControls = {
    rowActions,
    isBusy,
    listActions:
      declaration && toDeclare.length > 0
        ? [
            {
              id: "declare-all",
              label: t("integrationTools.policy.declare.all"),
              icon: ListPlus,
              onSelect: () => declaration.declare(toDeclare),
              testId: "tool-declare-all",
            },
          ]
        : [],
    extraRows: [...blocked]
      .filter((name) => !inCatalog.has(name))
      .map((name) => ({ name, status: "blocked" as const })),
  };

  return (
    <div className="flex flex-col gap-4" data-testid="integration-tool-policy">
      {banner}
      {children(controls)}
      {review && (
        <section data-testid="tool-review">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SettingsHeading
              level="group"
              title={t("integrationTools.policy.review.title")}
              description={t("integrationTools.policy.review.description")}
              className="mb-3"
            />
            {approvable.length > 1 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={approvable.some((item) => isBusy(item.name))}
                onClick={() => ask({ kind: "approveAll", items: approvable })}
                data-testid="tool-approve-all"
              >
                {t("integrationTools.policy.approveAll")}
              </Button>
            )}
          </div>
          {!policy ? (
            error ? (
              <ErrorState error={error} />
            ) : (
              <ToolPolicySkeleton />
            )
          ) : items.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("integrationTools.policy.review.none")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => {
                const { fingerprint } = item;
                return (
                  <li
                    key={`${item.name}:${item.fingerprint}`}
                    className="flex flex-col gap-3 rounded-lg border p-4"
                    data-testid={`tool-review-${item.name}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-sm font-medium break-words">{item.name}</span>
                        {item.description && (
                          // The whole description is in the definition below.
                          <span className="text-muted-foreground line-clamp-3 text-sm break-words">
                            {item.description}
                          </span>
                        )}
                        <div className="flex flex-wrap items-center gap-2 empty:hidden">
                          {item.approved && (
                            <Badge variant="outline" className="w-fit">
                              {t("integrationTools.policy.review.changed")}
                            </Badge>
                          )}
                          {/* The server's own claims about itself: labelled as such, never a verdict. */}
                          {item.hints.readOnly && (
                            <Badge variant="secondary" className="w-fit font-normal">
                              {t("integrationTools.policy.review.hint.readOnly")}
                            </Badge>
                          )}
                          {item.hints.destructive && (
                            <Badge variant="destructive" className="w-fit font-normal">
                              {t("integrationTools.policy.review.hint.destructive")}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {fingerprint !== null && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={isBusy(item.name)}
                            aria-label={t("integrationTools.policy.aria.approve", {
                              name: item.name,
                            })}
                            onClick={() => onApprove([{ name: item.name, fingerprint }])}
                          >
                            {pending("approve", item.name) && <Spinner />}
                            {t("integrationTools.policy.approve")}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={isBusy(item.name)}
                          aria-label={t("integrationTools.policy.aria.block", { name: item.name })}
                          onClick={() => ask({ kind: "block", name: item.name })}
                        >
                          {pending("block", item.name) && <Spinner />}
                          {t("integrationTools.policy.block")}
                        </Button>
                      </div>
                    </div>
                    {/* Many cards: only a changed definition, the one worth a diff, opens by itself. */}
                    <DefinitionCompare
                      item={item}
                      defaultOpen={items.length <= 3 || item.approved !== null}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={
          confirm?.kind === "approveAll"
            ? t("integrationTools.policy.confirm.approveAll.title", { count: confirm.items.length })
            : confirm?.kind === "revoke"
              ? t("integrationTools.policy.confirm.revoke.title", { name: confirm.name })
              : t("integrationTools.policy.confirm.block.title", { name: confirm?.name ?? "" })
        }
        description={
          confirm?.kind === "approveAll"
            ? t("integrationTools.policy.confirm.approveAll.description")
            : confirm?.kind === "revoke"
              ? t("integrationTools.policy.confirm.revoke.description")
              : t("integrationTools.policy.confirm.block.description")
        }
        confirmLabel={t(
          confirm?.kind === "approveAll"
            ? "integrationTools.policy.approveAll"
            : confirm?.kind === "revoke"
              ? "integrationTools.policy.revoke"
              : "integrationTools.policy.block",
        )}
        isPending={
          confirm?.kind === "approveAll"
            ? confirm.items.some((item) => pending("approve", item.name))
            : confirm
              ? pending(confirm.kind, confirm.name)
              : false
        }
        onConfirm={() => {
          if (!confirm) return;
          const close = () => setConfirmOpen(false);
          if (confirm.kind === "approveAll") onApprove(confirm.items, close);
          else if (confirm.kind === "block") onBlock(confirm.name, close);
          else onRevoke(confirm.name, close);
        }}
      />
    </div>
  );
}

/** The listed definition: as a diff against the approved one when this replaces it, as is otherwise. */
function DefinitionCompare({
  item,
  defaultOpen = true,
}: {
  item: ReviewItem;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation("agents");
  if (item.fingerprint === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("integrationTools.policy.review.notListed")}
      </p>
    );
  }
  // Approving makes the tool callable by every agent of the space: what it grants sits next to Approve.
  const current = item.definition;
  const previous = item.approved?.definition ?? null;
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
        {t("integrationTools.policy.review.definition")}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2" data-testid={`tool-definition-${item.name}`}>
        {current === null ? (
          <p className="text-muted-foreground text-sm">
            {t("integrationTools.policy.review.definitionTooLarge")}
          </p>
        ) : previous !== null ? (
          <DraftDiffView
            language="json"
            original={canonicalDefinitionJson(previous)}
            modified={canonicalDefinitionJson(current)}
            originalLabel={t("integrationTools.policy.review.approvedDefinition")}
            modifiedLabel={t("integrationTools.policy.review.currentDefinition")}
          />
        ) : (
          <JsonView data={current} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
