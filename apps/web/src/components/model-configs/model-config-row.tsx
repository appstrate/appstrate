// SPDX-License-Identifier: Apache-2.0

/**
 * One configuration of Settings › Models, as a collapsible row. Collapsed: its logo, its label,
 * a one-line summary, its state, the repair it needs and the chevron. Open: its connections (the
 * organization's, the switch for members' own, theirs), then its models.
 *
 * Every deed is offered as the server allows it: a connection's by its `allowed_actions`, the
 * configuration's by the caller's permissions (`can`).
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  FlaskConical,
  KeyRound,
  ListChecks,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@appstrate/ui/components/item";
import { Switch } from "@appstrate/ui/components/switch";
import { cn } from "@appstrate/ui/cn";
import { useConnectionTest } from "../../hooks/use-connection-test";
import {
  useTestModelProviderCredential,
  type ModelProviderCredentialInfo,
  type ProviderRegistryEntry,
} from "../../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../../hooks/use-models";
import {
  configState,
  onlySubscriptions,
  orgConnectionSummary,
  type ConfigState,
  type ConnectChoice,
  type ModelConfigInfo,
} from "../../lib/model-configs";
import { PROVIDER_ICONS } from "../icons";
import { InlineEditableLabel } from "../inline-editable-label";
import { TableRowActions } from "../table-row-actions";
import { TestResultSpan } from "../test-result-span";
import { ConnectMenu } from "./connect-menu";
import { ModelChips } from "./model-chips";
import { MODEL_ROW_ACTIONS, MODEL_ROW_ITEM, MODEL_ROW_MENUS } from "./row-layout";

/** What the caller may do to a configuration (the connections answer for themselves). */
export interface ConfigPermissions {
  /** `models:write`: rename, endpoint, members' switch, the models. */
  writeModels: boolean;
  /** `models:delete`: delete the configuration. */
  deleteModels: boolean;
}

/** A connection's deeds, the row's menu offering each its `allowed_actions` holds. */
export interface ConnectionDeeds {
  onRename: (credential: ModelProviderCredentialInfo, label: string) => Promise<void>;
  /** A new key, or a subscription re-paired. */
  onReplace: (credential: ModelProviderCredentialInfo) => void;
  onDelete: (credential: ModelProviderCredentialInfo) => void;
}

const STATE_BADGE: Record<
  ConfigState,
  { variant: "success" | "pending" | "warning"; key: string }
> = {
  active: { variant: "success", key: "modelConfigs.state.active" },
  connect: { variant: "pending", key: "modelConfigs.state.connect" },
  reconnect: { variant: "warning", key: "modelConfigs.state.reconnect" },
};

export function ConfigStateBadge({ state }: { state: ConfigState | "system" }) {
  const { t } = useTranslation("settings");
  if (state === "system") {
    return <Badge variant="secondary">{t("modelConfigs.state.system")}</Badge>;
  }
  const { variant, key } = STATE_BADGE[state];
  return <Badge variant={variant}>{t(key)}</Badge>;
}

/** The logo of a configuration (its registry entry's), a server glyph for a gateway without one. */
export function ConfigLogo({ provider }: { provider: ProviderRegistryEntry | undefined }) {
  // A direct dict access: `react-hooks/static-components` flags a component taken from a call.
  const Icon = (provider && PROVIDER_ICONS[provider.iconUrl]) ?? Server;
  return (
    <ItemMedia variant="icon">
      <Icon />
    </ItemMedia>
  );
}

export function ModelConfigRow({
  config,
  provider,
  models,
  connections,
  orgConnectionCount,
  can,
  choices,
  defaultOpen = false,
  onConnect,
  onChooseModels,
  onOpenModel,
  onRename,
  onEditEndpoint,
  onDelete,
  onTogglePersonal,
  connectionDeeds,
}: {
  config: ModelConfigInfo;
  provider: ProviderRegistryEntry | undefined;
  /** The configuration's models, switched-off ones included. */
  models: readonly OrgModelInfo[];
  /** Its connections the caller can read. */
  connections: { org: ModelProviderCredentialInfo[]; personal: ModelProviderCredentialInfo[] };
  /** How many organization connections it has, `null` when the caller cannot read them. */
  orgConnectionCount: number | null;
  can: ConfigPermissions;
  /** The ways the caller may connect it (`connectChoices`). */
  choices: readonly ConnectChoice[];
  defaultOpen?: boolean;
  onConnect: (choice: ConnectChoice) => void;
  onChooseModels: () => void;
  onOpenModel: (model: OrgModelInfo) => void;
  onRename: (label: string) => Promise<void>;
  onEditEndpoint: () => void;
  onDelete: () => void;
  onTogglePersonal: (allowed: boolean) => void;
  connectionDeeds: ConnectionDeeds;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [open, setOpen] = useState(defaultOpen);
  const [renaming, setRenaming] = useState(false);
  const state = configState(config);
  const enabled = models.filter((m) => m.enabled || m.is_default);
  const orgChoices = choices.filter((c) => c.owner === "org");
  const repair =
    state === "active" ? null : (
      <ConnectMenu
        choices={state === "reconnect" ? orgChoices : choices}
        label={t(
          state === "reconnect" ? "modelConfigs.connect.reconnect" : "modelConfigs.connect.action",
        )}
        variant="default"
        onPick={onConnect}
      />
    );

  const orgSummary = orgConnectionSummary(config.org_connection, orgConnectionCount);
  const summary = [
    t("modelConfigs.summary.models", { count: enabled.length }),
    "count" in orgSummary ? t(orgSummary.key, { count: orgSummary.count }) : t(orgSummary.key),
    ...(config.personal_connections_allowed && config.personal_connection_count !== null
      ? [t("modelConfigs.summary.personal", { count: config.personal_connection_count })]
      : []),
  ].join(" · ");

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="@container/row rounded-md border"
      data-row
    >
      <Item size="sm" className={MODEL_ROW_ITEM}>
        <ConfigLogo provider={provider} />
        <ItemContent className="min-w-0">
          <ItemTitle className="max-w-full min-w-0">
            <InlineEditableLabel
              value={config.label}
              editable={can.writeModels}
              editing={renaming}
              onEditingChange={setRenaming}
              onSave={onRename}
            />
          </ItemTitle>
          <ItemDescription>{summary}</ItemDescription>
        </ItemContent>
        <ItemActions className={MODEL_ROW_ACTIONS}>
          <ConfigStateBadge state={state} />
          {repair}
          <div className={MODEL_ROW_MENUS}>
            <TableRowActions
              menuLabel={t("modelConfigs.menu", { label: config.label })}
              renaming={renaming}
              actions={[
                {
                  id: "rename",
                  icon: Pencil,
                  label: t("btn.rename", { ns: "common" }),
                  onSelect: () => setRenaming(true),
                  hidden: !can.writeModels,
                },
                {
                  id: "endpoint",
                  icon: Server,
                  label: t("modelConfigs.editEndpoint"),
                  onSelect: onEditEndpoint,
                  hidden: !can.writeModels || config.base_url === null,
                },
                {
                  id: "delete",
                  icon: Trash2,
                  label: t("btn.delete", { ns: "common" }),
                  onSelect: onDelete,
                  destructive: true,
                  hidden: !can.deleteModels,
                },
              ]}
            />
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  aria-label={t(open ? "modelConfigs.collapse" : "modelConfigs.expand", {
                    label: config.label,
                  })}
                />
              }
            >
              <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
            </CollapsibleTrigger>
          </div>
        </ItemActions>
      </Item>
      <CollapsibleContent>
        <div className="flex flex-col gap-6 border-t px-4 py-4">
          <ConnectionsSection
            config={config}
            connections={connections}
            can={can}
            choices={choices}
            onConnect={onConnect}
            onTogglePersonal={onTogglePersonal}
            deeds={connectionDeeds}
          />
          <Section
            title={t("modelConfigs.models.title")}
            action={
              can.writeModels && (
                <Button type="button" size="sm" variant="outline" onClick={onChooseModels}>
                  <ListChecks />
                  {t("modelConfigs.models.choose")}
                </Button>
              )
            }
          >
            <ModelChips models={enabled} onOpen={can.writeModels ? onOpenModel : undefined} />
          </Section>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function ConnectionsSection({
  config,
  connections,
  can,
  choices,
  onConnect,
  onTogglePersonal,
  deeds,
}: {
  config: ModelConfigInfo;
  connections: { org: ModelProviderCredentialInfo[]; personal: ModelProviderCredentialInfo[] };
  can: ConfigPermissions;
  choices: readonly ConnectChoice[];
  onConnect: (choice: ConnectChoice) => void;
  onTogglePersonal: (allowed: boolean) => void;
  deeds: ConnectionDeeds;
}) {
  const { t } = useTranslation("settings");
  const test = useConnectionTest(useTestModelProviderCredential());
  const line = (credential: ModelProviderCredentialInfo, owner?: string) => (
    <ConnectionLine
      key={credential.id}
      credential={credential}
      owner={owner}
      deeds={deeds}
      testing={test.testingIds.has(credential.id)}
      result={test.testResults[credential.id] ?? null}
      onTest={() => void test.handleTest(credential.id)}
    />
  );

  return (
    <Section
      title={t("modelConfigs.connections.title")}
      action={
        <ConnectMenu
          choices={choices}
          label={t("modelConfigs.connect.action")}
          onPick={onConnect}
        />
      }
    >
      {config.org_connection === "none" && (
        <Alert size="sm">
          <AlertDescription>{t("modelConfigs.connections.noOrg")}</AlertDescription>
        </Alert>
      )}
      {onlySubscriptions(connections.org) && (
        <Alert size="sm" variant="warning">
          <AlertDescription>{t("modelConfigs.connections.onlySubscriptions")}</AlertDescription>
        </Alert>
      )}
      {connections.org.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {connections.org.map((c) => line(c))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div id={`personal-${config.id}`} className="text-sm font-medium">
            {config.personal_connection_count === null
              ? t("modelConfigs.connections.personal")
              : t("modelConfigs.connections.personalCount", {
                  count: config.personal_connection_count,
                })}
          </div>
          <div className="text-muted-foreground text-xs">
            {t("modelConfigs.connections.personalHint")}
          </div>
        </div>
        <Switch
          aria-labelledby={`personal-${config.id}`}
          checked={config.personal_connections_allowed}
          disabled={!can.writeModels}
          onCheckedChange={(checked) => onTogglePersonal(checked)}
        />
      </div>
      {connections.personal.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {connections.personal.map((c) => line(c, c.owner_name ?? undefined))}
        </ul>
      )}
    </Section>
  );
}

function ConnectionLine({
  credential,
  owner,
  deeds,
  testing,
  result,
  onTest,
}: {
  credential: ModelProviderCredentialInfo;
  /** A member's connection: who holds it. */
  owner?: string;
  deeds: ConnectionDeeds;
  testing: boolean;
  result: Parameters<typeof TestResultSpan>[0]["result"] | null;
  onTest: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [renaming, setRenaming] = useState(false);
  const allowed = new Set(credential.allowed_actions);
  const subscription = credential.authMode === "oauth2";
  const detail = subscription
    ? (credential.oauth_email ?? t("modelConfigs.connections.subscription"))
    : t("modelConfigs.connections.apiKey");

  return (
    <li data-row className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {owner ? (
            <span className="truncate font-medium">{owner}</span>
          ) : (
            <InlineEditableLabel
              value={credential.label}
              editable={allowed.has("edit")}
              editing={renaming}
              onEditingChange={setRenaming}
              onSave={(label) => deeds.onRename(credential, label)}
            />
          )}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {owner ? `${credential.label} · ${detail}` : detail}
        </div>
      </div>
      {result && (
        <TestResultSpan
          result={result}
          successKey="credentials.testSuccess"
          failedKey="credentials.testFailed"
        />
      )}
      <Badge variant={credential.needs_reconnection ? "warning" : "success"}>
        {t(
          credential.needs_reconnection
            ? "modelConfigs.state.reconnect"
            : "modelConfigs.connections.active",
        )}
      </Badge>
      <TableRowActions
        menuLabel={t("modelConfigs.connections.menu", { label: credential.label })}
        renaming={renaming}
        isPending={testing}
        actions={[
          {
            id: "rename",
            icon: Pencil,
            label: t("btn.rename", { ns: "common" }),
            onSelect: () => setRenaming(true),
            hidden: !allowed.has("edit") || !!owner,
          },
          {
            id: "replace",
            icon: subscription ? RefreshCw : KeyRound,
            label: subscription ? t("modelConfigs.connect.reconnect") : t("credentials.edit"),
            onSelect: () => deeds.onReplace(credential),
            hidden: subscription ? !allowed.has("reconnect") : !allowed.has("edit"),
          },
          {
            id: "test",
            icon: FlaskConical,
            label: t("credentials.test"),
            onSelect: onTest,
            hidden: !allowed.has("test"),
          },
          {
            id: "delete",
            icon: Trash2,
            label: t("btn.delete", { ns: "common" }),
            onSelect: () => deeds.onDelete(credential),
            destructive: true,
            hidden: !allowed.has("delete"),
          },
        ]}
      />
    </li>
  );
}
