import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OnboardingLayout, useOnboardingGuard } from "../../components/onboarding-layout";
import { ModelFormModal } from "../../components/model-form-modal";
import { useModels, useCreateModel, useSetDefaultModel } from "../../hooks/use-models";
import { findProviderByApiAndBaseUrl } from "../../lib/model-presets";
import { PROVIDER_ICONS } from "../../components/icons";
import { BrainCircuit } from "lucide-react";
import { EmptyState } from "../../components/page-states";

export function OnboardingModelStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();

  const [modalOpen, setModalOpen] = useState(false);
  const { data: models } = useModels();
  const createModel = useCreateModel();
  const setDefaultModel = useSetDefaultModel();

  const goNext = () => navigate("/onboarding/providers");

  if (!orgId) return null;

  const hasModels = models && models.length > 0;

  return (
    <OnboardingLayout
      step="model"
      title={t("onboarding.modelTitle")}
      subtitle={t("onboarding.modelSubtitle")}
      onNext={goNext}
      onSkip={goNext}
      showSkip
      nextDisabled={!hasModels}
    >
      {hasModels ? (
        <div className="flex flex-col gap-3">
          {models.map((m) => {
            const provider = findProviderByApiAndBaseUrl(m.api, m.baseUrl);
            const ProviderIcon = provider ? PROVIDER_ICONS[provider.id] : undefined;
            return (
              <div key={m.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-3">
                  {ProviderIcon && <ProviderIcon className="size-5" />}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold truncate">{m.label}</h3>
                    <span className="text-sm text-muted-foreground">{m.modelId}</span>
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
        isPending={createModel.isPending}
        onSubmit={(data) => {
          createModel.mutate(data, {
            onSuccess: (result) => {
              setDefaultModel.mutate(result.id);
              setModalOpen(false);
            },
          });
        }}
      />
    </OnboardingLayout>
  );
}
