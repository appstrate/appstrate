// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";

/**
 * The connection variables (AFPS §7.12) a connection was made with — what tells
 * two connections of a self-hosted integration apart (e.g. the instance URL).
 * One compact line under the connection's label: the values, in declaration
 * order; the names ride in the tooltip. Renders nothing for an integration
 * that declares none (`null`).
 */
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
