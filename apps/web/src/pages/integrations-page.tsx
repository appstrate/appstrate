// SPDX-License-Identifier: Apache-2.0

/**
 * The integration INDEX: what this space can actually use.
 *
 * Like every other index it renders the ACTIVE set — placed in this space and
 * switched on — because that is the set an agent may declare and a run may
 * resolve. It carries no second, wider tab: a full catalogue view would be a
 * duplicate of the space library (`/space/packages`), which is where a package
 * placed here but switched off, or merely offered, is taken up or switched back
 * on (RBAC spec §6.8). One question per page, one answer per question.
 *
 *   - Search: by name, package id, description, manifest keywords.
 *   - Per-card: the whole tile is the link into the detail page. Activation,
 *     per-auth connect, OAuth client registration and governance all live on
 *     `<IntegrationDetailPage />`.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Boxes, Plus, Search } from "lucide-react";
import { Input } from "@appstrate/ui/components/input";
import { Button } from "@appstrate/ui/components/button";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { usePackageList } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import { IntegrationIcon } from "../components/integration-icon";
import type { OrgPackageItem } from "@appstrate/shared-types";

function matchesQuery(integration: OrgPackageItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    integration.id.toLowerCase().includes(q) ||
    integration.name.toLowerCase().includes(q) ||
    (integration.description?.toLowerCase().includes(q) ?? false) ||
    integration.keywords.some((k) => k.toLowerCase().includes(q))
  );
}

function IntegrationCard({ integration }: { integration: OrgPackageItem }) {
  return (
    <Link
      to={`/integrations/${integration.id}`}
      data-testid="integration-card"
      data-integration-id={integration.id}
      className="bg-card hover:border-primary/40 flex flex-col rounded-lg border p-4 transition-colors hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <IntegrationIcon src={integration.icon ?? undefined} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{integration.name}</h3>
          <p className="text-muted-foreground truncate font-mono text-xs">{integration.id}</p>
        </div>
      </div>
      {integration.description && (
        <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">{integration.description}</p>
      )}
    </Link>
  );
}

export function IntegrationsPage() {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const [query, setQuery] = useState("");
  // The index route, the same one the three other type pages ask: the server
  // answers the active set of this space and paginates it. `GET /api/integrations`
  // is the other question — every placement here, active or not, with the
  // per-space administration flags the detail page needs — and it stays where
  // that question is asked.
  const { data: integrations, isLoading, error } = usePackageList("integration");

  const filtered = useMemo(
    () => (integrations ?? []).filter((i) => matchesQuery(i, query)),
    [integrations, query],
  );

  return (
    <div className="p-6">
      <PageHeader
        emoji="🧩"
        title={t("integrations.title")}
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("integrations.title") },
        ]}
        actions={
          can("integrations:write") ? (
            <Link to="/integrations/new">
              <Button>
                <Plus size={14} />
                {t("integrations.create")}
              </Button>
            </Link>
          ) : undefined
        }
      >
        <p className="text-muted-foreground mt-1 text-sm">{t("integrations.subtitle")}</p>
      </PageHeader>

      <div className="mb-4 flex items-center gap-3">
        <div className="relative max-w-md flex-1">
          <Search
            size={14}
            className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("integrations.search.placeholder")}
            className="pl-9"
            data-testid="integrations-search"
          />
        </div>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={String(error)} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Boxes}
          message={t("integrations.empty")}
          hint={<SpaceLibraryHint type="integration" />}
        />
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="integration-grid"
        >
          {filtered.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      )}
    </div>
  );
}
