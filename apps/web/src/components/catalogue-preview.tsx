// SPDX-License-Identifier: Apache-2.0

/**
 * One package, read inside the catalogue rather than on its own page (which would drop
 * the panel and claim the current space for a package that may not be in it).
 *
 * Answers what it is, where it is and what the reader may do there (graded by their
 * rights, `lib/catalogue-sheet.ts`), and what it needs. Skills are named, never linked:
 * one not shared to the reader's space would 404. A skill also carries a per-space
 * `chat_enforced` switch.
 */
import { Alert } from "@appstrate/ui/components/alert";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  Clock,
  Hammer,
  Hash,
  History,
  House,
  Inbox,
  Layers,
  Plug,
  ShieldCheck,
  TextCursorInput,
  Wrench,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import { AlertTitle } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Switch } from "@appstrate/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import type { PackageType } from "@appstrate/core/validation";
import {
  useSetChatEnforced,
  type LibraryPackageItem,
  type LibrarySpace,
} from "../hooks/use-library";
import { ApiError } from "../api/errors";
import { fetchPackageDetail, useVersionInfo } from "../hooks/use-packages";
import { TextSkeleton } from "./loading-skeletons";
import { useCurrentOrgId, useOrg } from "../hooks/use-org";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { missingIntegrations } from "../lib/activation-closure";
import { chatEnforceErrorKey } from "../lib/chat-enforce-errors";
import { toastError } from "../lib/mutation-error";
import { detailSpace, type CataloguePlacement } from "../lib/catalogue-placement";
import { ACTIVATION_REFUSAL_KEY, type ActivationGate } from "../lib/catalogue-gates";
import { CATALOGUE_TYPE_LABEL_KEY } from "../lib/catalogue-link";
import {
  pinnedVersionState,
  sheetChatEnforce,
  sheetOffers,
  sheetSpaceMode,
  sheetSpaceRows,
  type SheetSpaceRow,
} from "../lib/catalogue-sheet";
import { formatDateField } from "../lib/format-date";
import { packageKeys } from "../lib/query-keys";
import { ConfirmModal } from "./confirm-modal";
import { SettingsGroup } from "./settings/setting-row";
import { SettingsHeading } from "./settings/settings-heading";

/** The alert's words per state, spelled out so the locale test sees every key. */
const PINNED_ALERT_KEYS = {
  missing: {
    title: "catalogue.sheet.pinned.missingTitle",
    body: "catalogue.sheet.pinned.missingBody",
  },
  behind: {
    title: "catalogue.sheet.pinned.behindTitle",
    body: "catalogue.sheet.pinned.behindBody",
  },
} as const;

/** The input fields an agent asks for, by the title a launch form shows. */
function inputNames(detail: AgentDetail): string[] {
  const schema = detail.input?.schema as
    { properties?: Record<string, { title?: string }> } | undefined;
  const properties = schema?.properties ?? {};
  const order = detail.input?.property_order ?? Object.keys(properties);
  return order.map((key) => properties[key]?.title ?? key);
}

/** One fact about the package: icon and label on the left, value on the right. */
function PropertyRow({
  icon: Icon,
  label,
  hint,
  children,
}: {
  icon: typeof House;
  label: string;
  /** The rule behind the value, when it is not obvious from the value itself. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    // One line, always (same height): a long value is truncated with its text in `title`.
    <div className="flex h-10 items-center gap-4">
      <dt className="text-muted-foreground flex w-40 shrink-0 items-center gap-2 text-sm">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-baseline gap-3 text-sm">
        <span
          className="min-w-0 truncate"
          title={typeof children === "string" ? children : undefined}
        >
          {children}
        </span>
        {hint && (
          <span className="text-muted-foreground ml-auto hidden shrink-0 text-xs sm:inline">
            {hint}
          </span>
        )}
      </dd>
    </div>
  );
}

export function CataloguePreview({
  item,
  type,
  spaces,
  placement,
  gateOf,
  mayConfigureIn,
  integrations,
  agents,
  protocol,
  actionsMenu,
  pinnedVersion,
  onUnpin,
  busy,
  onSetActive,
}: {
  item: LibraryPackageItem;
  type: PackageType;
  spaces: LibrarySpace[];
  /** The row's placement, as the catalogue's own table reads it. */
  placement: CataloguePlacement;
  /** The reader's verdict for switching it on (`next: true`) or off in a space. */
  gateOf: (spaceId: string, next: boolean) => ActivationGate;
  /** The placement PATCH's `configure` gate (what imposing a skill on a space's chat asks); no personal-space exemption. */
  mayConfigureIn: (spaceId: string) => boolean;
  /** The library's integrations: what an agent's switch-on would still need. */
  integrations: LibraryPackageItem[];
  /** The library's agents: which dependents of this package the reader may be told about. */
  agents: LibraryPackageItem[];
  /** An integration's protocol, when the catalogue knows it. */
  protocol?: string;
  /** The package's Actions menu, built by the catalogue that owns its dialogs. */
  actionsMenu?: ReactNode;
  /**
   * The published version the address asked to read. The sheet then draws that
   * version's content; its spaces and switches are the package's, which run the
   * latest published version whatever is read here.
   */
  pinnedVersion?: string;
  /** Reads the package as the reader would see it again (drops the pinned version). */
  onUnpin?: () => void;
  busy: boolean;
  /** Goes through the catalogue's own activation, which asks about integrations first. */
  onSetActive: (spaceId: string, next: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { currentOrg } = useOrg();
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const from = detailSpace(placement, spaces, currentSpaceId);
  const {
    data: detail,
    isLoading: detailLoading,
    error: detailError,
  } = useQuery({
    queryKey: packageKeys.detail(
      PACKAGE_TYPE_ROUTE_SEGMENT[type],
      orgId,
      from ?? null,
      item.id,
      pinnedVersion ?? null,
    ),
    queryFn: () => fetchPackageDetail(type, item.id, pinnedVersion, from),
    enabled: !!orgId && !!from,
    // The sheet reads without the detail; a refusal is not worth a retry.
    retry: false,
  });
  // A pinned version the server answers 404 for was deleted since the link was made.
  const { data: versionInfo } = useVersionInfo(type, pinnedVersion ? item.id : undefined);
  const pinState = pinnedVersionState({
    pinned: pinnedVersion,
    missing: detailError instanceof ApiError && detailError.status === 404,
    latestPublished: versionInfo?.latest_published_version,
  });
  const agent = type === "agent" ? (detail as AgentDetail | undefined) : undefined;
  const other = type !== "agent" ? (detail as OrgPackageItemDetail | undefined) : undefined;

  const rows = sheetSpaceRows(placement, spaces, gateOf, currentSpaceId);
  const mode = sheetSpaceMode(rows);
  const offers = sheetOffers(rows);
  const home = spaces.find((space) => space.id === placement.homeSpaceId);
  const integrationName = (id: string) => integrations.find((row) => row.id === id)?.name || id;
  /** What this space would still have to switch on for the agent to start. */
  const missingIn = (spaceId: string): string[] =>
    agent
      ? missingIntegrations(agent.dependencies.integrations, integrations, spaceId, () => true).map(
          (entry) => entry.name,
        )
      : [];

  const provenance =
    item.source === "system"
      ? t("catalogue.sourceSystem")
      : t("catalogue.sourceOrg", { name: currentOrg?.name ?? "" });
  const version = detail?.version ?? pinnedVersion;
  // The package's own timestamp: it dates no version, so a pinned sheet shows none.
  const updatedAt = pinnedVersion ? undefined : (agent?.updatedAt ?? other?.updatedAt);
  // A version carries its own description; the row's is the current one's.
  const description = (pinnedVersion ? detail?.description : undefined) || item.description;

  const stateLabel = (row: SheetSpaceRow) => {
    const base =
      row.state === "active"
        ? t("catalogue.filter.active")
        : row.state === "inactive"
          ? t("catalogue.filter.inactive")
          : row.state === "offered"
            ? row.offeredBy
              ? t("catalogue.sheet.offeredBy", { name: row.offeredBy })
              : t("catalogue.offeredHere")
            : t("catalogue.sheet.absent");
    return row.home ? t("catalogue.sheet.atHome", { state: base }) : base;
  };
  const switchFor = (row: SheetSpaceRow) => (
    <Switch
      checked={row.state === "active"}
      disabled={busy || !row.mayToggle}
      aria-label={t("catalogue.spaceSwitch", { package: item.name || item.id, space: row.name })}
      title={row.refusal ? t(ACTIVATION_REFUSAL_KEY[row.refusal], { ns: "common" }) : undefined}
      onCheckedChange={(next) => onSetActive(row.id, next === true)}
    />
  );
  // ── Imposed on the chat (skills only, `lib/catalogue-sheet`) ──
  const setChatEnforced = useSetChatEnforced();
  const [confirmEnforce, setConfirmEnforce] = useState<SheetSpaceRow | null>(null);
  const enforceable = type === "skill";
  const chatEnforcedIn = (spaceId: string) =>
    item.placements.some((entry) => entry.space_id === spaceId && entry.chat_enforced);
  const enforcesAnywhere = enforceable && rows.some((row) => chatEnforcedIn(row.id));
  const notifyEnforceError = (err: unknown) => {
    const key = chatEnforceErrorKey(err);
    if (key) toast.error(t(key, { ns: "common" }));
    else toastError(err);
  };
  const enforceSwitchFor = (row: SheetSpaceRow) => {
    const verdict = sheetChatEnforce(type, row, {
      enforced: chatEnforcedIn(row.id),
      published: item.published,
      mayConfigure: mayConfigureIn(row.id),
    });
    if (!verdict) return null;
    const pending =
      setChatEnforced.isPending &&
      setChatEnforced.variables?.packageId === item.id &&
      setChatEnforced.variables.spaceId === row.id;
    return (
      <Switch
        checked={verdict.checked}
        disabled={verdict.disabled || pending}
        aria-label={t("library.chatEnforce.toggle", {
          ns: "common",
          package: item.name || item.id,
          space: row.name,
        })}
        title={
          verdict.refusal === "configure"
            ? t("library.chatEnforce.cannot", { ns: "common" })
            : verdict.refusal === "publishFirst"
              ? t("library.chatEnforce.publishFirst", { ns: "common" })
              : undefined
        }
        onCheckedChange={(next) => {
          // Imposing discloses the content to every member who chats there: confirm first.
          if (next) setConfirmEnforce(row);
          else
            setChatEnforced.mutate(
              { spaceId: row.id, packageId: item.id, enforced: false },
              { onError: notifyEnforceError },
            );
        }}
      />
    );
  };

  const singleEnforce = mode === "single" && rows[0] ? enforceSwitchFor(rows[0]) : null;

  const missingText = (spaceId: string) => {
    const names = missingIn(spaceId);
    return names.length > 0 ? t("catalogue.sheet.missing", { names: names.join(", ") }) : null;
  };

  const missingAnywhere = rows.some((row) => missingIn(row.id).length > 0);
  // Narrowed to the reader's OWN library: `getOrgItem` counts dependents org-wide
  // (`findDependentPackages`), which would name agents homed in spaces they cannot enter.
  const usedBy = (other?.agents ?? []).filter((entry) => agents.some((row) => row.id === entry.id));
  const agentSkills = agent?.dependencies.skills ?? [];
  const agentInputs = agent ? inputNames(agent) : [];
  const runtimeTools = Array.isArray(agent?.manifest?.runtime_tools)
    ? (agent.manifest.runtime_tools as unknown[]).length
    : 0;

  return (
    <div>
      {offers.map((offer) => (
        <Alert key={offer.id} variant="info" className="mb-5">
          <Inbox className="size-4" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <AlertTitle>
                {offer.offeredBy
                  ? t("catalogue.sheet.offerBy", { name: offer.offeredBy, space: offer.name })
                  : t("catalogue.sheet.offer", { space: offer.name })}
              </AlertTitle>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {missingText(offer.id) ?? t("catalogue.sheet.offerCredentials")}
              </p>
            </div>
            {offer.mayToggle && (
              <Button size="sm" disabled={busy} onClick={() => onSetActive(offer.id, true)}>
                {t("catalogue.sheet.activateIn", { space: offer.name })}
              </Button>
            )}
          </div>
        </Alert>
      ))}

      <div className="flex items-start justify-between gap-4">
        <SettingsHeading className="mb-2" title={item.name || item.id} />
        <div className="flex shrink-0 items-center gap-3">{actionsMenu}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{t(CATALOGUE_TYPE_LABEL_KEY[type])}</Badge>
        {version && (
          <Badge variant="secondary" className="font-mono">
            v{version}
          </Badge>
        )}
        {pinState && (
          <Badge variant="secondary" className="gap-1.5">
            <History className="size-3" aria-hidden />
            {t("catalogue.sheet.pinned.badge")}
          </Badge>
        )}
        <Badge variant="secondary" className="gap-1.5">
          {item.source === "system" && <ShieldCheck className="size-3" aria-hidden />}
          {provenance}
        </Badge>
      </div>

      {/* A version read by address is not the one the spaces run: say so, and
          offer the way back, rather than leave the reader to infer it from a badge. */}
      {(pinState === "missing" || pinState === "behind") && (
        <Alert variant={pinState === "missing" ? "warning" : "info"} className="mt-4">
          <History className="h-4 w-4" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <AlertTitle>
                {t(PINNED_ALERT_KEYS[pinState].title, { version: pinnedVersion })}
              </AlertTitle>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t(PINNED_ALERT_KEYS[pinState].body, {
                  version: pinnedVersion,
                  latest: versionInfo?.latest_published_version,
                })}
              </p>
            </div>
            {onUnpin && (
              <Button variant="outline" size="sm" onClick={onUnpin}>
                {t("catalogue.sheet.pinned.unpin")}
              </Button>
            )}
          </div>
        </Alert>
      )}

      {description && <p className="mt-4 text-sm">{description}</p>}
      {/* "À propos" comes FIRST, in the same order for every type; what varies by type follows. */}
      <SettingsGroup title={t("orgSettings.tabGeneral")} className="mt-6 mb-6">
        <dl className="divide-border divide-y border-t">
          {protocol && (
            <PropertyRow icon={Plug} label={t("catalogue.column.protocol")}>
              {protocol}
            </PropertyRow>
          )}
          {usedBy.length > 0 && (
            <PropertyRow icon={Layers} label={t("catalogue.sheet.usedBy")}>
              {usedBy.map((entry) => entry.display_name || entry.id).join(", ")}
            </PropertyRow>
          )}
          {home && (
            <PropertyRow
              icon={House}
              label={t("catalogue.homeSpace")}
              hint={t("catalogue.sheet.homeHint")}
            >
              {home.name}
            </PropertyRow>
          )}
          {updatedAt && (
            <PropertyRow icon={Clock} label={t("catalogue.sheet.updated")}>
              {formatDateField(updatedAt, "date")}
            </PropertyRow>
          )}
          <PropertyRow icon={Hash} label={t("catalogue.identifier")}>
            <span className="font-mono text-xs break-all">{item.id}</span>
          </PropertyRow>
          {agentInputs.length > 0 && (
            <PropertyRow icon={TextCursorInput} label={t("catalogue.sheet.inputs")}>
              {agentInputs.join(", ")}
            </PropertyRow>
          )}
          {runtimeTools > 0 && (
            <PropertyRow icon={Hammer} label={t("catalogue.sheet.tools")}>
              {t("catalogue.sheet.toolCount", { count: runtimeTools })}
            </PropertyRow>
          )}
          {/* Held at their height so the groups below do not move when the detail lands. */}
          {detailLoading &&
            [0, 1].map((row) => (
              <div key={row} className="flex h-10 items-center">
                <Skeleton className="h-4 w-40" />
              </div>
            ))}
        </dl>
      </SettingsGroup>

      {detailLoading && type === "agent" && (
        <SettingsGroup title={t("catalogue.sheet.dependencies")} className="mb-6">
          <TextSkeleton lines={2} />
        </SettingsGroup>
      )}
      {agent && (
        <SettingsGroup title={t("catalogue.sheet.dependencies")} className="mb-6">
          <dl className="divide-border divide-y border-t">
            <PropertyRow
              icon={Boxes}
              label={t("common:nav.integrations")}
              hint={
                agent.dependencies.integrations.length > 0
                  ? t("catalogue.sheet.integrationsHint")
                  : undefined
              }
            >
              {agent.dependencies.integrations.length > 0
                ? agent.dependencies.integrations
                    .map((entry) => integrationName(entry.id))
                    .join(", ")
                : t("catalogue.sheet.none")}
            </PropertyRow>
            {agentSkills.length > 0 && (
              <PropertyRow
                icon={Wrench}
                label={t("common:nav.skills")}
                hint={t("catalogue.sheet.skillsHint")}
              >
                {agentSkills.map((skill) => skill.name ?? skill.id).join(", ")}
              </PropertyRow>
            )}
          </dl>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("orgSettings.inviteSpacesLabel")} className="mt-8 mb-0">
        {mode === "readonly" && (
          <p className="text-sm">
            {placement.activeIn.length > 0
              ? t("catalogue.sheet.activeIn", {
                  spaces: rows
                    .filter((row) => row.state === "active")
                    .map((row) => row.name)
                    .join(", "),
                })
              : t("catalogue.activeNowhere")}
          </p>
        )}
        {mode === "readonly" && enforcesAnywhere && (
          <p className="text-muted-foreground mt-1 text-sm">
            {t("catalogue.sheet.chatEnforcedIn", {
              spaces: rows
                .filter((row) => chatEnforcedIn(row.id))
                .map((row) => row.name)
                .join(", "),
            })}
          </p>
        )}
        {mode === "single" && rows[0] && (
          <div
            className={cn(
              "border-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm",
              rows[0].state === "offered" && "bg-primary/5",
            )}
          >
            <div className="min-w-0">
              <p>
                <span className="font-medium">{rows[0].name}</span>
                <span className="text-muted-foreground"> · {stateLabel(rows[0])}</span>
              </p>
              {missingText(rows[0].id) && (
                <p className="text-muted-foreground mt-0.5 text-xs">{missingText(rows[0].id)}</p>
              )}
            </div>
            {switchFor(rows[0])}
          </div>
        )}
        {singleEnforce && (
          <label className="border-border mt-2 flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
            <span>{t("library.column.chatEnforced", { ns: "common" })}</span>
            {singleEnforce}
          </label>
        )}
        {mode === "table" && (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("source.space")}</TableHead>
                  <TableHead>{t("providers.col.state")}</TableHead>
                  {missingAnywhere && <TableHead>{t("catalogue.sheet.missingColumn")}</TableHead>}
                  <TableHead className="w-px text-right whitespace-nowrap">
                    {t("catalogue.filter.active")}
                  </TableHead>
                  {enforceable && (
                    <TableHead className="w-px text-right whitespace-nowrap">
                      {t("library.column.chatEnforced", { ns: "common" })}
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className={row.state === "offered" ? "bg-primary/5" : ""}>
                    <TableCell className="font-medium">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{row.name}</span>
                        {row.id === currentSpaceId && (
                          <span className="bg-primary/15 text-primary rounded px-1 text-[10px] leading-4 font-medium">
                            {t("catalogue.here")}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{stateLabel(row)}</TableCell>
                    {missingAnywhere && (
                      <TableCell className="text-muted-foreground">
                        {missingIn(row.id).join(", ") || "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right">{switchFor(row)}</TableCell>
                    {enforceable && (
                      <TableCell className="text-right">{enforceSwitchFor(row)}</TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsGroup>

      {enforceable && (
        <ConfirmModal
          open={confirmEnforce !== null}
          onClose={() => setConfirmEnforce(null)}
          title={t("library.chatEnforce.confirmTitle", { ns: "common" })}
          description={t("library.chatEnforce.confirmDescription", {
            ns: "common",
            package: item.name || item.id,
            space: confirmEnforce?.name ?? "",
          })}
          confirmLabel={t("library.chatEnforce.confirm", { ns: "common" })}
          variant="default"
          isPending={setChatEnforced.isPending}
          onConfirm={() => {
            if (!confirmEnforce) return;
            setChatEnforced.mutate(
              { spaceId: confirmEnforce.id, packageId: item.id, enforced: true },
              { onError: notifyEnforceError, onSettled: () => setConfirmEnforce(null) },
            );
          }}
        />
      )}
    </div>
  );
}
