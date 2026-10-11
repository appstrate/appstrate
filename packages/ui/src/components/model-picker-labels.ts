// SPDX-License-Identifier: Apache-2.0

import type { PickerReasonKind } from "./model-picker-groups.ts";
import type { ModelPickerLabels } from "./model-picker.tsx";

/**
 * Wire every label of the model picker from one i18n key family, so the dashboard's pickers and
 * the chat's cannot drift apart (same pattern as `buildGenerationLabels`). `t` is bound to a
 * namespace that resolves `modelPicker.*` (`settings`, a boot namespace).
 */
export function buildModelPickerLabels(
  t: (key: string, options?: Record<string, string>) => string,
): ModelPickerLabels {
  const reasons: Record<PickerReasonKind, string> = {
    disabled: t("modelPicker.reason.disabled"),
    orgUnavailable: t("modelPicker.reason.orgUnavailable"),
    personalRequired: t("modelPicker.reason.personalRequired"),
    personalReconnect: t("modelPicker.reason.personalReconnect"),
    personalOff: t("modelPicker.reason.personalOff"),
    notSchedulable: t("modelPicker.reason.notSchedulable"),
  };
  return {
    kinds: {
      org: t("modelPicker.kind.org"),
      personalKey: t("modelPicker.kind.personalKey"),
      personalSubscription: t("modelPicker.kind.personalSubscription"),
      system: t("modelPicker.kind.system"),
    },
    reasons,
    isDefault: t("modelPicker.default"),
    search: t("modelPicker.search"),
    empty: t("modelPicker.empty"),
    placeholder: t("modelPicker.placeholder"),
    gone: t("modelPicker.gone"),
    fix: (fix, service) => {
      if (fix === "add") {
        return service ? t("modelPicker.addKey", { service }) : t("modelPicker.addKeyAny");
      }
      return service
        ? t("modelPicker.reconnectKey", { service })
        : t("modelPicker.reconnectKeyAny");
    },
  };
}
