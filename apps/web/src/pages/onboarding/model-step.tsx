// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { ModelFormModal } from "../../components/model-form-modal";
import { OnboardingQuickConnect } from "../../components/onboarding-quick-connect";
import { useModels, useModelFormHandler } from "../../hooks/use-models";
import { useProvidersRegistry } from "../../hooks/use-model-provider-credentials";
import { findProviderByApiShapeAndBaseUrl } from "../../lib/model-presets";
import { PROVIDER_ICONS } from "../../components/icons";
import type { OrgModelInfo } from "@appstrate/shared-types";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";

/**
 * Resolve a model's provider icon. The static `model-presets.ts` catalog
 * covers most api-key providers (anthropic, openai, mistral, …) but not the
 * registry-only OAuth ones (codex → openai icon, claude-code → anthropic
 * icon). We try the static catalog first, then fall back to the runtime
 * registry's `iconUrl` hint.
 */
function resolveProviderIcon(model: OrgModelInfo, registry: ProviderRegistryEntry[] | undefined) {
  const staticMatch = findProviderByApiShapeAndBaseUrl(model.apiShape, model.baseUrl);
  if (staticMatch) return PROVIDER_ICONS[staticMatch.id];
  const norm = (s: string) => s.replace(/\/+$/, "");
  const registryMatch = registry?.find(
    (p) => p.apiShape === model.apiShape && norm(p.defaultBaseUrl) === norm(model.baseUrl),
  );
  if (registryMatch?.iconUrl) return PROVIDER_ICONS[registryMatch.iconUrl];
  return undefined;
}

export function OnboardingModelStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { nextRoute } = useOnboardingNav("model");

  const [modalOpen, setModalOpen] = useState(false);
  const { data: models } = useModels();
  const { data: registry } = useProvidersRegistry();
  const { onSubmit, isPending } = useModelFormHandler({
    onSuccess: () => setModalOpen(false),
  });

  const goNext = () => nextRoute && navigate(nextRoute);

  if (!orgId) return null;

  const hasModels = models && models.length > 0;

  return (
    <OnboardingLayout
      step="model"
      title={t("onboarding.modelTitle")}
      subtitle={t("onboarding.modelSubtitle")}
      onNext={goNext}
    >
      <div className="flex flex-col gap-5">
        {/* Primary path — OAuth subscription quick-connect. Single-click
            seeds the recommended models from the registry. */}
        <OnboardingQuickConnect />

        {/* Configured models, if any. The seeded rows land here once the
            quick-connect completes — gives the user a visible confirmation
            of what got created. */}
        {hasModels && (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("onboarding.modelSeed.configuredHeader")}
            </div>
            <div className="flex flex-col gap-1.5">
              {models.map((m) => {
                const ProviderIcon = resolveProviderIcon(m, registry);
                return (
                  <div
                    key={m.id}
                    className="border-border bg-card flex items-center gap-3 rounded-md border px-3 py-2"
                  >
                    {ProviderIcon ? (
                      <ProviderIcon className="size-4 shrink-0" />
                    ) : (
                      <div className="bg-muted size-4 shrink-0 rounded" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.label}</div>
                      <div className="text-muted-foreground truncate text-xs">{m.modelId}</div>
                    </div>
                    {m.isDefault && (
                      <Badge variant="success" className="shrink-0 text-[0.65rem]">
                        {t("models.default")}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* "Or add manually" — separator + secondary CTA. Always visible,
            but downplayed: the dashed border + ghost button signal it as
            the fallback path. */}
        <div className="relative my-1">
          <div className="border-border absolute inset-0 flex items-center">
            <div className="w-full border-t border-dashed" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background text-muted-foreground px-2 text-xs">
              {t("onboarding.modelSeed.manualSeparator")}
            </span>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="self-center"
          onClick={() => setModalOpen(true)}
        >
          <Plus className="mr-1.5 size-3.5" />
          {hasModels ? t("onboarding.modelSeed.addAnother") : t("models.add")}
        </Button>
      </div>

      <ModelFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        model={null}
        isPending={isPending}
        onSubmit={onSubmit}
      />
    </OnboardingLayout>
  );
}
