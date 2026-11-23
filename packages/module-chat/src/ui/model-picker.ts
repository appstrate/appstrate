// SPDX-License-Identifier: Apache-2.0

/**
 * What the model picker shows, shared: the desktop's pill (`ModelSelect`) takes it as props, the
 * phone's "+" panel reads it from {@link ModelPickerProvider} and shows the same list.
 */

import { createContext, useContext } from "react";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { OrgModelOption } from "./models-data.ts";

export interface ModelPickerProps {
  models: OrgModelOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  generation: ModelGenerationSettings;
  onGenerationChange: (value: ModelGenerationSettings) => void;
  /** The catalog is being read: the pill's box is reserved. */
  pending?: boolean;
  /** The catalog could not be read: the pill says so, disabled. */
  failed?: boolean;
}

const ModelPickerContext = createContext<ModelPickerProps | null>(null);
export const ModelPickerProvider = ModelPickerContext.Provider;
export const useModelPicker = () => useContext(ModelPickerContext);

/** The model of `selectedId`, if the catalog lists it. */
export function selectedModel(models: readonly OrgModelOption[], selectedId: string | null) {
  return models.find((m) => m.id === selectedId);
}
