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
 * Runs, versions, files and settings stay on the package's own page, one link
 * away.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Boxes,
  Clock,
  ExternalLink,
  Hammer,
  Hash,
  House,
  Inbox,
  Info,
  Layers,
  Plug,
  Puzzle,
  ShieldCheck,
  TextCursorInput,
  Wrench,
} from "lucide-react";
import { Link } from "react-router-dom";
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
import type { LibraryPackageItem, LibrarySpace } from "../hooks/use-library";
import { fetchPackageDetail, PACKAGE_CONFIG } from "../hooks/use-packages";
import { useCurrentOrgId, useOrg } from "../hooks/use-org";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { missingIntegrations } from "../lib/activation-closure";
import type { CataloguePlacement } from "../lib/catalogue-placement";
import {
  sheetOffers,
  sheetSpaceMode,
  sheetSpaceRows,
  type SheetSpaceRow,
} from "../lib/catalogue-sheet";
import { formatDateField } from "../lib/format-date";
import { packageDetailPath } from "../lib/package-paths";
import { packageKeys } from "../lib/query-keys";
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
  if (placement.everywhere || placement.here) return current ?? undefined;
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
    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-4">
      <dt className="text-muted-foreground flex w-32 shrink-0 items-center gap-2 text-sm">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 text-sm">
        {children}
        {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
      </dd>
    </div>
  );
}

/**
 * A card with a grey head, as the agent's own overview draws one: the facts a
 * reader CONSULTS sit in cards, and what they ACT on (the spaces table) stays
 * in the page below them.
 */
function SheetCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof House;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-muted/35 overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 px-4 py-3">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="bg-card rounded-t-lg border-t px-4 py-2">{children}</div>
    </section>
  );
}

export function CataloguePreview({
  item,
  type,
  spaces,
  placement,
  grantOf,
  integrations,
  protocol,
  busy,
  onSetActive,
  onBack,
}: {
  item: LibraryPackageItem;
  type: PackageType;
  spaces: LibrarySpace[];
  /** The row's placement, as the catalogue's own table reads it. */
  placement: CataloguePlacement;
  /** The reader's verdict for switching it on (`next: true`) or off in a space. */
  grantOf: (spaceId: string, next: boolean) => boolean;
  /** The library's integrations: what an agent's switch-on would still need. */
  integrations: LibraryPackageItem[];
  /** An integration's protocol, when the catalogue knows it. */
  protocol?: string;
  busy: boolean;
  /** Goes through the catalogue's own activation, which asks about integrations first. */
  onSetActive: (spaceId: string, next: boolean) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { currentOrg } = useOrg();
  const orgId = useCurrentOrgId();
  const currentSpaceId = useCurrentSpaceId();
  const from = readingSpace(placement, spaces, currentSpaceId);
  const { data: detail } = useQuery({
    queryKey: packageKeys.detail(PACKAGE_CONFIG[type].path, orgId, from ?? null, item.id, null),
    queryFn: () => fetchPackageDetail(type, item.id, undefined, from),
    enabled: !!orgId && !!from,
    // The sheet reads without the detail; a refusal is not worth a retry.
    retry: false,
  });
  const agent = type === "agent" ? (detail as AgentDetail | undefined) : undefined;
  const other = type !== "agent" ? (detail as OrgPackageItemDetail | undefined) : undefined;

  const rows = sheetSpaceRows(placement, spaces, grantOf);
  const mode = sheetSpaceMode(placement, rows);
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
  const missingText = (spaceId: string) => {
    const names = missingIn(spaceId);
    return names.length > 0 ? t("catalogue.sheet.missing", { names: names.join(", ") }) : null;
  };

  // The column exists only when a space is actually missing something: a
  // column of dashes asks the reader what it would have meant.
  const missingAnywhere = rows.some((row) => missingIn(row.id).length > 0);
  const usedBy = other?.agents ?? [];
  const agentSkills = agent?.dependencies.skills ?? [];
  const agentInputs = agent ? inputNames(agent) : [];
  const runtimeTools = Array.isArray(agent?.manifest?.runtime_tools)
    ? (agent.manifest.runtime_tools as unknown[]).length
    : 0;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="-ml-2 gap-1.5" onClick={onBack}>
          <ArrowLeft />
          {t("catalogue.back")}
        </Button>
        {/* An action, in the shape every other action has: leaving for the
            package's own page is one, and a discreet link read as decoration. */}
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link to={packageDetailPath(type, item.id)}>
            <ExternalLink className="size-3.5" />
            {t("catalogue.openFullPage")}
          </Link>
        </Button>
      </div>

      <SettingsHeading className="mb-2" title={item.name || item.id} />
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

      {/* The one line that asks the reader for a decision: an alert, like
          every other line in the product that names a state and its remedy.
          It acts on THAT space alone, through the catalogue's own activation,
          which asks about the agent's integrations before writing. */}
      {offers.map((offer) => (
        <Alert key={offer.id} className="mt-5">
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

      <div className="mt-6 grid items-start gap-4 md:grid-cols-2">
        {agent && (
          <SheetCard icon={Puzzle} title={t("catalogue.sheet.uses")}>
            <dl className="divide-border divide-y">
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
          </SheetCard>
        )}

        <SheetCard icon={Info} title={t("catalogue.sheet.details")}>
          <dl className="divide-border divide-y">
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
          </dl>
        </SheetCard>
      </div>

      <SettingsGroup title={t("catalogue.sheet.spaces")} className="mt-8 mb-0">
        {mode === "everywhere" && <p className="text-sm">{t("catalogue.sheet.everywhere")}</p>}
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
        {mode === "single" && rows[0] && (
          <div className="border-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">{stateLabel(row)}</TableCell>
                    {missingAnywhere && (
                      <TableCell className="text-muted-foreground">
                        {missingIn(row.id).join(", ") || "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right">{switchFor(row)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
