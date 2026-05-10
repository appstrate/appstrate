// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { ModelFormModal } from "../../components/model-form-modal";
import { useModels, useModelFormHandler } from "../../hooks/use-models";
import { findProviderByApiShapeAndBaseUrl } from "../../lib/model-presets";
import { PROVIDER_ICONS } from "../../components/icons";
import { BrainCircuit } from "lucide-react";
import { EmptyState } from "../../components/page-states";

export function OnboardingModelStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { nextRoute } = useOnboardingNav("model");

  const [modalOpen, setModalOpen] = useState(false);
  const { data: models } = useModels();
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
      {hasModels ? (
        <div className="flex flex-col gap-3">
          {models.map((m) => {
            const provider = findProviderByApiShapeAndBaseUrl(m.apiShape, m.baseUrl);
            const ProviderIcon = provider ? PROVIDER_ICONS[provider.id] : undefined;
            return (
              <div key={m.id} className="border-border bg-card rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  {ProviderIcon && <ProviderIcon className="size-5" />}
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold">{m.label}</h3>
                    <span className="text-muted-foreground text-sm">{m.modelId}</span>
                  </div>
                  {m.isDefault && <Badge variant="success">{t("models.default")}</Badge>}
                </div>
              </div>
            );
          })}
          <Button variant="outline" onClick={() => setModalOpen(true)}>
            {t("models.add")}
          </Button>
        </div>
      ) : (
        <EmptyState message={t("models.empty")} icon={BrainCircuit} compact>
          <Button onClick={() => setModalOpen(true)}>{t("models.add")}</Button>
        </EmptyState>
      )}

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
