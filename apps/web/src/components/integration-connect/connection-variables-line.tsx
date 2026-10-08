// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";

/** A connection's variables (e.g. its instance URL): what tells two connections apart. */
export function ConnectionVariablesLine({
  variables,
  testId,
}: {
  variables: Readonly<Record<string, string>> | null | undefined;
  testId?: string;
}) {
  const { t } = useTranslation("settings");
  const entries = Object.entries(variables ?? {});
  if (entries.length === 0) return null;
  return (
    <span
      className="text-muted-foreground block truncate font-mono text-[0.65rem]"
      title={entries.map(([name, value]) => `${name}: ${value}`).join("\n")}
      data-testid={testId}
    >
      <span className="sr-only">{t("integration.connection.variables")} </span>
      {entries.map(([, value]) => value).join(" · ")}
    </span>
  );
}
