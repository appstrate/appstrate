// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ModelPicker } from "@appstrate/ui/components/model-picker";
import { buildModelPickerLabels } from "@appstrate/ui/components/model-picker-labels";
import { groupModelsForPicker } from "@appstrate/ui/components/model-picker-groups";
import {
  useModelProviderCredentials,
  useProvidersRegistry,
} from "../hooks/use-model-provider-credentials";
import { useOrgSettings } from "../hooks/use-org-settings";
import { usePermissions } from "../hooks/use-permissions";
import type { OrgModelInfo } from "../hooks/use-models";
import { pickerCredentials } from "../lib/model-picker";
import { authStore } from "../stores/auth-store";
import { getModelIcon } from "./icons";

/**
 * The one model picker of the dashboard (an agent's Modèle section, a schedule's Exécution, a
 * run with options): the models the person can use, grouped by who pays, the ones they cannot
 * greyed with the reason and, when it is theirs to fix, a link to Mes fournisseurs. The chat's
 * composer draws the same list from the same `@appstrate/ui` pieces.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  inherit,
  scheduled,
  disabled,
}: {
  models: readonly OrgModelInfo[];
  /** The picked model id; `null` is the inherit row. */
  value: string | null;
  onChange: (modelId: string | null) => void;
  /** The first row, which clears the choice and names what applies then. */
  inherit?: { label: string; modelId: string | null };
  /** A schedule runs alone: a personal key or subscription cannot serve it. */
  scheduled?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const userId = useStore(authStore, (s) => s.user?.id);
  const { data: credentials } = useModelProviderCredentials();
  const { data: registry } = useProvidersRegistry();
  const { data: orgSettings } = useOrgSettings();
  const groups = useMemo(
    () =>
      groupModelsForPicker(models, {
        credentials: pickerCredentials(credentials ?? [], registry ?? [], userId),
        personalAllowed: orgSettings?.personal_model_credentials,
        canConnect: can("model-provider-credentials:connect"),
        scheduled,
      }),
    [
      models,
      credentials,
      registry,
      userId,
      orgSettings?.personal_model_credentials,
      can,
      scheduled,
    ],
  );
  return (
    <ModelPicker
      disabled={disabled}
      groups={groups}
      value={value}
      onSelect={onChange}
      inherit={inherit}
      labels={buildModelPickerLabels(t)}
      renderIcon={(model) => {
        const full = models.find((candidate) => candidate.id === model.id);
        const Icon = full && getModelIcon(full, registry ?? []);
        return Icon ? <Icon className="size-3.5 shrink-0" /> : null;
      }}
      fixLink={(label) => (
        <Link to="/preferences/models" className="underline underline-offset-2">
          {label}
        </Link>
      )}
    />
  );
}
