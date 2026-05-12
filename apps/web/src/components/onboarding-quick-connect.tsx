// SPDX-License-Identifier: Apache-2.0

/**
 * Onboarding-only quick-connect cards for OAuth model providers.
 * One click opens the pairing dialog; on success the helper seeds the
 * org's `org_models` with the registry's recommended models so the user
 * can hit "Continue" without touching the manual form.
 *
 * The list is module-driven: every OAuth provider the platform loaded
 * (`useProvidersRegistry()` filtered by `authMode === "oauth2"`) gets a
 * card here. Hiding a card means removing its module from `MODULES` —
 * core has no per-providerId allowlist.
 *
 * The seeding behavior is intentionally bound to this caller — the generic
 * `OAuthModelProviderDialog` stays neutral so OAuth connections triggered
 * from `ModelFormModal` (where the user explicitly picks one model) do not
 * accidentally create extra rows.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Plug } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { OAuthModelProviderDialog } from "./oauth-model-provider-dialog";
import { PROVIDER_ICONS } from "./icons";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
  type ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { useAutoSeedRecommendedModels } from "../hooks/use-auto-seed-models";

interface CardProps {
  entry: ProviderRegistryEntry;
  alreadyConnected: boolean;
}

function QuickConnectCard({ entry, alreadyConnected }: CardProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { seed } = useAutoSeedRecommendedModels();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [working, setWorking] = useState(false);

  // `iconUrl` is the canonical PROVIDER_ICONS key surfaced by the registry
  // (the value points at a brand glyph slug, not at the provider id).
  // Falls back to a generic plug glyph for providers without a registered
  // brand icon.
  const Icon = entry.iconUrl ? (PROVIDER_ICONS[entry.iconUrl] ?? null) : null;

  const openDialog = () => {
    if (alreadyConnected || working) return;
    setDialogOpen(true);
  };

  const handleConnected = async (newId: string) => {
    setWorking(true);
    try {
      const { created, promotedDefault } = await seed(newId, entry.providerId);
      if (created > 0) {
        toast.success(
          t("onboarding.modelSeed.success", {
            count: created,
            provider: entry.displayName,
          }),
        );
        if (promotedDefault) {
          toast.success(t("onboarding.modelSeed.defaultPromoted"));
        }
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={working || alreadyConnected}
        className={cn(
          "border-border bg-card group flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors",
          alreadyConnected
            ? "cursor-default opacity-70"
            : "hover:border-primary/40 hover:bg-accent/40 cursor-pointer",
          working && "cursor-wait opacity-70",
        )}
      >
        <div
          className={cn(
            "bg-muted flex size-10 shrink-0 items-center justify-center rounded-md",
            alreadyConnected && "bg-success/15",
          )}
        >
          {Icon ? <Icon className="size-5" /> : <Plug className="text-muted-foreground size-5" />}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className="truncate">{entry.displayName}</span>
            {alreadyConnected && <Check className="text-success size-3.5 shrink-0" aria-hidden />}
          </span>
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {alreadyConnected
              ? t("onboarding.modelSeed.alreadyConnectedHint")
              : (entry.description ?? t("onboarding.modelSeed.connectHint"))}
          </span>
        </div>

        <div className="shrink-0">
          {working ? (
            <Spinner className="size-4" />
          ) : alreadyConnected ? null : (
            <ChevronRight className="text-muted-foreground group-hover:text-foreground size-4 transition-colors" />
          )}
        </div>
      </button>

      {dialogOpen && (
        <OAuthModelProviderDialog
          open
          providerId={entry.providerId}
          onClose={() => setDialogOpen(false)}
          onConnected={(newId) => {
            void handleConnected(newId);
          }}
        />
      )}
    </>
  );
}

export function OnboardingQuickConnect() {
  const registryQuery = useProvidersRegistry();
  const credentialsQuery = useModelProviderCredentials();

  const entries = (registryQuery.data ?? []).filter((p) => p.authMode === "oauth2");

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => {
        const alreadyConnected =
          credentialsQuery.data?.some(
            (k) =>
              k.authMode === "oauth2" && k.providerId === entry.providerId && !k.needsReconnection,
          ) ?? false;
        return (
          <QuickConnectCard
            key={entry.providerId}
            entry={entry}
            alreadyConnected={alreadyConnected}
          />
        );
      })}
    </div>
  );
}
