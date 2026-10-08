// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";
import type { components } from "../api/schema";
import { integrationIdOfField } from "./connection-choice";

/** One `warnings[]` item of a launch or schedule write: an integration the run starts without. */
export type LaunchWarning = components["schemas"]["LaunchWarnings"]["warnings"][number];

/** A run starts now; a schedule's fires will. */
export type LaunchKind = "run" | "schedule";

/** The one toast a launch's warnings make, or `null` when there is nothing to say. */
export function launchWarningsToast(input: {
  kind: LaunchKind;
  warnings: readonly LaunchWarning[] | undefined;
  /** Display name of an integration package id. */
  nameOf: (integrationId: string) => string;
}): { message: string; description: string } | null {
  const ids = [
    ...new Set(
      (input.warnings ?? [])
        .filter((w) => w.field.startsWith("integrations."))
        .map((w) => integrationIdOfField(w.field)),
    ),
  ];
  if (ids.length === 0) return null;
  const names = ids.map(input.nameOf).join(", ");
  return {
    message: i18n.t(input.kind === "run" ? "launchWarnings.run" : "launchWarnings.schedule", {
      ns: "agents",
      count: ids.length,
      names,
    }),
    description: i18n.t("launchWarnings.description", { ns: "agents", count: ids.length }),
  };
}
