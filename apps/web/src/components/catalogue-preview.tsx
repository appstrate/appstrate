// SPDX-License-Identifier: Apache-2.0

/**
 * One package, read inside the catalogue rather than instead of it.
 *
 * A row used to link to the package's own page, which threw away the panel,
 * the space you were in and the list you were reading — and landed on a page
 * whose breadcrumb claims the current space for a package that is not in it.
 * This reads in place: the rail stays, Back comes straight back.
 *
 * It answers the three questions a reader opens it with, in their order:
 *
 * 1. **What is it?** Name, version, description, where it comes from.
 * 2. **Where is it, and what may I do there?** Its state in each space within
 *    reach, the switch on the same line, graded by the reader's rights
 *    (`lib/catalogue-sheet.ts`). An offer waiting on the reader heads the
 *    sheet, because it is the one line that asks them for a decision.
 * 3. **What does it need?** For an agent, its integrations, skills and inputs,
 *    and per space the integrations that space does not run yet. Skills travel
 *    with the agent (judged from its home) and are named, never linked: a skill
 *    not shared to the reader's space would open on a 404.
 *
 * A skill carries one more per-space fact beside its switch: whether that
 * space IMPOSES it on every chat conversation held there (`chat_enforced`).
 *
 * Runs, versions, files and settings stay on the package's own page, one link
 * away.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  Clock,
  Hammer,
  Hash,
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
import { Alert, AlertTitle } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
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
import { fetchPackageDetail } from "../hooks/use-packages";
import { useCurrentOrgId, useOrg } from "../hooks/use-org";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { missingIntegrations } from "../lib/activation-closure";
import { chatEnforceErrorKey } from "../lib/chat-enforce-errors";
import type { CataloguePlacement } from "../lib/catalogue-placement";
import {
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

/**
 * The space to read the package's detail FROM: the server answers only where
 * it is placed, and the catalogue shows packages placed elsewhere than the
 * space the reader stands in.
 */
function readingSpace(
  placement: CataloguePlacement,
  spaces: readonly LibrarySpace[],
  current: string | null,
): string | undefined {
  if (placement.here) return current ?? undefined;
  const reachable = (id: string | null) =>
    id && spaces.some((space) => space.id === id) ? id : undefined;
  return (
    reachable(placement.homeSpaceId) ??
    placement.activeIn[0] ??
    placement.inactiveIn[0] ??
    placement.offeredIn[0] ??
    current ??
    undefined
  );
}

/** The input fields an agent asks for, by the title a launch form shows. */
function inputNames(detail: AgentDetail): string[] {
  const schema = detail.input?.schema as
    { properties?: Record<string, { title?: string }> } | undefined;
  const properties = schema?.properties ?? {};
  const order = detail.input?.property_order ?? Object.keys(properties);
  return order.map((key) => properties[key]?.title ?? key);
}

/**
 * One fact about the package: its icon and label on the left, its value on the
 * right, the way a page of properties reads. The same row serves what the
 * package USES and what it IS, so the sheet speaks one vocabulary below the
 * title.
 */
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
    // One line, always: every row is the same height, so the list reads as a
    // block rather than a ragged column. A long value is truncated with its
    // full text in `title`, and the rule that explains it sits at the END of
    // the same line rather than under it.
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
  grantOf,
  mayConfigureIn,
  integrations,
  agents,
  protocol,
  actionsMenu,
  busy,
  onSetActive,
}: {
  item: LibraryPackageItem;
  type: PackageType;
  spaces: LibrarySpace[];
  /** The row's placement, as the catalogue's own table reads it. */
  placement: CataloguePlacement;
  /** The reader's verdict for switching it on (`next: true`) or off in a space. */
  grantOf: (spaceId: string, next: boolean) => boolean;
  /**
   * The reader's verdict for changing how a space runs a placed package (the
   * placement PATCH's `configure` gate), which is what imposing a skill on that
   * space's chat asks. No personal-space exemption, unlike activation.
   */
  mayConfigureIn: (spaceId: string) => boolean;
  /** The library's integrations: what an agent's switch-on would still need. */
  integrations: LibraryPackageItem[];
  /** The library's agents: which dependents of this package the reader may be told about. */
  agents: LibraryPackageItem[];
  /** An integration's protocol, when the catalogue knows it. */
  protocol?: string;
  /** The package's Actions menu, built by the catalogue that owns its dialogs. */
  actionsMenu?: ReactNode;
  busy: boolean;
  /** Goes through the catalogue's own activation, which asks about integrations first. */
  onSetActive: (spaceId: string, next: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { currentOrg } = useOrg();
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const from = readingSpace(placement, spaces, currentSpaceId);
  const { data: detail } = useQuery({
    queryKey: packageKeys.detail(
      PACKAGE_TYPE_ROUTE_SEGMENT[type],
      orgId,
      from ?? null,
      item.id,
      null,
    ),
    queryFn: () => fetchPackageDetail(type, item.id, undefined, from),
    enabled: !!orgId && !!from,
    // The sheet reads without the detail; a refusal is not worth a retry.
    retry: false,
  });
  const agent = type === "agent" ? (detail as AgentDetail | undefined) : undefined;
  const other = type !== "agent" ? (detail as OrgPackageItemDetail | undefined) : undefined;

  const rows = sheetSpaceRows(placement, spaces, grantOf);
  /** The reader's own space, when the sheet lists it: the title's switch. */
  const hereRow = rows.find((row) => row.id === currentSpaceId);
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
  const version = detail?.version;
  // Spelled out, so the locale test sees every key it declares used.
  const typeLabel: Record<PackageType, string> = {
    agent: t("catalogue.sheet.type.agent"),
    skill: t("catalogue.sheet.type.skill"),
    integration: t("catalogue.sheet.type.integration"),
    "mcp-server": t("catalogue.sheet.type.mcp-server"),
  };
  const updatedAt = agent?.updatedAt ?? other?.updatedAt;

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
      title={row.mayToggle ? undefined : t("library.cannotActivate", { ns: "common" })}
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
    toast.error(key ? t(key, { ns: "common" }) : getErrorMessage(err));
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
          // Imposing discloses the content to every member who chats there:
          // it is confirmed first. Releasing discloses nothing.
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

  // The column exists only when a space is actually missing something: a
  // column of dashes asks the reader what it would have meant.
  const missingAnywhere = rows.some((row) => missingIn(row.id).length > 0);
  /**
   * The agents that use this package — narrowed to the ones this reader's OWN
   * library carries. `getOrgItem` counts dependents across the organization
   * (`findDependentPackages`, no placement predicate), so naming them all
   * would publish agents homed in spaces this reader cannot enter.
   */
  const usedBy = (other?.agents ?? []).filter((entry) => agents.some((row) => row.id === entry.id));
  const agentSkills = agent?.dependencies.skills ?? [];
  const agentInputs = agent ? inputNames(agent) : [];
  const runtimeTools = Array.isArray(agent?.manifest?.runtime_tools)
    ? (agent.manifest.runtime_tools as unknown[]).length
    : 0;

  return (
    <div>
      {/* The one line that asks the reader for a decision, at the TOP like
          every other alert in the product: above the first block rather than
          beside the table, since its button names the space it acts on. It
          goes through the catalogue's own activation, which asks about the
          agent's integrations before writing. */}
      {offers.map((offer) => (
        <Alert key={offer.id} variant="info" className="mb-5">
          <Inbox className="h-4 w-4" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <AlertTitle className="mb-0">
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

      {/* The title's line carries what acts on the package: the switch for
          the space the reader is in — the deed a Découvrir card offers, in one
          click — and the one Actions menu, the same items as the matrix row's
          "…" (`CatalogueMenuItems`), opening with the package's own page. */}
      <div className="flex items-start justify-between gap-4">
        <SettingsHeading className="mb-2" title={item.name || item.id} />
        <div className="flex shrink-0 items-center gap-3">
          {hereRow && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("catalogue.activeHere")}</span>
              {switchFor(hereRow)}
            </label>
          )}
          {actionsMenu}
        </div>
      </div>
      {/* What the package IS, in the badges the package's own header uses. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{typeLabel[type]}</Badge>
        {version && (
          <Badge variant="secondary" className="font-mono">
            v{version}
          </Badge>
        )}
        <Badge variant="secondary" className="gap-1.5">
          {item.source === "system" && <ShieldCheck className="size-3" aria-hidden />}
          {provenance}
        </Badge>
      </div>

      {item.description && <p className="mt-4 text-sm">{item.description}</p>}
      {/* The package's properties, in blocks each under a heading of its own —
          the same heading "Espaces" carries below. A gap alone had to carry the
          split and read as an accident of spacing instead. A list rather than
          cards: these are not a content of their own, and a frame around a
          property list draws a border that answers to nothing.
          "À propos" comes FIRST, and in the same order, because every type
          answers it: a reader moving from an agent to a skill to an integration
          finds the same facts in the same place. What varies by type follows. */}
      <SettingsGroup title={t("catalogue.sheet.about")} className="mt-6 mb-6">
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
            // Where the package lives, which is where it is edited (#1437).
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
          {/* What the agent ASKS at launch, and what the runtime gives it:
              neither is a dependency — they are facts about the package, so
              they sit here, after the rows every type carries. */}
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
        </dl>
      </SettingsGroup>

      {/* The manifest's own word, and only what it covers: an integration or a
          skill the agent declares. */}
      {agent && (
        <SettingsGroup title={t("catalogue.sheet.dependencies")} className="mb-6">
          <dl className="divide-border divide-y border-t">
            <PropertyRow
              icon={Boxes}
              label={t("catalogue.sheet.integrations")}
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
                label={t("catalogue.sheet.skills")}
                hint={t("catalogue.sheet.skillsHint")}
              >
                {/* Named, never linked: a skill not shared to the reader's
                    space opens on a 404, and it needs nothing there anyway. */}
                {agentSkills.map((skill) => skill.name ?? skill.id).join(", ")}
              </PropertyRow>
            )}
          </dl>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("catalogue.sheet.spaces")} className="mt-8 mb-0">
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
          // Its own line under the space's, the same shape: the space line
          // says whether it runs there, this one whether its chat imposes it.
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
                  <TableHead>{t("catalogue.filter.space")}</TableHead>
                  <TableHead>{t("catalogue.filter.state")}</TableHead>
                  {/* Only an agent has a dependency another space must hold. */}
                  {missingAnywhere && <TableHead>{t("catalogue.sheet.missingColumn")}</TableHead>}
                  <TableHead className="w-20 text-right">{t("catalogue.filter.active")}</TableHead>
                  {enforceable && (
                    <TableHead className="w-32 text-right">
                      {t("library.column.chatEnforced", { ns: "common" })}
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  // The alert above names a space; this is that space. Same
                  // tint as the alert, so the eye carries one to the other.
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
